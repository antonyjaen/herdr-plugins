// Shared helpers: resolve the project directory from herdr's invocation
// context, run CLI commands, open URLs, and drive a tiny numbered menu.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const isWin = process.platform === "win32";
const herdr = process.env.HERDR_BIN_PATH || "herdr";

function context() {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  } catch {
    return {};
  }
}

// The directory the user is working in: explicit override from the opener
// action, then the focused pane, then the workspace root.
function targetCwd() {
  const ctx = context();
  return process.env.HERDR_TARGET_CWD || ctx.focused_pane_cwd || ctx.workspace_cwd || process.cwd();
}

// Walk up from `start` until `marker` exists; null when not found.
function findUp(start, marker) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, marker))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Commands come from fixed argv lists, never raw user text, so quoting simple
// tokens is enough. Windows npm shims (.cmd/.ps1) need a shell to resolve.
function quote(arg) {
  return /^[\w.\-\\/:=@]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

function run(cmd, args, cwd) {
  console.log(`\n$ ${[cmd, ...args].join(" ")}   (in ${cwd})\n`);
  const res = isWin
    ? spawnSync([cmd, ...args].map(quote).join(" "), { cwd, stdio: "inherit", shell: true })
    : spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (res.error) console.error(`failed to start ${cmd}: ${res.error.message}`);
  return res.status ?? 1;
}

function openUrl(url) {
  if (!/^https:\/\/[\w.\-/?=&%#:]+$/.test(url)) throw new Error(`refusing to open ${url}`);
  const [cmd, args] = isWin
    ? ["cmd", ["/c", "start", "", url]]
    : [process.platform === "darwin" ? "open" : "xdg-open", [url]];
  spawnSync(cmd, args, { stdio: "ignore" });
}

// Open this plugin's menu pane for the current project (used by actions).
// The project dir travels as env, not --cwd: pane commands resolve their
// script relative to the cwd, which must stay the plugin root.
function openMenuPane(entrypoint = "menu") {
  const cwd = targetCwd();
  const res = spawnSync(
    herdr,
    ["plugin", "pane", "open", "--plugin", process.env.HERDR_PLUGIN_ID, "--entrypoint", entrypoint,
      "--env", `HERDR_TARGET_CWD=${cwd}`, "--focus"],
    { encoding: "utf8" },
  );
  process.stdout.write(res.stdout || "");
  process.stderr.write(res.stderr || "");
  process.exit(res.status ?? 1);
}

// A line-mode question, used while an item runs (raw mode is off then).
function ask(rl, q) {
  return new Promise((resolve) => rl.question(q, resolve));
}


// ── Screens ─────────────────────────────────────────────────────────────────────
// Quiet styling in the herdr theme's tones (Zenwritten): plain rows, one accent,
// no frames or badges, so plugin screens read as part of herdr.
const ESC = "\x1b[";
const fg = ([r, g, b]) => `${ESC}38;2;${r};${g};${b}m`;
const bg = ([r, g, b]) => `${ESC}48;2;${r};${g};${b}m`;
const RESET = `${ESC}0m`, BOLD = `${ESC}1m`;
const TEXT = fg([187, 187, 187]), MUTED = fg([128, 128, 128]), ACCENT = fg([129, 155, 105]), WARN = fg([183, 126, 100]);
const SEL = bg([44, 44, 44]);
const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const pad = (s, n) => s + " ".repeat(Math.max(0, n - visible(s).length));
const cut = (s, n) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s);

// One chunk (fast typing, pasted text) emits several keypresses at once: queue them all.
const keys = [];
let wake = null;
let listening = false;

function readKey() {
  if (keys.length) return Promise.resolve(keys.shift());
  return new Promise((resolve) => (wake = resolve));
}

function startRaw() {
  readline.emitKeypressEvents(process.stdin);
  if (!listening) {
    listening = true;
    process.stdin.on("keypress", (str, key) => {
      keys.push({ ...(key || {}), str });
      if (wake) {
        const w = wake;
        wake = null;
        w(keys.shift());
      }
    });
  }
  keys.length = 0;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
}

function endRaw() {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(`${ESC}?25h${ESC}2J${ESC}H`);
}

function row(selected, text, width) {
  return selected ? `${ACCENT}▎${RESET}${SEL}${TEXT}${pad(text, width)}${RESET}` : ` ${text}`;
}

/**
 * opts: { title, info: () => [[label, value, state?]], items: [{ label, hint, run(rl) }] }
 * state "ok" | "warn" colours the value.
 */
async function menu(opts) {
  const items = opts.items;
  let sel = 0;
  const draw = () => {
    const w = Math.min(Math.max(40, process.stdout.columns || 80) - 2, 96);
    const info = opts.info().map(([label, value, state]) =>
      `${MUTED}${label}${RESET} ${state === "ok" ? ACCENT : state === "warn" ? WARN : TEXT}${cut(value, w - label.length - 2)}${RESET}`);
    const labelW = Math.max(...items.map((i) => i.label.length)) + 3;
    const out = [`${ESC}2J${ESC}H${ESC}?25l`, ` ${BOLD}${TEXT}${opts.title}${RESET}  ${info.join(`${MUTED}  ·  ${RESET}`)}`, ""];
    items.forEach((it, i) =>
      out.push(row(i === sel, `${TEXT}${pad(it.label, labelW)}${MUTED}${cut(it.hint || "", w - labelW - 2)}${RESET}`, w)));
    out.push("", ` ${MUTED}↑↓ select · enter run · q close${RESET}`);
    process.stdout.write(out.join("\n"));
  };

  startRaw();
  for (;;) {
    draw();
    const key = await readKey();
    const name = key.name || key.str;
    if (name === "q" || name === "escape" || (key.ctrl && name === "c")) break;
    if (name === "up" || name === "k") sel = (sel + items.length - 1) % items.length;
    else if (name === "down" || name === "j") sel = (sel + 1) % items.length;
    else if (/^[1-9]$/.test(name || "") && Number(name) <= items.length) sel = Number(name) - 1;
    if (!(name === "return" || name === "enter" || /^[1-9]$/.test(name || ""))) continue;

    const item = items[sel];
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write(`${ESC}2J${ESC}H${ESC}?25h ${BOLD}${TEXT}${opts.title}${RESET} ${MUTED}›${RESET} ${TEXT}${item.label}${RESET}\n`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      await item.run(rl);
    } catch (err) {
      process.stdout.write(`\n ${WARN}${err.message}${RESET}\n`);
    }
    rl.close();
    process.stdout.write(`\n ${MUTED}any key to go back${RESET}`);
    startRaw();
    await readKey();
  }
  endRaw();
  process.exit(0);
}

/**
 * Filterable list: type to filter, ↑↓ to move, enter to choose, esc to close.
 * opts: { title, entries, render: (e) => [mark, name, detail, tag], choose: (e) => void }
 */
async function pick(opts) {
  let query = "", sel = 0;
  const matches = () => {
    const q = query.toLowerCase();
    return opts.entries.filter((e) => opts.render(e).slice(1, 3).join(" ").toLowerCase().includes(q));
  };
  const draw = (list) => {
    const w = Math.min(Math.max(40, process.stdout.columns || 80) - 2, 110);
    const rows = Math.max(3, (process.stdout.rows || 24) - 5);
    const nameW = Math.min(28, Math.max(8, ...opts.entries.map((e) => opts.render(e)[1].length)) + 2);
    const first = Math.max(0, Math.min(sel - rows + 1, list.length - rows));
    const out = [`${ESC}2J${ESC}H${ESC}?25l`, ` ${BOLD}${TEXT}${opts.title}${RESET}  ${ACCENT}›${RESET} ${TEXT}${query}${RESET}${ACCENT}▏${RESET}`, ""];
    list.slice(first, first + rows).forEach((e, i) => {
      const [mark, name, detail, tag] = opts.render(e);
      const text = `${ACCENT}${mark}${RESET} ${TEXT}${pad(cut(name, nameW - 1), nameW)}${MUTED}${cut(detail, w - nameW - 14)}${RESET}`;
      out.push(row(first + i === sel, pad(text, w - 10) + `${MUTED}${tag || ""}${RESET}`, w));
    });
    if (!list.length) out.push(` ${MUTED}no match${RESET}`);
    out.push("", ` ${MUTED}type to filter · ↑↓ select · enter switch · esc close${RESET}`);
    process.stdout.write(out.join("\n"));
  };

  startRaw();
  for (;;) {
    const list = matches();
    sel = Math.min(sel, Math.max(0, list.length - 1));
    draw(list);
    const key = await readKey();
    const name = key.name;
    if (name === "escape" || (key.ctrl && name === "c")) break;
    if (name === "up") sel = Math.max(0, sel - 1);
    else if (name === "down") sel = Math.min(list.length - 1, sel + 1);
    else if (name === "backspace") query = query.slice(0, -1);
    else if (name === "return" || name === "enter") {
      if (list[sel]) {
        endRaw();
        try {
          opts.choose(list[sel]);
        } catch (err) {
          console.error(err.message);
          await new Promise((r) => setTimeout(r, 2500));
        }
        process.exit(0);
      }
    } else if (key.str && key.str.length === 1 && key.str >= " " && !key.ctrl && !key.meta) {
      query += key.str;
      sel = 0;
    }
  }
  endRaw();
  process.exit(0);
}

module.exports = { context, targetCwd, findUp, run, openUrl, openMenuPane, ask, menu, pick };

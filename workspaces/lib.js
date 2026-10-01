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

// ── Menu screen ─────────────────────────────────────────────────────────────────
const ESC = "\x1b[";
const fg = ([r, g, b]) => `${ESC}38;2;${r};${g};${b}m`;
const bg = ([r, g, b]) => `${ESC}48;2;${r};${g};${b}m`;
const RESET = `${ESC}0m`, BOLD = `${ESC}1m`, DIM = `${ESC}2m`;
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const pad = (s, n) => s + " ".repeat(Math.max(0, n - visible(s).length));
const cut = (s, n) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s);

function readKey() {
  return new Promise((resolve) => process.stdin.once("keypress", (str, key) => resolve(key || { name: str })));
}

/**
 * opts: { title, brand: "#rrggbb", info: () => [[label, value, state?]], items: [{ label, hint, run(rl) }] }
 * state: "ok" | "warn" | undefined colours the value dot.
 */
async function menu(opts) {
  const brand = hex(opts.brand);
  const items = opts.items;
  let sel = 0;
  readline.emitKeypressEvents(process.stdin);
  const raw = (on) => process.stdin.isTTY && process.stdin.setRawMode(on);

  const draw = () => {
    const cols = Math.max(40, process.stdout.columns || 80);
    const w = Math.min(cols - 4, 84);
    const out = [`${ESC}2J${ESC}H${ESC}?25l`, ""];
    out.push(`  ${bg(brand)}${fg([12, 14, 16])}${BOLD} ${opts.title} ${RESET}`);
    out.push(`  ${fg(brand)}╭${"─".repeat(w - 2)}╮${RESET}`);
    for (const [label, value, state] of opts.info()) {
      const dot = state === "ok" ? `${fg([62, 207, 142])}● ` : state === "warn" ? `${fg([232, 168, 56])}● ` : "";
      const line = ` ${DIM}${pad(label, 9)}${RESET}${dot}${RESET}${cut(value, w - 16)}`;
      out.push(`  ${fg(brand)}│${RESET}${pad(line, w - 2)}${fg(brand)}│${RESET}`);
    }
    out.push(`  ${fg(brand)}╰${"─".repeat(w - 2)}╯${RESET}`, "");
    const labelW = Math.max(...items.map((i) => i.label.length)) + 2;
    items.forEach((it, i) => {
      const n = `${DIM}${i + 1}${RESET}`;
      const text = `${pad(it.label, labelW)}${DIM}${cut(it.hint || "", w - labelW - 8)}${RESET}`;
      out.push(i === sel
        ? `  ${fg(brand)}▌${RESET}${bg([38, 42, 50])} ${n}${bg([38, 42, 50])}  ${BOLD}${pad(text, w - 6)}${RESET}`
        : `   ${n}  ${text}`);
    });
    out.push("", `  ${DIM}↑↓ move · enter run · 1-${items.length} quick · q quit${RESET}`);
    process.stdout.write(out.join("\n"));
  };

  raw(true);
  process.stdin.resume();
  for (;;) {
    draw();
    const key = await readKey();
    const name = key.name || key.sequence;
    if (name === "q" || name === "escape" || (key.ctrl && name === "c")) break;
    if (name === "up" || name === "k") sel = (sel + items.length - 1) % items.length;
    else if (name === "down" || name === "j") sel = (sel + 1) % items.length;
    else if (/^[1-9]$/.test(name || "") && Number(name) <= items.length) sel = Number(name) - 1;
    if (!(name === "return" || name === "enter" || /^[1-9]$/.test(name || ""))) continue;

    const item = items[sel];
    raw(false);
    process.stdout.write(`${ESC}2J${ESC}H${ESC}?25h\n  ${bg(brand)}${fg([12, 14, 16])}${BOLD} ${opts.title} ${RESET} ${BOLD}${item.label}${RESET}\n`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      await item.run(rl);
    } catch (err) {
      process.stdout.write(`\n  ${fg([232, 110, 110])}✖ ${err.message}${RESET}\n`);
    }
    rl.close();
    process.stdout.write(`\n  ${DIM}press any key to return${RESET}`);
    raw(true);
    process.stdin.resume();
    await readKey();
  }
  raw(false);
  process.stdout.write(`${ESC}?25h${ESC}2J${ESC}H`);
  process.exit(0);
}

module.exports = { context, targetCwd, findUp, run, openUrl, openMenuPane, ask, menu };

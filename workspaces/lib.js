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
// Styled after zoetrope (github.com/furkankly/zoetrope): near-black canvas, dark cards
// with thin grey borders and a status glyph, rounded panels, gold accent, and a
// bottom bar with a name badge, a state badge and dim key hints.
const ESC = "\x1b[";
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(";");
const FG = (h) => `${ESC}38;2;${rgb(h)}m`;
const BG = (h) => `${ESC}48;2;${rgb(h)}m`;
const C = { canvas: "#121212", surface: "#1c1c1c", border: "#3a3a3a", text: "#e4e4e4", subtle: "#6c6c6c",
  accent: "#d7af00", ok: "#5faf5f", err: "#d75f5f", badge: "#3a3a3a" };
const RESET = `${ESC}0m`, BOLD = `${ESC}1m`;
const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const cut = (s, n) => (n <= 0 ? "" : s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s);
const padTo = (s, n) => s + " ".repeat(Math.max(0, n - visible(s).length));
const at = (row, col) => `${ESC}${row + 1};${col + 1}H`;

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
  process.stdout.write(`${RESET}${ESC}?25h${ESC}2J${ESC}H`);
}

// Box drawing on the canvas: square cards, rounded panels.
function box(out, top, left, width, height, { rounded = false, title = "", titleStyle = "", fill = C.surface, border = C.border } = {}) {
  const [tl, tr, bl, br] = rounded ? ["╭", "╮", "╰", "╯"] : ["┌", "┐", "└", "┘"];
  const b = `${BG(fill)}${FG(border)}`;
  const t = title ? `${titleStyle || `${FG(C.text)}${BOLD}`} ${title} ${RESET}${b}` : "";
  const topLine = `${tl}─${t}${"─".repeat(Math.max(0, width - 3 - visible(t).length))}${tr}`;
  out.push(at(top, left) + b + topLine + RESET);
  for (let r = 1; r < height - 1; r++) out.push(at(top + r, left) + b + "│" + " ".repeat(width - 2) + "│" + RESET);
  out.push(at(top + height - 1, left) + b + bl + "─".repeat(width - 2) + br + RESET);
}

function text(out, row, col, s, width, fill = C.surface) {
  out.push(at(row, col) + BG(fill) + padTo(cutVisible(s, width), width) + RESET);
}

// Cut a styled string to `n` visible characters.
function cutVisible(s, n) {
  let shown = 0, res = "";
  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith("\x1b[")) res += part;
    else {
      const room = n - shown;
      if (room <= 0) continue;
      res += part.length > room ? part.slice(0, Math.max(0, room - 1)) + "…" : part;
      shown += Math.min(part.length, room);
    }
  }
  return res;
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\r(?!\n)/g, "\n");
}

// Run a command, capturing its output line by line into `sink`.
function exec(cmd, args, cwd, sink) {
  return new Promise((resolve) => {
    const { spawn } = require("node:child_process");
    const quoted = [cmd, ...args].map((a) => (/^[\w.\-\\/:=@]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`)).join(" ");
    const child = process.platform === "win32"
      ? spawn(quoted, { cwd, shell: true, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } })
      : spawn(cmd, args, { cwd, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } });
    const take = (d) => sink(stripAnsi(d.toString()));
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (err) => {
      sink(`failed to start ${cmd}: ${err.message}\n`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/**
 * opts: {
 *   title: "supabase",
 *   cards: () => [{ glyph, glyphColor?, title, sub, subColor? }],   // header cards
 *   items: [{ label, hint, run(io) }],                               // io: { exec(cmd, args, cwd), print(s), interactive(fn) }
 * }
 */
async function menu(opts) {
  const items = opts.items;
  let sel = 0, lines = [], state = "idle", running = null, scroll = 0;

  const draw = () => {
    const cols = Math.max(60, process.stdout.columns || 100), rows = Math.max(16, process.stdout.rows || 30);
    const out = [`${ESC}?25l${BG(C.canvas)}${ESC}2J`];
    // dotted canvas, like zoetrope's graph background
    for (let r = 1; r < rows - 1; r += 2) out.push(at(r, 2) + BG(C.canvas) + FG("#2a2a2a") + " .".repeat(Math.floor((cols - 3) / 2)).slice(0, cols - 3) + RESET);

    // header cards
    const cards = opts.cards();
    let x = 1;
    for (const c of cards) {
      const w = Math.min(Math.max(visible(c.title).length, visible(c.sub).length) + 6, cols - x - 1, 46);
      if (w < 12) break;
      box(out, 1, x, w, 4);
      text(out, 2, x + 2, `${FG(c.glyphColor || C.ok)}${c.glyph} ${RESET}${BG(C.surface)}${FG(C.text)}${BOLD}${c.title}${RESET}`, w - 4);
      text(out, 3, x + 2, `${FG(c.subColor || C.subtle)}${c.sub}${RESET}`, w - 4);
      x += w + 2;
    }

    // actions panel (left) and output panel (right)
    const top = 6, height = rows - top - 2;
    const leftW = Math.min(36, Math.max(...items.map((i) => i.label.length)) + 8);
    box(out, top, 1, leftW, height, { rounded: true, title: "actions" });
    items.forEach((it, i) => {
      if (i >= height - 2) return;
      const on = i === sel;
      const mark = on ? `${FG(C.accent)}${BOLD}◆ ` : `${FG(C.subtle)}${i + 1} `;
      text(out, top + 1 + i, 3, `${mark}${RESET}${BG(C.surface)}${on ? `${FG(C.text)}${BOLD}` : FG(C.text)}${it.label}${RESET}`, leftW - 4);
    });

    const ox = leftW + 2, ow = cols - ox - 1;
    const item = items[sel];
    box(out, top, ox, ow, height, { rounded: true, title: running ? `output · ${running}` : "output" });
    const body = lines.length ? lines : [`${FG(C.subtle)}${item.hint || ""}${RESET}`, "", `${FG(C.subtle)}enter to run${RESET}`];
    const room = height - 2;
    const first = Math.max(0, Math.min(body.length - room, body.length - room - scroll));
    body.slice(Math.max(0, first), Math.max(0, first) + room).forEach((l, i) =>
      text(out, top + 1 + i, ox + 2, l.startsWith("\x1b") ? l : `${FG(C.text)}${l}`, ow - 4));

    // bottom bar
    const badge = (s, bg, fg) => `${BG(bg)}${FG(fg)}${BOLD} ${s} ${RESET}`;
    const st = { idle: ["■ IDLE", C.badge, C.text], running: ["● RUNNING", C.accent, "#121212"],
      done: ["✓ DONE", C.badge, C.ok], failed: ["✗ FAILED", C.badge, C.err] }[state];
    const left = `${badge(opts.title, C.accent, "#121212")} ${badge(...st)} ${BG(C.canvas)}${FG(C.text)}${BOLD}${item.label}${RESET}`;
    const hints = `${FG(C.subtle)}${items.length} actions · ↑↓ select · enter run · pgup/pgdn scroll · q quit${RESET}`;
    out.push(at(rows - 1, 0) + BG(C.canvas) + padTo(left + `${BG(C.canvas)}  ` + hints, cols) + RESET);
    process.stdout.write(out.join(""));
  };

  const io = {
    print: (s) => {
      lines.push(...String(s).split("\n"));
      draw();
    },
    exec: async (cmd, args, cwd) => {
      lines.push(`${FG(C.subtle)}$ ${[cmd, ...args].join(" ")}${RESET}`);
      draw();
      let pending = "";
      const code = await exec(cmd, args, cwd, (chunk) => {
        const parts = (pending + chunk).split("\n");
        pending = parts.pop();
        lines.push(...parts.map((l) => l.replace(/\s+$/, "")));
        draw();
      });
      if (pending) lines.push(pending);
      return code;
    },
    // Hand the whole terminal to a command that needs to ask questions (login, link, prompts).
    interactive: async (fn) => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdout.write(`${RESET}${ESC}?25h${ESC}2J${ESC}H`);
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await fn(rl);
      } finally {
        rl.close();
        startRaw();
      }
    },
  };

  startRaw();
  for (;;) {
    draw();
    const key = await readKey();
    const name = key.name || key.str;
    if (name === "q" || name === "escape" || (key.ctrl && name === "c")) break;
    if (name === "up" || name === "k") sel = (sel + items.length - 1) % items.length;
    else if (name === "down" || name === "j") sel = (sel + 1) % items.length;
    else if (name === "pageup") scroll += 10;
    else if (name === "pagedown") scroll = Math.max(0, scroll - 10);
    else if (/^[1-9]$/.test(name || "") && Number(name) <= items.length) sel = Number(name) - 1;
    if (["up", "down", "k", "j"].includes(name) && !running) lines = [];
    if (!(name === "return" || name === "enter" || /^[1-9]$/.test(name || ""))) continue;

    const item = items[sel];
    lines = [];
    scroll = 0;
    running = item.label;
    state = "running";
    draw();
    try {
      const code = await item.run(io);
      state = code === undefined || code === 0 ? "done" : "failed";
    } catch (err) {
      lines.push(`${FG(C.err)}✗ ${err.message}${RESET}`);
      state = "failed";
    }
    running = null;
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
    const cols = Math.max(50, process.stdout.columns || 100), rows = Math.max(8, process.stdout.rows || 24);
    const out = [`${ESC}?25l${BG(C.canvas)}${ESC}2J`];
    const w = cols - 2, room = rows - 4;
    box(out, 0, 1, w, rows - 1, { rounded: true, title: opts.title });
    text(out, 1, 3, `${FG(C.accent)}${BOLD}› ${RESET}${BG(C.surface)}${FG(C.text)}${query}${FG(C.accent)}▏${RESET}`, w - 4);
    const nameW = Math.min(28, Math.max(8, ...opts.entries.map((e) => opts.render(e)[1].length)) + 2);
    const first = Math.max(0, Math.min(sel - room + 1, list.length - room));
    list.slice(first, first + room - 1).forEach((e, i) => {
      const [mark, name, detail, tag] = opts.render(e);
      const on = first + i === sel;
      const lead = on ? `${FG(C.accent)}${BOLD}◆ ` : `${FG(mark === "●" ? C.ok : C.subtle)}${mark || " "} `;
      text(out, 2 + i, 3, `${lead}${RESET}${BG(C.surface)}${on ? BOLD : ""}${FG(C.text)}${padTo(cut(name, nameW - 1), nameW)}${RESET}` +
        `${BG(C.surface)}${FG(C.subtle)}${padTo(cut(detail, w - nameW - 16), w - nameW - 14)}${FG(tag === "open" ? C.accent : C.subtle)}${tag || ""}${RESET}`, w - 4);
    });
    if (!list.length) text(out, 2, 3, `${FG(C.subtle)}no match${RESET}`, w - 4);
    const badge = `${BG(C.accent)}${FG("#121212")}${BOLD} ${opts.title} ${RESET}`;
    out.push(at(rows - 1, 0) + BG(C.canvas) + padTo(`${badge} ${BG(C.canvas)}${FG(C.subtle)}${list.length} of ${opts.entries.length} · type to filter · ↑↓ select · enter switch · esc close${RESET}`, cols) + RESET);
    process.stdout.write(out.join(""));
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

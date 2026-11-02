// Dictate: speech-to-text into a herdr pane.
//
//   node dictate.js toggle   action: open the widget under the focused pane, or
//                            flip recording on/off when the widget is open
//   node dictate.js close    action: stop recording and close the widget
//   node dictate.js widget   pane entrypoint: the clickable widget itself
//
// The widget spawns `python stt.py`, which records the microphone, cuts phrases
// on silence and transcribes them locally with faster-whisper. Every phrase is
// written into the target pane with `herdr pane send-text` (text only, never
// Enter), so the user reviews and submits.
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const herdrBin = process.env.HERDR_BIN_PATH || "herdr";
const pluginId = process.env.HERDR_PLUGIN_ID || "antonyjaen.dictate";
const TITLE = "Dictate";
const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR || process.cwd();
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || process.cwd();
const widgetFile = path.join(stateDir, "widget.json");
const toggleFile = path.join(stateDir, "toggle-request");
const STOP_GRACE_MS = 30_000;

// ── herdr CLI ───────────────────────────────────────────────────────────────────
function herdr(...args) {
  const res = spawnSync(herdrBin, args, { encoding: "utf8" });
  if (res.error) throw new Error(`cannot run herdr: ${res.error.message}`);
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {}
  if (res.status !== 0 || parsed?.error) {
    const msg = parsed?.error?.message || (res.stderr || res.stdout).trim();
    throw new Error(`herdr ${args.slice(0, 2).join(" ")}: ${msg}`);
  }
  return parsed?.result ?? null;
}

function context() {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  } catch {
    return {};
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// Settings the user may edit in `<plugin config dir>/dictate.json`.
function settings() {
  const defaults = { python: "python", model: "small", language: "auto", silenceMs: 800, device: "" };
  const user = readJson(path.join(configDir, "dictate.json"), {});
  const merged = { ...defaults, ...user };
  if (!(Number(merged.silenceMs) > 0)) merged.silenceMs = 800;
  return merged;
}

function paneRecord(paneId) {
  if (!paneId) return null;
  try {
    return herdr("pane", "get", paneId)?.pane ?? null;
  } catch {
    return null;
  }
}

// The widget pane registered by a running widget, if it is still alive.
function liveWidget() {
  const saved = readJson(widgetFile, null);
  const pane = paneRecord(saved?.pane_id);
  if (pane && pane.label === TITLE && !pane.agent) return saved;
  if (saved) fs.rmSync(widgetFile, { force: true });
  return null;
}

// ── Actions ─────────────────────────────────────────────────────────────────────
function actionToggle() {
  const widget = liveWidget();
  if (widget) {
    fs.writeFileSync(toggleFile, String(Date.now()));
    console.log(`dictate: toggle requested on widget ${widget.pane_id}`);
    return;
  }
  const ctx = context();
  const target = ctx.focused_pane_id || process.env.HERDR_PANE_ID;
  if (!target) throw new Error("no focused pane to dictate into");
  const args = [
    "plugin", "pane", "open", "--plugin", pluginId, "--entrypoint", "widget",
    "--placement", "split", "--direction", "down", "--target-pane", target,
    "--env", `DICTATE_TARGET_PANE=${target}`, "--focus",
  ];
  const res = herdr(...args);
  const paneId = res?.plugin_pane?.pane?.pane_id;
  console.log(`dictate: widget ${paneId || "?"} opened for ${target}`);
  if (paneId) shrink(paneId, 7);
}

// A split opens at half the column; the widget only needs a few rows. The
// divider moves by a share of the split's height, so grow the pane above by
// the share the widget should give back. Best effort: a failure keeps the half.
function shrink(paneId, rows) {
  try {
    const layout = herdr("pane", "layout", "--pane", paneId)?.layout;
    const me = layout?.panes?.find((p) => p.pane_id === paneId);
    const split = layout?.splits?.find((s) => s.rect.y <= me?.rect.y && s.rect.y + s.rect.height >= me?.rect.y + me?.rect.height);
    const total = split?.rect.height || layout?.area?.height;
    if (!me || !total || me.rect.height <= rows) return;
    const amount = (me.rect.height - rows) / total;
    herdr("pane", "resize", "--pane", paneId, "--direction", "down", "--amount", amount.toFixed(3));
  } catch (err) {
    console.log(`dictate: could not shrink the widget: ${err.message}`);
  }
}

function actionClose() {
  const widget = liveWidget();
  if (!widget) {
    console.log("dictate: no widget open");
    return;
  }
  // The widget stops its recorder when its pane closes (stdin ends / SIGHUP).
  herdr("plugin", "pane", "close", widget.pane_id);
  fs.rmSync(widgetFile, { force: true });
}

// ── Widget: terminal drawing + input ───────────────────────────────────────────
const ESC = "\x1b[";
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(";");
const FG = (h) => `${ESC}38;2;${rgb(h)}m`;
const BG = (h) => `${ESC}48;2;${rgb(h)}m`;
const RESET = `${ESC}0m`, BOLD = `${ESC}1m`;
const C = { canvas: "#121212", surface: "#1c1c1c", border: "#3a3a3a", text: "#e4e4e4", subtle: "#6c6c6c",
  accent: "#d7af00", ok: "#5faf5f", err: "#d75f5f", rec: "#d75f5f" };
const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const padTo = (s, n) => s + " ".repeat(Math.max(0, n - visible(s).length));
const at = (row, col) => `${ESC}${row + 1};${col + 1}H`;
const MOUSE_ON = `${ESC}?1000h${ESC}?1006h`, MOUSE_OFF = `${ESC}?1006l${ESC}?1000l`;

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

function parseInput(data) {
  const out = [];
  let m;
  for (let i = 0; i < data.length;) {
    const rest = data.slice(i);
    if ((m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest))) {
      const b = Number(m[1]);
      if (!(b & 64)) out.push({ name: "mouse", button: b & 3, press: m[4] === "M", drag: Boolean(b & 32), x: Number(m[2]) - 1, y: Number(m[3]) - 1 });
    } else if ((m = /^\x1b\[[\d;]*[A-Za-z~]/.exec(rest)) || (m = /^\x1bO[A-Za-z]/.exec(rest))) {
      // cursor keys and friends: ignored
    } else {
      const ch = data[i];
      m = [ch];
      if (ch === "\r" || ch === "\n") out.push({ name: "return" });
      else if (ch === " ") out.push({ name: "space" });
      else if (ch === "\x1b") out.push({ name: "escape" });
      else if (ch < " ") out.push({ name: String.fromCharCode(ch.charCodeAt(0) + 96), ctrl: true });
      else out.push({ name: ch.toLowerCase() });
    }
    i += m[0].length;
  }
  return out;
}

async function widget() {
  const cfg = settings();
  const ownPane = process.env.HERDR_PANE_ID || null;
  let target = process.env.DICTATE_TARGET_PANE || null;
  let state = "idle"; // idle | starting | listening | stopping | error
  let note = "";
  let recorder = null;
  let stopFile = null;
  let sentInRun = 0;
  const phrases = [];
  let buttonRow = 2;

  if (ownPane) writeJson(widgetFile, { pane_id: ownPane, pid: process.pid });

  const targetLabel = () => {
    const pane = paneRecord(target);
    if (!pane) return target ? `${target} (gone)` : "no target";
    const name = pane.agent || pane.terminal_title_stripped || pane.label || "terminal";
    return `${pane.pane_id} · ${name}`;
  };
  let targetText = targetLabel();

  const draw = () => {
    const cols = (process.stdout.columns || 80) - 1, rows = process.stdout.rows || 8;
    const out = [`${ESC}?25l${BG(C.canvas)}${ESC}2J`];
    const label = {
      idle: ["🎙  Click to dictate", C.surface, C.text],
      starting: ["…  loading speech model", C.surface, C.subtle],
      listening: ["⏹  Listening — click to stop", C.rec, "#121212"],
      stopping: ["…  finishing last phrase", C.surface, C.subtle],
      error: ["🎙  Retry", C.surface, C.err],
    }[state];
    const header = `${BG(C.accent)}${FG("#121212")}${BOLD} ${TITLE} ${RESET}${BG(C.canvas)}${FG(C.subtle)} → ${targetText}${RESET}`;
    out.push(at(0, 0) + BG(C.canvas) + padTo(cutVisible(header, cols), cols) + RESET);
    buttonRow = 2;
    const btn = `${BG(label[1])}${FG(label[2])}${BOLD}  ${label[0]}  ${RESET}`;
    out.push(at(buttonRow, 1) + BG(C.canvas) + cutVisible(btn, cols - 1) + RESET);
    const status = note ? `${FG(state === "error" ? C.err : C.subtle)}${note}${RESET}` : "";
    out.push(at(buttonRow + 1, 1) + BG(C.canvas) + padTo(cutVisible(status, cols - 1), cols - 1) + RESET);
    const room = rows - (buttonRow + 3) - 1;
    phrases.slice(-Math.max(0, room)).forEach((p, i) => {
      out.push(at(buttonRow + 3 + i, 1) + BG(C.canvas) + padTo(cutVisible(`${FG(C.ok)}› ${FG(C.text)}${p}${RESET}`, cols - 1), cols - 1) + RESET);
    });
    const hints = `${FG(C.subtle)}click/enter/space toggle · t retarget to focused pane · q close${RESET}`;
    out.push(at(rows - 1, 0) + BG(C.canvas) + padTo(cutVisible(hints, cols), cols) + RESET);
    process.stdout.write(out.join(""));
  };

  const setState = (next, text = "") => {
    state = next;
    note = text;
    draw();
  };

  const sendToTarget = (text) => {
    if (!target) return setState(state, "no target pane: press t with the destination focused");
    const lead = sentInRun > 0 ? " " : "";
    try {
      herdr("pane", "send-text", target, `${lead}${text}`);
      sentInRun += 1;
      phrases.push(text);
      draw();
    } catch (err) {
      setState(state, `send failed: ${err.message}`);
    }
  };

  const start = () => {
    if (recorder) return;
    sentInRun = 0;
    setState("starting", `loading ${cfg.model} model…`);
    stopFile = path.join(os.tmpdir(), `herdr-dictate-${process.pid}-${Date.now()}.stop`);
    const args = [path.join(__dirname, "stt.py"), "--model", String(cfg.model), "--language", String(cfg.language),
      "--silence-ms", String(cfg.silenceMs), "--stop-file", stopFile];
    if (cfg.device) args.push("--device", String(cfg.device));
    const child = spawn(String(cfg.python), args, {
      cwd: __dirname,
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
    });
    recorder = child;
    let rest = "", lastErr = "";
    child.stdout.on("data", (d) => {
      rest += d.toString();
      const lines = rest.split("\n");
      rest = lines.pop();
      for (const line of lines) {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === "ready") setState("listening", `mic: ${msg.device}`);
        else if (msg.type === "text" && msg.text?.trim()) sendToTarget(msg.text.trim());
        else if (msg.type === "error") setState("error", msg.message);
      }
    });
    child.stderr.on("data", (d) => {
      const line = d.toString().trim().split("\n").pop();
      if (line && !/warning/i.test(line)) lastErr = line;
    });
    child.on("error", (err) => {
      recorder = null;
      setState("error", `cannot start ${cfg.python}: ${err.message}`);
    });
    child.on("close", (code) => {
      const wasStopping = state === "stopping";
      recorder = null;
      if (stopFile) fs.rmSync(stopFile, { force: true });
      stopFile = null;
      if (state === "error") return draw();
      if (code !== 0 && !wasStopping) setState("error", lastErr || `recorder exited with code ${code}`);
      else setState("idle", sentInRun ? `${sentInRun} phrase${sentInRun === 1 ? "" : "s"} typed into ${target}` : "");
    });
  };

  const stop = () => {
    if (!recorder) return;
    const child = recorder;
    setState("stopping", "transcribing the last phrase…");
    try {
      fs.writeFileSync(stopFile, "stop");
    } catch {
      child.kill();
      return;
    }
    setTimeout(() => {
      if (recorder === child) child.kill();
    }, STOP_GRACE_MS).unref();
  };

  const toggle = () => {
    if (state === "listening" || state === "starting") stop();
    else if (state !== "stopping") start();
  };

  const retarget = () => {
    try {
      const panes = herdr("pane", "list")?.panes ?? [];
      const focused = panes.find((p) => p.focused && p.pane_id !== ownPane);
      if (focused) {
        target = focused.pane_id;
        targetText = targetLabel();
        setState(state, `target: ${targetText}`);
      } else setState(state, "focus the destination pane, then press t here");
    } catch (err) {
      setState(state, err.message);
    }
  };

  const quit = () => {
    process.stdout.write(`${MOUSE_OFF}${RESET}${ESC}?25h${ESC}2J${ESC}H`);
    if (recorder) {
      try {
        fs.writeFileSync(stopFile, "stop");
      } catch {}
      setTimeout(() => recorder && recorder.kill(), 3000).unref();
      recorder.on("close", () => process.exit(0));
    }
    fs.rmSync(widgetFile, { force: true });
    if (!recorder) process.exit(0);
  };

  // A keybinding toggle from outside lands as a request file. The same tick
  // catches a pane resize the terminal did not signal (ConPTY is lazy there).
  fs.rmSync(toggleFile, { force: true });
  let lastSize = `${process.stdout.columns}x${process.stdout.rows}`;
  setInterval(() => {
    if (fs.existsSync(toggleFile)) {
      fs.rmSync(toggleFile, { force: true });
      toggle();
    }
    const size = `${process.stdout.columns}x${process.stdout.rows}`;
    if (size !== lastSize) {
      lastSize = size;
      draw();
    }
  }, 250).unref();

  process.stdin.setEncoding("utf8");
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write(MOUSE_ON);
  process.stdin.on("data", (data) => {
    for (const key of parseInput(String(data))) {
      if (key.name === "mouse") {
        if (key.press && !key.drag && key.button === 0 && key.y === buttonRow) toggle();
      } else if (key.name === "return" || key.name === "space") toggle();
      else if (key.name === "t") retarget();
      else if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) quit();
    }
  });
  process.stdin.on("end", quit);
  process.on("SIGHUP", quit);
  process.on("SIGTERM", quit);
  process.stdout.on("resize", draw);
  draw();
}

const cmd = process.argv[2] || "widget";
try {
  if (cmd === "toggle") actionToggle();
  else if (cmd === "close") actionClose();
  else if (cmd === "widget") widget();
  else {
    console.error(`unknown command: ${cmd}`);
    process.exit(2);
  }
} catch (err) {
  console.error(`dictate: ${err.message}`);
  process.exit(1);
}

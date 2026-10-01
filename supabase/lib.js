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

function ask(rl, q) {
  return new Promise((resolve) => rl.question(q, resolve));
}

// items: [{ label, run: async (rl) => void }]
async function menu(title, header, items) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    console.clear();
    console.log(`${title}\n${header()}\n`);
    items.forEach((it, i) => console.log(`  ${i + 1}) ${it.label}`));
    console.log("  q) quit\n");
    const choice = (await ask(rl, "> ")).trim().toLowerCase();
    if (choice === "q" || choice === "") break;
    const item = items[Number(choice) - 1];
    if (!item) continue;
    try {
      await item.run(rl);
    } catch (err) {
      console.error(err.message);
    }
    await ask(rl, "\nPress Enter to return to the menu...");
  }
  rl.close();
}

module.exports = { context, targetCwd, findUp, run, openUrl, openMenuPane, ask, menu };

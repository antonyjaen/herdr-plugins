// Declarative tab/pane layouts for herdr workspaces, applied through the herdr CLI only
// (no raw socket), so it behaves the same on Windows, macOS and Linux.
//
// Usage: node workspaces.js <event|apply [layout]|validate|startup>
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const herdrBin = process.env.HERDR_BIN_PATH || "herdr";
const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR || process.cwd();
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || process.cwd();
const configFile = path.join(configDir, "workspaces.json");
const appliedFile = path.join(stateDir, "applied.json");
const PROJECT_FILE = path.join(".herdr", "layout.json");

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

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw new Error(`${file}: ${err.message}`);
  }
}

const norm = (p) => path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
const caseFold = (s) => (process.platform === "win32" || process.platform === "darwin" ? s.toLowerCase() : s);

// "*" matches within one path segment, "**" across segments.
function globMatch(pattern, target) {
  const expanded = pattern.replace(/^~(?=$|[\\/])/, require("node:os").homedir());
  const re = norm(expanded)
    .split(/(\*\*|\*)/)
    .map((part) => (part === "**" ? ".*" : part === "*" ? "[^/]*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${caseFold(re)}$`).test(caseFold(norm(target)));
}

// Project file wins, then the first matching workspace rule, then "default".
function resolveLayout(cwd, name) {
  const config = readJson(configFile, { layouts: {}, workspaces: [] });
  const layouts = config.layouts || {};
  if (name) {
    if (!layouts[name]) throw new Error(`no layout named "${name}" in ${configFile}`);
    return { name, layout: layouts[name] };
  }
  for (let dir = norm(cwd); ; dir = path.posix.dirname(dir)) {
    const file = path.join(dir, PROJECT_FILE);
    if (fs.existsSync(file)) return { name: file, layout: readJson(file) };
    if (path.posix.dirname(dir) === dir) break;
  }
  const rule = (config.workspaces || []).find((w) => globMatch(w.match, cwd));
  const chosen = rule?.layout || config.default;
  if (!chosen) return null;
  if (!layouts[chosen]) throw new Error(`layout "${chosen}" is not defined in ${configFile}`);
  return { name: chosen, layout: layouts[chosen] };
}

function validateLayout(layout, where) {
  if (!Array.isArray(layout?.tabs) || !layout.tabs.length) throw new Error(`${where}: "tabs" must be a non-empty array`);
  layout.tabs.forEach((tab, t) => {
    if (tab.plugin !== undefined) {
      if (typeof tab.plugin !== "string" || tab.panes) throw new Error(`${where} tab ${t + 1}: a plugin tab takes "plugin" and "entrypoint", not "panes"`);
      return;
    }
    const panes = tab.panes?.length ? tab.panes : [{}];
    panes.forEach((pane, i) => {
      const at = `${where} tab ${t + 1} pane ${i + 1}`;
      if (i === 0 && pane.split) throw new Error(`${at}: the first pane can't split`);
      if (pane.split && !["right", "down"].includes(pane.split)) throw new Error(`${at}: split must be "right" or "down"`);
      if (pane.of !== undefined && !(Number.isInteger(pane.of) && pane.of >= 1 && pane.of <= i))
        throw new Error(`${at}: "of" must name an earlier pane (1..${i})`);
      if (pane.ratio !== undefined && !(pane.ratio > 0 && pane.ratio < 1)) throw new Error(`${at}: ratio must be between 0 and 1`);
      if (pane.command !== undefined && typeof pane.command !== "string") throw new Error(`${at}: command must be a string`);
    });
  });
}

function run(paneId, command) {
  if (!command) return;
  herdr("pane", "send-text", paneId, command);
  herdr("pane", "send-keys", paneId, "Enter");
}

// Build every tab of the layout. `reuseTab` is the fresh tab of a just-created workspace,
// which becomes the first layout tab instead of leaving an empty extra tab behind.
function applyLayout(workspaceId, cwd, layout, reuseTab) {
  // Re-applying only adds what's missing: a labelled tab that already exists is left alone.
  const existing = new Set(herdr("tab", "list", "--workspace", workspaceId).tabs.map((t) => t.label));
  const tabs = layout.tabs.filter((tab) => (!tab.when || fs.existsSync(path.resolve(cwd, tab.when))) &&
    !(tab.label && existing.has(tab.label)));
  // Only a plain pane tab can take over the fresh tab; plugin tabs open their own.
  if (tabs[0]?.plugin) reuseTab = null;
  tabs.forEach((tab, t) => {
    const tabCwd = tab.cwd ? path.resolve(cwd, tab.cwd) : cwd;
    if (tab.plugin) {
      const res = herdr("plugin", "pane", "open", "--plugin", tab.plugin, "--entrypoint", tab.entrypoint || "menu",
        "--placement", "tab", "--workspace", workspaceId, "--no-focus", "--env", `HERDR_TARGET_CWD=${tabCwd}`);
      if (tab.label) herdr("tab", "rename", res.plugin_pane.pane.tab_id, tab.label);
      return;
    }
    let tabId, rootPane;
    if (t === 0 && reuseTab) {
      tabId = reuseTab.tab_id;
      rootPane = reuseTab.pane_id;
      if (tab.label) herdr("tab", "rename", tabId, tab.label);
    } else {
      const res = herdr("tab", "create", "--workspace", workspaceId, "--cwd", tabCwd, "--no-focus",
        ...(tab.label ? ["--label", tab.label] : []));
      tabId = res.tab.tab_id;
      rootPane = res.root_pane.pane_id;
    }
    const ids = [rootPane];
    const panes = tab.panes?.length ? tab.panes : [{}];
    panes.forEach((pane, i) => {
      if (i > 0) {
        const parent = ids[(pane.of || i) - 1];
        const res = herdr("pane", "split", "--pane", parent, "--direction", pane.split || "right", "--no-focus",
          "--cwd", pane.cwd ? path.resolve(tabCwd, pane.cwd) : tabCwd,
          ...(pane.ratio ? ["--ratio", String(pane.ratio)] : []));
        ids.push(res.pane.pane_id);
      }
      run(ids[i], pane.command);
    });
  });
}

function context() {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  } catch {
    return {};
  }
}

function workspaceInfo(workspaceId) {
  const ws = herdr("workspace", "get", workspaceId).workspace;
  const panes = herdr("pane", "list", "--workspace", workspaceId).panes;
  return { ws, panes };
}

// Applied once per workspace; startup forgets workspaces that no longer exist.
const loadApplied = () => readJson(appliedFile, {});
function saveApplied(applied) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(appliedFile, JSON.stringify(applied, null, 2));
}

function onEvent() {
  let event = {};
  try {
    event = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON || "{}");
  } catch {}
  const workspaceId = event.workspace_id || event.workspace?.workspace_id || event.data?.workspace_id ||
    process.env.HERDR_WORKSPACE_ID;
  if (!workspaceId) return;
  const applied = loadApplied();
  if (applied[workspaceId]) return;
  const { ws, panes } = workspaceInfo(workspaceId);
  const cwd = panes[0]?.cwd;
  if (!cwd) return;
  const resolved = resolveLayout(cwd);
  if (!resolved) return;
  validateLayout(resolved.layout, resolved.name);
  // Only build into a workspace nobody has touched yet: one tab, one pane.
  const fresh = ws.tab_count === 1 && panes.length === 1;
  applied[workspaceId] = { layout: resolved.name, cwd, at: new Date().toISOString() };
  saveApplied(applied);
  applyLayout(workspaceId, cwd, resolved.layout, fresh ? panes[0] : null);
  console.log(`applied ${resolved.name} to ${ws.label || workspaceId}`);
}

function onApply(name) {
  const ctx = context();
  const workspaceId = ctx.workspace_id || process.env.HERDR_WORKSPACE_ID;
  if (!workspaceId) throw new Error("no workspace in context");
  const cwd = ctx.workspace_cwd || ctx.focused_pane_cwd;
  const resolved = resolveLayout(cwd, name);
  if (!resolved) throw new Error(`no layout for ${cwd}: add a rule or "default" to ${configFile}, or ${PROJECT_FILE}`);
  validateLayout(resolved.layout, resolved.name);
  applyLayout(workspaceId, cwd, resolved.layout, null);
  const applied = loadApplied();
  applied[workspaceId] = { layout: resolved.name, cwd, at: new Date().toISOString() };
  saveApplied(applied);
  console.log(`applied ${resolved.name}`);
}

function onValidate() {
  const config = readJson(configFile, null);
  if (!config) return console.log(`no config yet at ${configFile}`);
  for (const [name, layout] of Object.entries(config.layouts || {})) validateLayout(layout, `layout "${name}"`);
  for (const rule of config.workspaces || []) {
    if (!rule.match || !config.layouts?.[rule.layout]) throw new Error(`rule ${JSON.stringify(rule)}: needs "match" and a defined "layout"`);
  }
  if (config.default && !config.layouts?.[config.default]) throw new Error(`default layout "${config.default}" is not defined`);
  const cwd = context().workspace_cwd;
  const here = cwd ? resolveLayout(cwd) : null;
  console.log(`ok: ${Object.keys(config.layouts || {}).length} layouts, ${(config.workspaces || []).length} rules` +
    (cwd ? `; this workspace -> ${here ? here.name : "none"}` : ""));
}

function workspaceCwd(workspaceId) {
  return (herdr("pane", "list", "--workspace", workspaceId).panes[0]?.cwd || "").replace(/[\\/]+$/, "");
}

function applyTo(workspaceId, cwd) {
  const resolved = resolveLayout(cwd);
  if (!resolved) return `no layout for ${cwd}`;
  validateLayout(resolved.layout, resolved.name);
  const before = herdr("tab", "list", "--workspace", workspaceId).tabs.length;
  applyLayout(workspaceId, cwd, resolved.layout, null);
  const added = herdr("tab", "list", "--workspace", workspaceId).tabs.length - before;
  const applied = loadApplied();
  applied[workspaceId] = { layout: resolved.name, cwd, at: new Date().toISOString() };
  saveApplied(applied);
  return `${resolved.name}: ${added ? `added ${added} tab${added > 1 ? "s" : ""}` : "nothing missing"}`;
}

function openInEditor(file) {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ layouts: {}, workspaces: [], default: null }, null, 2) + "\n");
  }
  const editor = process.env.VISUAL || process.env.EDITOR;
  const [cmd, args] = editor ? [editor, [file]]
    : process.platform === "win32" ? ["notepad", [file]]
    : [process.platform === "darwin" ? "open" : "xdg-open", [file]];
  spawnSync(cmd, args, { stdio: "inherit", shell: Boolean(editor) && process.platform === "win32" });
}

function onMenu() {
  const { menu } = require("./lib");
  const ctx = context();
  const workspaceId = ctx.workspace_id || process.env.HERDR_WORKSPACE_ID;
  const cwd = process.env.HERDR_TARGET_CWD || ctx.workspace_cwd || (workspaceId && workspaceCwd(workspaceId));
  const say = (s) => console.log(`\n  ${s}`);
  menu({
    title: "Workspaces",
    brand: "#8DC8C5",
    info: () => {
      let layout = "none";
      try {
        layout = resolveLayout(cwd)?.name || "none — set \"default\" or a rule";
      } catch (err) {
        layout = `error: ${err.message}`;
      }
      return [
        ["layout", layout, layout.startsWith("none") || layout.startsWith("error") ? "warn" : "ok"],
        ["dir", cwd || "?"],
        ["config", configFile],
      ];
    },
    items: [
      { label: "Add missing tabs", hint: "apply this workspace's layout (existing tabs are kept)",
        run: async () => say(applyTo(workspaceId, cwd)) },
      { label: "All workspaces", hint: "add missing layout tabs in every workspace",
        run: async () => {
          for (const w of herdr("workspace", "list").workspaces) say(`${w.label}: ${applyTo(w.workspace_id, workspaceCwd(w.workspace_id))}`);
        } },
      { label: "Layouts", hint: "show layouts and matching rules",
        run: async () => {
          const config = readJson(configFile, { layouts: {}, workspaces: [] });
          for (const [name, l] of Object.entries(config.layouts || {}))
            say(`${name}${config.default === name ? " (default)" : ""}: ${(l.tabs || []).map((t) => t.label || t.plugin || "tab").join(" · ")}`);
          for (const r of config.workspaces || []) say(`${r.match} → ${r.layout}`);
        } },
      { label: "Validate", hint: "check workspaces.json", run: async () => onValidate() },
      { label: "Edit config", hint: "open workspaces.json in your editor", run: async () => openInEditor(configFile) },
    ],
  });
}

function onStartup() {
  const live = new Set(herdr("workspace", "list").workspaces.map((w) => w.workspace_id));
  const applied = loadApplied();
  for (const id of Object.keys(applied)) if (!live.has(id)) delete applied[id];
  saveApplied(applied);
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === "event") onEvent();
  else if (cmd === "apply") onApply(arg);
  else if (cmd === "validate") onValidate();
  else if (cmd === "startup") onStartup();
  else if (cmd === "menu") onMenu();
  else throw new Error(`unknown command: ${cmd}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

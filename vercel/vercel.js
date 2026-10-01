// Vercel helpers for the project in the focused herdr pane.
// Usage: node vercel.js <menu|open-menu|dashboard>
const fs = require("node:fs");
const path = require("node:path");
const { targetCwd, findUp, run, openMenuPane, ask, menu } = require("./lib");

function project() {
  const cwd = targetCwd();
  const root = findUp(cwd, path.join(".vercel", "project.json")) || findUp(cwd, ".git") || cwd;
  let linked = null;
  try {
    linked = JSON.parse(fs.readFileSync(path.join(root, ".vercel", "project.json"), "utf8"));
  } catch {}
  return { root, linked };
}

const vc = (...args) => () => run("vercel", args, project().root);

async function envPull(rl) {
  const { root } = project();
  const answer = (await ask(rl, "Pull development env vars into which file? [.env.local] ")).trim();
  const file = answer || ".env.local";
  // The path reaches a shell on Windows: allow plain relative paths only.
  if (!/^[\w.\-\\/]+$/.test(file) || path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
    throw new Error(`refusing path ${JSON.stringify(file)}: use a plain relative path inside ${root}`);
  }
  const target = path.join(root, file);
  if (fs.existsSync(target)) {
    const ok = (await ask(rl, `${target} exists and will be overwritten. Continue? [y/N] `)).trim().toLowerCase();
    if (ok !== "y") return console.log("cancelled");
  }
  run("vercel", ["env", "pull", file, "--yes"], root);
}

const items = [
  { label: "Deployments", hint: "recent deployments — vercel ls", run: vc("ls") },
  { label: "Link directory", hint: "vercel link — pick the project for this folder", run: vc("link") },
  { label: "Env variables", hint: "vercel env ls", run: vc("env", "ls") },
  { label: "Pull env", hint: "write development env to a local file — vercel env pull", run: envPull },
  { label: "Dashboard", hint: "open the project in your browser — vercel open", run: vc("open") },
  { label: "Who am I", hint: "vercel whoami", run: vc("whoami") },
  { label: "Log in", hint: "vercel login", run: vc("login") },
];

function info() {
  const { root, linked } = project();
  return [
    ["project", linked ? linked.projectName || linked.projectId : "not linked — use Link directory", linked ? "ok" : "warn"],
    ["dir", root],
  ];
}

const cmd = process.argv[2] || "menu";
if (cmd === "open-menu") openMenuPane();
else if (cmd === "dashboard") process.exit(run("vercel", ["open"], project().root));
else if (cmd === "menu") menu({ title: "vercel", info, items });
else {
  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}

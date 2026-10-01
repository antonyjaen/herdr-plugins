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
  { label: "Recent deployments (vercel ls)", run: vc("ls") },
  { label: "Link this directory to a project (vercel link)", run: vc("link") },
  { label: "Environment variables (vercel env ls)", run: vc("env", "ls") },
  { label: "Pull development env into a file (vercel env pull)", run: envPull },
  { label: "Open dashboard in browser (vercel open)", run: vc("open") },
  { label: "Who am I (vercel whoami)", run: vc("whoami") },
  { label: "Log in (vercel login)", run: vc("login") },
];

function header() {
  const { root, linked } = project();
  const link = linked ? `${linked.projectName || linked.projectId}` : "not linked — choose 2 to link";
  return `dir:     ${root}\nproject: ${link}`;
}

const cmd = process.argv[2] || "menu";
if (cmd === "open-menu") openMenuPane();
else if (cmd === "dashboard") process.exit(run("vercel", ["open"], project().root));
else if (cmd === "menu") menu("Vercel", header, items);
else {
  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}

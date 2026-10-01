// Supabase helpers for the project in the focused herdr pane.
// Usage: node supabase.js <menu|open-menu|dashboard>
const fs = require("node:fs");
const path = require("node:path");
const { targetCwd, findUp, run, openUrl, openMenuPane, ask, menu } = require("./lib");

const readTemp = (root, file) => {
  try {
    return fs.readFileSync(path.join(root, "supabase", ".temp", file), "utf8").trim();
  } catch {
    return "";
  }
};

// Project refs are 20 lowercase alphanumerics; anything else is not trusted
// into a URL or argv.
const validRef = (ref) => (/^[a-z0-9]{20}$/.test(ref || "") ? ref : null);

// `project-ref` is what the CLI's --linked reads; `linked-project.json` is
// metadata that can outlive it, so it only supplies a name/ref hint.
function project() {
  const cwd = targetCwd();
  const root = findUp(cwd, "supabase") || cwd;
  let meta = {};
  try {
    meta = JSON.parse(readTemp(root, "linked-project.json") || "{}");
  } catch {}
  const cliRef = validRef(readTemp(root, "project-ref"));
  return { root, cliRef, ref: cliRef || validRef(meta.ref), name: meta.name };
}

function dashboard() {
  const { ref } = project();
  openUrl(ref ? `https://supabase.com/dashboard/project/${ref}` : "https://supabase.com/dashboard/projects");
}

const sb = (...args) => () => run("supabase", args, project().root);

// Commands that take an explicit ref, so they work even when only the hint exists.
const sbRef = (...args) => () => {
  const { root, ref } = project();
  run("supabase", ref ? [...args, "--project-ref", ref] : args, root);
};

function migrations() {
  const { root, cliRef } = project();
  if (!cliRef) throw new Error("The CLI isn't linked here (no supabase/.temp/project-ref). Choose 2 to link first.");
  run("supabase", ["migration", "list", "--linked"], root);
}

const items = [
  { label: "Projects (supabase projects list)", run: sb("projects", "list") },
  { label: "Link this directory to a project (supabase link)", run: sb("link") },
  { label: "Migrations: local vs remote (supabase migration list --linked)", run: migrations },
  { label: "Preview branches (supabase branches list)", run: sbRef("branches", "list") },
  { label: "Edge functions (supabase functions list)", run: sbRef("functions", "list") },
  { label: "Open dashboard in browser", run: async () => dashboard() },
  { label: "Log in (supabase login)", run: sb("login") },
];

function header() {
  const { root, cliRef, ref, name } = project();
  const label = `${name ? `${name} ` : ""}(${ref})`;
  const link = cliRef ? `${label} — linked`
    : ref ? `${label} — CLI not linked; choose 2 to link`
    : "not linked — choose 2 to link";
  return `dir:     ${root}\nproject: ${link}`;
}

const cmd = process.argv[2] || "menu";
if (cmd === "open-menu") openMenuPane();
else if (cmd === "dashboard") dashboard();
else if (cmd === "menu") menu("Supabase", header, items);
else {
  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}

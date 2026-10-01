// Supabase helpers for the project in the focused herdr pane.
// Usage: node supabase.js <menu|open-menu|dashboard>
const fs = require("node:fs");
const path = require("node:path");
const { targetCwd, findUp, run, openUrl, openMenuPane, menu } = require("./lib");

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

// Captured into the output panel.
const sb = (...args) => (io) => io.exec("supabase", args, project().root);

// Commands that take an explicit ref, so they work even when only the hint exists.
const sbRef = (...args) => (io) => {
  const { root, ref } = project();
  return io.exec("supabase", ref ? [...args, "--project-ref", ref] : args, root);
};

// Prompts (project picker, browser login) need the whole terminal.
const sbInteractive = (...args) => (io) => io.interactive(() => run("supabase", args, project().root));

function migrations(io) {
  const { root, cliRef } = project();
  if (!cliRef) throw new Error("The CLI isn't linked here (no supabase/.temp/project-ref). Run Link directory first.");
  return io.exec("supabase", ["migration", "list", "--linked"], root);
}

const items = [
  { label: "Projects", hint: "supabase projects list", run: sb("projects", "list") },
  { label: "Link directory", hint: "supabase link: pick the project for this folder", run: sbInteractive("link") },
  { label: "Migrations", hint: "local vs remote: supabase migration list --linked", run: migrations },
  { label: "Branches", hint: "preview branches: supabase branches list", run: sbRef("branches", "list") },
  { label: "Functions", hint: "edge functions: supabase functions list", run: sbRef("functions", "list") },
  { label: "Dashboard", hint: "open the project in your browser", run: (io) => (dashboard(), io.print("opened the dashboard in your browser")) },
  { label: "Log in", hint: "supabase login", run: sbInteractive("login") },
];

function cards() {
  const { root, cliRef, ref, name } = project();
  return [
    { glyph: ref ? "●" : "○", glyphColor: ref ? "#5faf5f" : "#6c6c6c", title: name || "no project", sub: ref ? `⚒ ${ref}` : "⚒ not linked", subColor: "#d7af00" },
    { glyph: cliRef ? "✓" : "✗", glyphColor: cliRef ? "#5faf5f" : "#d75f5f", title: cliRef ? "cli linked" : "cli not linked", sub: cliRef ? "migrations ready" : "run Link directory" },
    { glyph: "▣", glyphColor: "#6c6c6c", title: path.basename(root), sub: root },
  ];
}

const cmd = process.argv[2] || "menu";
if (cmd === "open-menu") openMenuPane();
else if (cmd === "dashboard") dashboard();
else if (cmd === "menu") menu({ title: "supabase", cards, items });
else {
  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}

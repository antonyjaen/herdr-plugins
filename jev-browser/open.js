// Open the jev-browser pane beside the focused pane. Optional argv[2]: start URL.
const { spawnSync } = require("node:child_process");

const herdr = process.env.HERDR_BIN_PATH || "herdr";
const args = ["plugin", "pane", "open", "--plugin", process.env.HERDR_PLUGIN_ID, "--entrypoint", "browser",
  "--placement", "split", "--direction", "right", "--focus"];
// A ctrl-clicked link arrives in the context; hand it to the pane as its start page.
let url = process.argv[2] || "";
try {
  url = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}").clicked_url || url;
} catch {}
if (/^https?:\/\/\S+$/.test(url)) args.push("--env", `JEV_START_URL=${url}`);

const res = spawnSync(herdr, args, { encoding: "utf8" });
process.stdout.write(res.stdout || "");
process.stderr.write(res.stderr || "");
process.exit(res.status ?? 1);

# herdr-plugins

[herdr](https://herdr.dev) plugins that run on Windows, macOS and Linux alike:
the Supabase and Vercel CLIs one action away, scoped to the project in the
focused pane, and a browser pane driven by hand or by goals.

## Install

```sh
herdr plugin install antonyjaen/herdr-plugins/supabase
herdr plugin install antonyjaen/herdr-plugins/vercel
herdr plugin install antonyjaen/herdr-plugins/jev-browser
herdr plugin install antonyjaen/herdr-plugins/workspaces
```

Requires `node` plus the matching CLI on `PATH`:
[`supabase`](https://supabase.com/docs/guides/cli) and/or
[`vercel`](https://vercel.com/docs/cli). Log in through the menu or with the
CLI first.

## Use

Each plugin adds two actions:

- **Supabase: open menu** / **Vercel: open menu** — a popup menu for the
  project the focused pane is in (found by walking up to `supabase/` or
  `.vercel/project.json`).
- **Supabase: open dashboard** / **Vercel: open dashboard** — opens the linked
  project in the browser.

| Supabase menu | Vercel menu |
| --- | --- |
| Projects list | Recent deployments |
| Link this directory | Link this directory |
| Migrations, local vs remote | Environment variables (list) |
| Preview branches | Pull development env into a file |
| Edge functions | Open dashboard |
| Open dashboard | Who am I |
| Log in | Log in |

To bind a key, add to your herdr `config.toml`:

```toml
[[keys.command]]
key = "prefix+shift+s"
type = "plugin_action"
command = "antonyjaen.supabase.menu"
description = "Supabase menu"
```

## Jev Browser

**Jev Browser: open** splits a browser pane beside the focused pane. It drives
a dedicated Chrome (its own profile under the plugin state dir, debugging port
on 127.0.0.1) and shows the page as truecolor half-block text plus a numbered
list of the page's controls. Type at the prompt:

| Input | Does |
| --- | --- |
| `example.com`, `https://…` | Open the URL |
| `3` | Click element [3] |
| `type 2 Ada Lovelace`, `enter` | Fill field [2], press Enter |
| `up` / `down`, `back`, `reload` | Scroll and navigate |
| `shot`, `text` | Toggle the page image / page text |
| `do <goal>` or any other sentence | Let the agent carry out the goal |

Goals run on [jev-ultrafast](https://github.com/browser-use/jev-ultrafast):
[TypeSafe Jev](https://docs.typesafe.ai/introduction) picks each action and
element from the page's control list, and a small OpenAI-compatible LLM writes
text only when a field needs typing. Ctrl+C stops a run.

Requires [`uv`](https://docs.astral.sh/uv/), `node` and Google Chrome or
Chromium (set `JEV_CHROME` if it isn't found). Put keys in the environment or
in `$(herdr plugin config-dir antonyjaen.jev-browser)/.env`:

```sh
TYPESAFE_API_KEY=...
TEXT_MODEL_API_KEY=...                        # e.g. OpenRouter or MiniMax
TEXT_MODEL_BASE_URL=https://openrouter.ai/api/v1
TEXT_MODEL=inception/mercury-2.5
```

MiniMax works too (`TEXT_MODEL_BASE_URL=https://api.minimax.io/v1`,
`TEXT_MODEL=MiniMax-M2.7-highspeed`); the plugin asks it to keep its reasoning
out of the answer.

## Workspaces

Declarative tab/pane layouts, applied once when a matching workspace (or
worktree) is created, or on demand with **Workspaces: apply layout**. A
cross-platform take on
[herdr-plugin-workspace-manager](https://github.com/razajamil/herdr-plugin-workspace-manager),
built only on herdr CLI calls. Requires `node`.

Put layouts in `$(herdr plugin config-dir antonyjaen.workspaces)/workspaces.json`:

```json
{
  "layouts": {
    "dev": {
      "tabs": [
        { "label": "code", "panes": [
          { "command": "claude" },
          { "split": "right", "ratio": 0.4, "command": "pnpm dev" },
          { "split": "down", "of": 2, "command": "git status" }
        ]},
        { "label": "logs", "panes": [{ "command": "vercel logs" }] }
      ]
    }
  },
  "workspaces": [{ "match": "~/code/my-app*", "layout": "dev" }],
  "default": null
}
```

- A tab can host another plugin's pane instead of panes, e.g.
  `{ "label": "browser", "plugin": "antonyjaen.jev-browser", "entrypoint": "browser" }`
  or `{ "label": "supabase", "plugin": "antonyjaen.supabase", "when": "supabase" }`.
  `when` names a path under the workspace that must exist for the tab to open.
- A project can carry its own `.herdr/layout.json` (one layout, `{ "tabs": [...] }`);
  it wins over the rules.
- `match` is a path glob: `*` within a folder name, `**` across folders.
  Matching ignores case on Windows and macOS.
- Each pane after the first splits pane `of` (default: the previous one)
  `right` or `down`; `ratio` sizes the split; `cwd` is relative to the tab's.
- A fresh workspace's first tab is reused; layouts never touch a workspace
  that already has more than one pane, and apply only once per workspace.
- **Workspaces: validate config** checks the file and shows which layout the
  current workspace gets.

## Safety

Nothing here changes remote state: no `db push`/`db reset`, no deploys, no env
var writes. `vercel env pull` only writes a local file, asks before
overwriting, and accepts plain relative paths only.

Jev Browser's Chrome profile is separate from your everyday one, but goals act
on real sites: the agent clicks and types for you, and only stops at `DONE`,
`BLOCKED`, Ctrl+C or its step budget. Chrome's debugging port listens on
127.0.0.1 without authentication while that Chrome window is open, so any
local program can drive it.

## License

MIT

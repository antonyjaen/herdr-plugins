# herdr-plugins

[herdr](https://herdr.dev) plugins that run on Windows, macOS and Linux alike:
the Supabase and Vercel CLIs one action away, scoped to the project in the
focused pane, plus declarative workspace layouts.

## Install

```sh
herdr plugin install antonyjaen/herdr-plugins/supabase
herdr plugin install antonyjaen/herdr-plugins/vercel
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
  `{ "label": "supabase", "plugin": "antonyjaen.supabase", "when": "supabase" }`.
  `when` names a path under the workspace that must exist for the tab to open.
- A project can carry its own `.herdr/layout.json` (one layout, `{ "tabs": [...] }`);
  it wins over the rules.
- `match` is a path glob: `*` within a folder name, `**` across folders.
  Matching ignores case on Windows and macOS.
- Each pane after the first splits pane `of` (default: the previous one)
  `right` or `down`; `ratio` sizes the split; `cwd` is relative to the tab's.
- A fresh workspace's first tab is reused; layouts never touch a workspace
  that already has more than one pane, and apply only once per workspace.
- **Workspaces: switch** pops up every open workspace plus the project folders
  next to them (git repos; set `"projects": ["~/code/*"]` to choose the roots).
  Type to filter, Enter jumps there, or opens the project as a new workspace.
  Bind it to a key, e.g. `key = "prefix+w"` with `command = "antonyjaen.workspaces.switch"`.
- Re-applying only adds the layout's missing tabs (matched by label), so it is
  safe to run any time.
- The plugin's own screen (`{ "plugin": "antonyjaen.workspaces" }` as a tab,
  or the `menu` pane) shows the current workspace's layout and offers: add
  missing tabs here or in every workspace, list layouts, validate, and open
  `workspaces.json` in `$VISUAL`/`$EDITOR` (Notepad / `open` / `xdg-open` otherwise).

## Safety

Nothing here changes remote state: no `db push`/`db reset`, no deploys, no env
var writes. `vercel env pull` only writes a local file, asks before
overwriting, and accepts plain relative paths only.


## License

MIT

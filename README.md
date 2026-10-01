# herdr-plugins

[herdr](https://herdr.dev) plugins that put the Supabase and Vercel CLIs one
action away, scoped to the project in the focused pane. Written in Node, so
they run on Windows as well as macOS and Linux.

## Install

```sh
herdr plugin install antonyjaen/herdr-plugins/supabase
herdr plugin install antonyjaen/herdr-plugins/vercel
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

## Safety

Nothing here changes remote state: no `db push`/`db reset`, no deploys, no env
var writes. `vercel env pull` only writes a local file, asks before
overwriting, and accepts plain relative paths only.

## License

MIT

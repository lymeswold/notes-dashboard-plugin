# notes - Dashboard Notes plugin

A Notes tab for the Hermes dashboard: personal Markdown notes stored as
Obsidian notes in a configurable vault, shared across Dashboard instances.

## Install

```bash
hermes plugins install https://github.com/lymeswold/notes-dashboard-plugin
```

Then restart the dashboard (the backend routes mount at startup):

```bash
systemctl --user restart hermes-dashboard.service   # or your usual restart
```

## Configure

Set the vault directory in the dashboard (Notes tab -> settings) or directly
in `config.yaml`:

```yaml
plugins:
  notes:
    vault_path: /path/to/your/Obsidian/vault/hermes-dashboard
```

Notes are stored as `<vault_path>/<slug>.md` with a `title:` in YAML
frontmatter, so the vault stays a clean collection of ordinary Obsidian
notes. `updated_at` comes from the file's mtime, which is preserved across
synced vaults (Syncthing, etc.).

## Why the vendored YAML?

The dashboard process runs the PM-managed Python with `-I` (isolated), which
may have no `yaml` module in site-packages. The plugin vendors a pure-python
PyYAML 6.0.2 under `dashboard/_vendor/yaml/` and falls back to it whenever
the interpreter's own `yaml` is missing, so it works on any host without
installing anything.

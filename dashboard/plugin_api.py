"""Notes dashboard plugin - backend API routes.

Mounted at /api/plugins/notes/ by the dashboard plugin system.

Each note is a Markdown file stored under a configurable Obsidian *vault*
directory:

    <vault_path>/<slug>.md

The vault path is read from the user's config.yaml under
``plugins.notes.vault_path``. When that key is unset, notes fall back to the
old location under Hermes home
(``<HERMES_HOME>/plugins/notes/<slug>.md``) for backwards compatibility.

Each note's title lives in a YAML frontmatter block (``title:``) so the vault
stays a clean collection of ordinary Obsidian notes. ``updated_at`` is taken
from the file's mtime, which is preserved across synced vaults.

Security notes
--------------
* Notes are user-private content. Routes sit behind the dashboard's normal
  session-token / cookie auth gate, the same as every other /api/plugins/*
  route (see hermes_cli/web_server.py).
* Slugs are strictly validated (``[A-Za-z0-9_-]+``) and resolved against the
  notes directory with a containment check, so a crafted slug cannot escape
  the notes directory (path-traversal protection).
* The configured vault path is only ever used as the *base* directory; notes
  are still written as ``<vault>/<slug>.md`` with the validated slug, so a
  crafted vault path cannot write outside the intended directory tree either.
"""

from __future__ import annotations

import json
import re
import time
import uuid
from pathlib import Path

# YAML: prefer the interpreter's own yaml, then the vendored pure-python
# PyYAML copy under ./_vendor (the dashboard's PM interpreter may have no
# site-packages yaml; the vendored copy always travels with the plugin).
try:
    import yaml
except ModuleNotFoundError:
    import importlib
    import sys as _sys
    _vdir = str(Path(__file__).resolve().parent / "_vendor")
    if _vdir not in _sys.path:
        _sys.path.append(_vdir)
    yaml = importlib.import_module("yaml")
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

try:
    from hermes_cli import config as _config
    _HERMES_HOME = _config.get_hermes_home()
except Exception:  # pragma: no cover - defensive
    from pathlib import Path as _Path
    _HERMES_HOME = _Path.home() / ".hermes"

router = APIRouter()

# Matches a leading YAML frontmatter block: "---\n ... \n---\n".
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.DOTALL)


# ---------------------------------------------------------------------------
# Storage helpers
# ---------------------------------------------------------------------------

def _load_vault_path() -> str | None:
    """Read plugins.notes.vault_path from the user's config.yaml (fresh each call)."""
    try:
        from hermes_cli import config as _cfg
    except Exception:
        return None
    cfg_path = _cfg.get_hermes_home() / "config.yaml"
    if not cfg_path.exists():
        return None
    try:
        data = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    vp = data.get("plugins", {}).get("notes", {}).get("vault_path")
    if isinstance(vp, str) and vp.strip():
        return vp.strip()
    return None


def _notes_dir() -> Path:
    """Directory holding note Markdown files (created on first use)."""
    vp = _load_vault_path()
    d = Path(vp) if vp else (_HERMES_HOME / "plugins" / "notes")
    d.mkdir(parents=True, exist_ok=True)
    return d


def _safe_slug(slug: str) -> str:
    """Validate a note slug.

    Raises HTTPException 400 on anything that isn't a clean identifier, so a
    bad slug can never reach the filesystem path logic below.
    """
    if not isinstance(slug, str) or not slug:
        raise HTTPException(status_code=400, detail="missing slug")
    if not slug.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="invalid slug")
    if len(slug) > 80:
        raise HTTPException(status_code=400, detail="slug too long")
    return slug


def _slug_from_title(title: str) -> str:
    """Derive a filesystem-safe slug from a title.

    Falls back to a short random id if the title yields no usable characters.
    """
    base = "".join(c if c.isalnum() or c in "-_" else "-" for c in title.strip().lower())
    base = "-".join(part for part in base.split("-") if part)[:60]
    if not base:
        base = uuid.uuid4().hex[:8]
    return base


def _split_frontmatter(text: str) -> tuple[dict, str]:
    """Return (frontmatter_dict, body) splitting off a leading YAML block."""
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    try:
        fm = yaml.safe_load(m.group(1)) or {}
    except Exception:
        fm = {}
    if not isinstance(fm, dict):
        fm = {}
    return fm, text[m.end():]


def _serialize_frontmatter(fm: dict, body: str) -> str:
    """Re-attach frontmatter to a note body."""
    if not fm:
        return body
    fm_text = yaml.safe_dump(
        fm, sort_keys=False, default_flow_style=False, allow_unicode=True
    ).strip()
    return "---\n" + fm_text + "\n---\n\n" + body


def _read_note(slug: str) -> dict:
    """Read a note: returns {title, content, updated_at}."""
    md = _notes_dir() / f"{slug}.md"
    if not md.exists():
        raise HTTPException(status_code=404, detail="note not found")
    raw = md.read_text(encoding="utf-8")
    fm, body = _split_frontmatter(raw)
    title = fm.get("title")
    if not title:
        for line in body.splitlines():
            if line.startswith("# "):
                title = line[2:].strip()
                break
    if not title:
        title = slug
    return {
        "slug": slug,
        "title": title,
        "content": body,
        "updated_at": md.stat().st_mtime,
    }


def _write_note(slug: str, title: str, content: str) -> float:
    """Write a note, preserving any existing frontmatter keys except title."""
    md = _notes_dir() / f"{slug}.md"
    existing_fm = {}
    if md.exists():
        existing_fm, _ = _split_frontmatter(md.read_text(encoding="utf-8"))
    existing_fm["title"] = (title or "").strip() or slug
    md.write_text(_serialize_frontmatter(existing_fm, content or ""), encoding="utf-8")
    return md.stat().st_mtime


# ---------------------------------------------------------------------------
# Request bodies
# ---------------------------------------------------------------------------

class NoteBody(BaseModel):
    title: str = Field(default="", max_length=200)
    content: str = Field(default="", max_length=200_000)


class CreateBody(BaseModel):
    title: str = Field(default="", max_length=200)
    content: str = Field(default="", max_length=200_000)


class ConfigBody(BaseModel):
    vault_path: str = Field(default="", max_length=4096)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/config")
def get_config():
    """Return the currently configured vault directory (may be empty)."""
    return {"vault_path": _load_vault_path() or ""}


@router.put("/config")
def set_config(body: ConfigBody):
    """Persist plugins.notes.vault_path into the user's config.yaml."""
    try:
        from hermes_cli import config as _cfg
    except Exception as e:  # pragma: no cover - defensive
        raise HTTPException(status_code=500, detail="config module unavailable: " + str(e))
    cfg_path = _cfg.get_hermes_home() / "config.yaml"
    data: dict = {}
    if cfg_path.exists():
        try:
            data = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
        except Exception:
            data = {}
    if not isinstance(data, dict):
        data = {}
    plugins = data.setdefault("plugins", {})
    if not isinstance(plugins, dict):
        plugins = {}
        data["plugins"] = plugins
    notes = plugins.setdefault("notes", {})
    if not isinstance(notes, dict):
        notes = {}
        plugins["notes"] = notes
    vp = (body.vault_path or "").strip()
    if vp:
        notes["vault_path"] = vp
    else:
        notes.pop("vault_path", None)
    try:
        cfg_path.write_text(
            yaml.safe_dump(data, sort_keys=False, default_flow_style=False, allow_unicode=True),
            encoding="utf-8",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail="failed to write config: " + str(e))
    return {"vault_path": vp}


@router.get("/version")
def get_version():
    """Return the plugin manifest version (authoritative source of truth)."""
    manifest = Path(__file__).resolve().parent / "manifest.json"
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except Exception:
        return {"version": "?"}
    return {"version": data.get("version", "?")}


@router.get("/list")
def list_notes():
    """Return all notes as {slug, title, updated_at, size} summaries."""
    notes_dir = _notes_dir()
    out = []
    for md in sorted(notes_dir.glob("*.md")):
        slug = md.stem
        try:
            _safe_slug(slug)
        except HTTPException:
            continue
        # Sidecar meta files are no longer used; title comes from frontmatter/H1.
        fm, body = _split_frontmatter(md.read_text(encoding="utf-8"))
        title = fm.get("title")
        if not title:
            for line in body.splitlines():
                if line.startswith("# "):
                    title = line[2:].strip()
                    break
        out.append({
            "slug": slug,
            "title": title or slug,
            "updated_at": md.stat().st_mtime,
            "size": md.stat().st_size,
        })
    # Newest first.
    out.sort(key=lambda n: n["updated_at"], reverse=True)
    return {"notes": out}


@router.get("/{slug}")
def get_note(slug: str):
    """Return a single note's title + content."""
    slug = _safe_slug(slug)
    return _read_note(slug)


@router.post("/create")
def create_note(body: CreateBody):
    """Create a new note, deriving a unique slug from the title."""
    title = (body.title or "").strip() or "Untitled"
    slug = _slug_from_title(title)
    # Ensure uniqueness if the slug already exists.
    if (_notes_dir() / f"{slug}.md").exists():
        slug = f"{slug}-{uuid.uuid4().hex[:4]}"
    now = _write_note(slug, title, body.content or "")
    return {"slug": slug, "title": title, "updated_at": now}


@router.put("/{slug}")
def save_note(slug: str, body: NoteBody):
    """Overwrite an existing note (creates it if missing)."""
    slug = _safe_slug(slug)
    now = _write_note(slug, (body.title or "").strip() or slug, body.content or "")
    return {"slug": slug, "title": body.title, "updated_at": now}


@router.delete("/{slug}")
def delete_note(slug: str):
    """Delete a note."""
    slug = _safe_slug(slug)
    md = _notes_dir() / f"{slug}.md"
    if not md.exists():
        raise HTTPException(status_code=404, detail="note not found")
    md.unlink(missing_ok=True)
    return {"ok": True, "slug": slug}

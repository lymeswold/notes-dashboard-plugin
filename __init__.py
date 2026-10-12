"""notes dashboard plugin - manifest-only marker.

The dashboard UI lives in ``dashboard/`` (dist JS/CSS + FastAPI backend in
``dashboard/plugin_api.py``) and is mounted by the web server at
``/api/plugins/notes/``. This register() intentionally registers no tools or
hooks: the plugin is dashboard-only.
"""


def register(ctx):
    """No tools or hooks: the plugin is dashboard-only."""
    return

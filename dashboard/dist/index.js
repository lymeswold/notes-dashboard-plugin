/*
 * Notes dashboard plugin - UI bundle (plain IIFE, no build step).
 *
 * Uses window.__HERMES_PLUGIN_SDK__ for React + UI primitives. Renders a
 * two-pane notes manager: a sidebar list of named Markdown notes and a
 * split editor / live-preview pane. Content persists via the plugin's
 * FastAPI backend (/api/plugins/notes/...).
 *
 * Notes are stored as individual Markdown files inside a configurable
 * Obsidian vault directory (see the "Vault" settings). The same vault can be
 * mounted by several Dashboard instances, so notes are shared across them.
 */
(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  var REG = window.__HERMES_PLUGINS__;
  if (!SDK || !REG) {
    // SDK not ready - nothing we can do but bail.
    return;
  }

  var React = SDK.React;
  var useState = SDK.hooks.useState;
  var useEffect = SDK.hooks.useEffect;
  var useRef = SDK.hooks.useRef;
  var useCallback = SDK.hooks.useCallback;
  var fetchJSON = SDK.fetchJSON;
  var components = SDK.components;
  var Card = components.Card;
  var CardHeader = components.CardHeader;
  var CardTitle = components.CardTitle;
  var CardContent = components.CardContent;
  var Button = components.Button;
  var Input = components.Input;
  var Badge = components.Badge;
  var cn = SDK.utils.cn;

  // -----------------------------------------------------------------------
  // Tiny, safe Markdown renderer.
  //
  // We deliberately do NOT use dangerouslySetInnerHTML with arbitrary HTML.
  // Instead we build a React element tree from parsed blocks/inline tokens,
  // so user content can never inject script/event-handler attributes. This
  // keeps the bundle dependency-free (no CDN, no bundler needed).
  // -----------------------------------------------------------------------

  function renderInline(text) {
    // text is already HTML-escaped here. We parse inline tokens into React
    // nodes, preserving order.
    var nodes = [];
    var i = 0;
    var key = 0;
    // Order matters: code spans first (so their contents aren't re-parsed),
    // then links, bold, italic.
    var re = /(`[^`]+`)|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
    var last = 0;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) {
        nodes.push(text.slice(last, m.index));
      }
      var tok = m[0];
      if (m[1]) {
        nodes.push(React.createElement("code", { key: key++ }, tok.slice(1, -1)));
      } else if (m[2]) {
        var lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
        if (lm) {
          nodes.push(
            React.createElement(
              "a",
              { key: key++, href: lm[2], target: "_blank", rel: "noopener noreferrer" },
              lm[1]
            )
          );
        } else {
          nodes.push(tok);
        }
      } else if (m[3]) {
        nodes.push(React.createElement("strong", { key: key++ }, tok.slice(2, -2)));
      } else if (m[4]) {
        nodes.push(React.createElement("em", { key: key++ }, tok.slice(1, -1)));
      }
      last = m.index + tok.length;
    }
    if (last < text.length) {
      nodes.push(text.slice(last));
    }
    return nodes;
  }

  function parseMarkdown(md) {
    var lines = md.replace(/\r\n/g, "\n").split("\n");
    var blocks = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];

      // Fenced code block
      if (/^```/.test(line)) {
        var lang = line.slice(3).trim();
        var code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          code.push(lines[i]);
          i++;
        }
        i++; // skip closing fence
        blocks.push({ type: "code", text: code.join("\n"), lang: lang });
        continue;
      }

      // Heading
      var h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        blocks.push({ type: "h", level: h[1].length, text: h[2] });
        i++;
        continue;
      }

      // Blockquote (consecutive > lines)
      if (/^>\s?/.test(line)) {
        var quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^>\s?/, ""));
          i++;
        }
        blocks.push({ type: "quote", text: quote.join("\n") });
        continue;
      }

      // Horizontal rule
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
        blocks.push({ type: "hr" });
        i++;
        continue;
      }

      // Table (header row + separator row)
      if (line.indexOf("|") !== -1 && i + 1 < lines.length &&
          /^\s*\|?[-:\s|]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].indexOf("-") !== -1) {
        var headerCells = splitRow(line);
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].indexOf("|") !== -1) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        blocks.push({ type: "table", header: headerCells, rows: rows });
        continue;
      }

      // Lists (unordered / ordered), gathering consecutive items
      if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
        var items = [];
        var ordered = /^\s*\d+\.\s+/.test(line);
        while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""));
          i++;
        }
        blocks.push({ type: "list", ordered: ordered, items: items });
        continue;
      }

      // Blank line
      if (line.trim() === "") {
        i++;
        continue;
      }

      // Paragraph (gather until blank / block start)
      var para = [];
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !/^```/.test(lines[i]) &&
        !/^(#{1,6})\s+/.test(lines[i]) &&
        !/^>\s?/.test(lines[i]) &&
        !/^\s*([-*]|\d+\.)\s+/.test(lines[i]) &&
        !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim())
      ) {
        para.push(lines[i]);
        i++;
      }
      blocks.push({ type: "p", text: para.join(" ") });
    }
    return blocks;
  }

  function splitRow(row) {
    var r = row.trim().replace(/^\|/, "").replace(/\|$/, "");
    return r.split("|").map(function (c) { return c.trim(); });
  }

  function MarkdownPreview(props) {
    var blocks = parseMarkdown(props.markdown || "");
    return React.createElement(
      "div",
      { className: "notes-preview" },
      blocks.map(function (b, idx) {
        switch (b.type) {
          case "h":
            var Tag = "h" + b.level;
            return React.createElement(Tag, { key: idx }, renderInline(b.text));
          case "code":
            return React.createElement(
              "pre",
              { key: idx },
              React.createElement("code", null, b.text)
            );
          case "quote":
            return React.createElement(
              "blockquote",
              { key: idx },
              parseMarkdown(b.text).map(function (ib, j) {
                return React.createElement("div", { key: j }, renderInline(ib.text));
              })
            );
          case "hr":
            return React.createElement("hr", { key: idx });
          case "list":
            var L = b.ordered ? "ol" : "ul";
            return React.createElement(
              L,
              { key: idx },
              b.items.map(function (it, j) {
                return React.createElement("li", { key: j }, renderInline(it));
              })
            );
          case "table":
            return React.createElement(
              "table",
              { key: idx },
              React.createElement(
                "thead",
                null,
                React.createElement(
                  "tr",
                  null,
                  b.header.map(function (c, j) {
                    return React.createElement("th", { key: j }, renderInline(c));
                  })
                )
              ),
              React.createElement(
                "tbody",
                null,
                b.rows.map(function (row, ri) {
                  return React.createElement(
                    "tr",
                    { key: ri },
                    row.map(function (c, j) {
                      return React.createElement("td", { key: j }, renderInline(c));
                    })
                  );
                })
              )
            );
          case "p":
          default:
            return React.createElement("p", { key: idx }, renderInline(b.text));
        }
      })
    );
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  function timeAgo(ts) {
    if (!ts) return "";
    var diff = Math.floor(Date.now() / 1000 - ts);
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    return Math.floor(diff / 86400) + "d ago";
  }

  // -----------------------------------------------------------------------
  // Main page component
  // -----------------------------------------------------------------------

  function NotesPage() {
    var [notes, setNotes] = useState([]);
    var [activeSlug, setActiveSlug] = useState(null);
    var [title, setTitle] = useState("");
    var [content, setContent] = useState("");
    // Editor pane is hidden by default and revealed via a small "Edit" link.
    var [editorOpen, setEditorOpen] = useState(false);
    var [loading, setLoading] = useState(true);
    var [saving, setSaving] = useState(false);
    var [saved, setSaved] = useState(false);
    var [error, setError] = useState(null);
    // Configured Obsidian vault directory (empty until the user sets one).
    var [vaultPath, setVaultPath] = useState("");
    var [settingsOpen, setSettingsOpen] = useState(false);
    var [vaultInput, setVaultInput] = useState("");
    var [configSaving, setConfigSaving] = useState(false);
    // Plugin manifest version, shown in a tiny footer so you can confirm which
    // build is running on a given instance.
    var [pluginVersion, setPluginVersion] = useState("");

    var saveTimer = useRef(null);

    var loadConfig = useCallback(function () {
      return fetchJSON("/api/plugins/notes/config")
        .then(function (c) { setVaultPath(c.vault_path || ""); return c.vault_path || ""; })
        .catch(function () { return ""; });
    }, []);

    var loadVersion = useCallback(function () {
      return fetchJSON("/api/plugins/notes/version")
        .then(function (c) { setPluginVersion(c.version || ""); return c.version || ""; })
        .catch(function () { return ""; });
    }, []);

    var loadList = useCallback(function () {
      return fetchJSON("/api/plugins/notes/list")
        .then(function (data) {
          setNotes(data.notes || []);
          return data.notes || [];
        })
        .catch(function (e) {
          setError("Could not load notes: " + e.message);
          return [];
        });
    }, []);

    useEffect(function () {
      setLoading(true);
      loadConfig()
        .then(function () {
          return loadVersion();
        })
        .then(function () {
          return loadList().then(function (list) {
            setLoading(false);
            if (list.length && activeSlug === null) {
              openNote(list[0].slug);
            }
          });
        })
        .catch(function () {
          setLoading(false);
        });
    }, []);

    var openNote = useCallback(function (slug) {
      setActiveSlug(slug);
      setError(null);
      setSaved(false);
      setEditorOpen(false);
      fetchJSON("/api/plugins/notes/" + encodeURIComponent(slug))
        .then(function (n) {
          setTitle(n.title || "");
          setContent(n.content || "");
        })
        .catch(function (e) {
          setError("Could not open note: " + e.message);
        });
    }, []);

    var scheduleSave = useCallback(function (nextTitle, nextContent, slug) {
      if (!slug) return;
      setSaving(true);
      setSaved(false);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(function () {
        fetchJSON("/api/plugins/notes/" + encodeURIComponent(slug), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: nextTitle, content: nextContent }),
        })
          .then(function () {
            setSaving(false);
            setSaved(true);
            // Refresh list timestamps.
            loadList();
          })
          .catch(function (e) {
            setSaving(false);
            setError("Save failed: " + e.message);
          });
      }, 600);
    }, [loadList]);

    var onCreate = useCallback(function () {
      fetchJSON("/api/plugins/notes/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New note", content: "# New note\n\nStart writing..." }),
      })
        .then(function (n) {
          return loadList().then(function () { openNote(n.slug); });
        })
        .then(function () { setEditorOpen(true); })
        .catch(function (e) {
          setError("Create failed: " + e.message);
        });
    }, [loadList, openNote]);

    var onDelete = useCallback(function (slug) {
      if (!confirm("Delete this note? This cannot be undone.")) return;
      fetchJSON("/api/plugins/notes/" + encodeURIComponent(slug), { method: "DELETE" })
        .then(function () {
          setActiveSlug(null);
          setTitle("");
          setContent("");
          setEditorOpen(false);
          loadList();
        })
        .catch(function (e) {
          setError("Delete failed: " + e.message);
        });
    }, [loadList]);

    var onTitleChange = useCallback(function (e) {
      var v = e.target.value;
      setTitle(v);
      scheduleSave(v, content, activeSlug);
    }, [content, activeSlug, scheduleSave]);

    var onContentChange = useCallback(function (e) {
      var v = e.target.value;
      setContent(v);
      scheduleSave(title, v, activeSlug);
    }, [title, activeSlug, scheduleSave]);

    var toggleSettings = useCallback(function () {
      setSettingsOpen(function (open) {
        var next = !open;
        if (next) setVaultInput(vaultPath);
        return next;
      });
    }, [vaultPath]);

    var onSaveConfig = useCallback(function () {
      setConfigSaving(true);
      setError(null);
      fetchJSON("/api/plugins/notes/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vault_path: vaultInput }),
      })
        .then(function (c) {
          setVaultPath(c.vault_path || "");
          setConfigSaving(false);
          setSettingsOpen(false);
          // Reload the list from the (possibly new) vault.
          setLoading(true);
          return loadList().then(function (list) {
            setLoading(false);
            if (list.length && activeSlug === null) openNote(list[0].slug);
          });
        })
        .catch(function (e) {
          setConfigSaving(false);
          setError("Could not save vault path: " + e.message);
        });
    }, [vaultInput, loadList, openNote]);

    var active = notes.find(function (n) { return n.slug === activeSlug; });

    return React.createElement(
      Card,
      { className: "w-full" },
      React.createElement(
        CardHeader,
        null,
        React.createElement(
          CardTitle,
          null,
          "Notes",
          saving
            ? React.createElement(Badge, { className: "ml-2" }, "saving...")
            : saved
            ? React.createElement(Badge, { className: "ml-2" }, "saved")
            : null
        ),
        React.createElement(
          "div",
          { className: "notes-header-actions" },
          React.createElement(
            Button,
            { size: "sm", variant: "ghost", onClick: toggleSettings },
            vaultPath ? "Vault" : "Set vault"
          )
        )
      ),
      React.createElement(
        CardContent,
        null,
        error
          ? React.createElement("div", { className: "notes-empty", style: { color: "var(--color-destructive)" } }, error)
          : null,
        settingsOpen
          ? React.createElement(
              "div",
              { className: "notes-settings" },
              React.createElement(
                "div",
                { className: "notes-settings-row" },
                React.createElement(Input, {
                  className: "notes-vault-input",
                  value: vaultInput,
                  placeholder: "/path/to/obsidian/vault (e.g. /home/cn/Documents/main-vault/Obsidian/vaults/main vault/hermes-dashboard)",
                  onChange: function (e) { setVaultInput(e.target.value); },
                }),
                React.createElement(
                  Button,
                  { size: "sm", onClick: onSaveConfig, disabled: configSaving },
                  configSaving ? "Saving..." : "Save"
                )
              ),
              React.createElement(
                "div",
                { className: "notes-settings-hint" },
                vaultPath
                  ? "Notes are stored in: " + vaultPath
                  : "Enter the directory of the Obsidian vault to share notes across Dashboard instances, then save."
              )
            )
          : null,
        !vaultPath && !settingsOpen
          ? React.createElement(
              "div",
              { className: "notes-empty" },
              "No Obsidian vault configured. Click “Set vault” above to choose where notes are stored."
            )
          : null,
        React.createElement(
          "div",
          { className: "notes-layout" },
          // Sidebar
          React.createElement(
            "div",
            { className: "notes-sidebar" },
            React.createElement(
              "div",
              { className: "notes-sidebar-header" },
              React.createElement("span", { className: "text-sm text-muted-foreground" }, notes.length + " notes"),
              React.createElement(Button, { size: "sm", onClick: onCreate }, "+ New")
            ),
            loading
              ? React.createElement("div", { className: "notes-empty" }, "Loading...")
              : notes.length === 0
              ? React.createElement("div", { className: "notes-empty" }, "No notes yet. Click + New.")
              : notes.map(function (n) {
                  return React.createElement(
                    "div",
                    {
                      key: n.slug,
                      className: cn("notes-list-item", n.slug === activeSlug && "active"),
                      onClick: function () { openNote(n.slug); },
                    },
                    React.createElement(
                      "div",
                      { style: { minWidth: 0, flex: 1 } },
                      React.createElement("div", { className: "notes-list-title" }, n.title),
                      React.createElement("div", { className: "notes-list-time" }, timeAgo(n.updated_at))
                    ),
                    React.createElement(
                      Button,
                      {
                        size: "sm",
                        variant: "ghost",
                        onClick: function (ev) { ev.stopPropagation(); onDelete(n.slug); },
                      },
                      "Delete"
                    )
                  );
                })
          ),
          // View + (hidden) editor pane
          React.createElement(
            "div",
            { style: { minWidth: 0 } },
            activeSlug
              ? React.createElement(
                  React.Fragment,
                  null,
                  React.createElement(
                    "div",
                    { className: "notes-view-header" },
                    React.createElement("div", { className: "notes-view-title" }, title || "Untitled"),
                    React.createElement(
                      Button,
                      { size: "sm", variant: "ghost", onClick: function () { setEditorOpen(function (o) { return !o; }); } },
                      editorOpen ? "Hide editor" : "Edit"
                    )
                  ),
                  editorOpen
                    ? React.createElement(
                        React.Fragment,
                        null,
                        React.createElement(Input, {
                          className: "notes-editor-title",
                          value: title,
                          placeholder: "Note title",
                          onChange: onTitleChange,
                        }),
                        React.createElement("textarea", {
                          className: "notes-textarea",
                          value: content,
                          placeholder: "Write Markdown here...",
                          onChange: onContentChange,
                        })
                      )
                    : null,
                  React.createElement(MarkdownPreview, { markdown: content })
                )
              : React.createElement(
                  "div",
                  { className: "notes-empty" },
                  loading ? "Loading..." : "Select a note or create one."
                )
          )
        )
      ),
      pluginVersion
        ? React.createElement(
            "div",
            { className: "notes-version" },
            "notes v" + pluginVersion
          )
        : null
    );
  }

  REG.register("notes", NotesPage);
})();

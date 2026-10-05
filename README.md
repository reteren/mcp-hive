# hive-mcp

An [MCP](https://modelcontextprotocol.io) server for **hive** — a spatial board for notes, tasks and ideas (an Obsidian-style app where notes live on an infinite canvas).

It lets an AI assistant (Claude Desktop, Claude Code, Codex, Cursor, …) read your board and work on it: create notes and every other node kind, write Markdown, link nodes into mind maps, group them into zones, mark tasks, import files and arrange everything — **through the running hive app**, so changes appear instantly, follow hive's own rules and can be undone with Ctrl+Z (each tool call is one undo step, labelled `MCP: …`).

> Early beta, made for fun. Expect breaking changes.

## Requirements

- hive **1.7.1 or newer** with *Settings → AI tools → Allow AI tools (MCP)* enabled (on by default).
- Node.js 20+.

When hive is closed, the read tools still work on the last opened project folder (read-only); writing needs hive running.

## Install

```bash
git clone https://github.com/reteren/hive-mcp.git
cd hive-mcp
npm install   # also builds dist/
```

### Claude Code

```bash
claude mcp add hive -- node "C:/path/to/hive-mcp/dist/index.js"
```

### Claude Desktop / other clients (JSON config)

```json
{
  "mcpServers": {
    "hive": {
      "command": "node",
      "args": ["C:/path/to/hive-mcp/dist/index.js"]
    }
  }
}
```

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.hive]
command = "node"
args = ["C:/path/to/hive-mcp/dist/index.js"]
```

## Tools

| Tool | What it does |
| --- | --- |
| `get_status` | Running?, open project, counts, visible area, selection |
| `describe_node_kinds` | Every node kind with its fields and allowed values |
| `list_nodes`, `get_nodes`, `search_nodes` | Find and read nodes (full Markdown text, links, zone) |
| `read_node_content` | What is inside nodes: images/GIFs and inline pictures as real images, text/code files, PDF text, audio/video details with a poster frame, module data, and YouTube links expanded (title, channel, description, thumbnail, transcript) |
| `read_youtube` | Any YouTube link: metadata, thumbnail and transcript |
| `view_board` | Screenshot of the board (current view or around given nodes) |
| `get_board_overview` | Map of the whole project: zones, clusters, kinds, media, tasks |
| `create_nodes` | Create any number of nodes of any kind + links in one step, auto-placed without overlaps (`row`, `column`, `grid`, `tree`) |
| `update_nodes` | Rename, edit text precisely (find/replace, append, prepend), move, resize, colours, glow, task, importance, purposes, moods, kind data |
| `delete_nodes`, `restore_from_trash`, `list_trash`, `list_archive` | Delete like the Delete key (to Trash) and bring back |
| `move_nodes`, `arrange_nodes` | Exact positions or automatic layouts |
| `list_links`, `create_links`, `update_links`, `delete_links` | Lines between nodes |
| `list_zones`, `create_zone`, `update_zone`, `delete_zones` | Coloured areas grouping nodes |
| `import_file` | Add a file from disk exactly like dropping it on the board |
| `focus_view` | Move hive's camera to show nodes |
| `undo_last_change` | Undo the last MCP change |
| `save_project` | Flush pending saves |

## Prompts

- `study_project` — walks the assistant through the whole project (overview, screenshots, every node's content incl. images, PDFs and YouTube) and asks for a structured summary.

## How it works

hive opens a local TCP listener on `127.0.0.1` (random port) protected by a random per-launch token, and writes both to `mcp-bridge.json` in its config folder (`%APPDATA%\dev.hive.app` on Windows). This server reads that file, connects, and forwards each tool call to hive, which executes it with the same code the UI uses. Nothing leaves your machine. Turning the setting off closes the listener and deletes the file.

Environment overrides: `HIVE_CONFIG_DIR` (where to find `mcp-bridge.json` / `last-project.json`), `HIVE_PROJECT_DIR` (project folder for read-only mode).

## Development

```bash
npm run check   # types
npm test        # unit tests (fake hive bridge, offline reader)
npm run build
```

## License

MIT

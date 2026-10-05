# Changelog

## 0.2.0 — 2026-10-05

Needs hive 1.7.1+.

- `read_node_content`: images and GIFs (also inline pictures) as real images, text/code files, PDF page text, audio/video details and poster frames, module data, YouTube links expanded with title, channel, description, thumbnail and transcript.
- `read_youtube`, `view_board` (board screenshot), `get_board_overview`.
- `study_project` prompt.
- Read-only fallback also returns images and text files while hive is closed.

## 0.1.0 — 2026-10-05

First release. Needs hive 1.7.0+.

- 25 tools: status, node kinds, list/get/search nodes, create/update/delete/move/arrange nodes of every kind, links, zones, file import, trash, camera focus, undo, save.
- Live mode through hive's local bridge (one tool call = one undo step in hive).
- Read-only fallback on the last opened project while hive is closed.

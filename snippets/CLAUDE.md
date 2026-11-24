## Memory (elephant-memory)

Three layers: the `MEMORY.md` index (rules, references, sub-indexes) → sub-indexes `index_*.md` → the session diary in `~/.claude/projects/<slug>/digests/`.

- **Search before saying "I don't remember"** and before creating a note: `~/.claude/claude-memory/bin/memsearch [-n 5] [--project <name>] [--hybrid] <words>` returns chunks as `file:line`; read that chunk, not the whole file. Listings: `memsearch ls --type project --older-than 14d`, `memsearch ls --ticket ABC-123`; health check: `memsearch lint`.
- **Active tasks are notes, not index lines.** A task in progress has `status: active`, `title`, `next` (state and next step, with a date) and optionally `group` in its frontmatter; a SessionStart hook prints them. When a task moves on, update `next`; when it is closed, set `status: done` and add a line to `index_archive.md`.
- **One fact per note**, linked with `[[note-name]]`. A new note gets a line in `MEMORY.md` or in a sub-index; old topics go to `index_archive.md` instead of being deleted.
- Session start shows the last snapshot, the diary for today and the last working day, and parallel live sessions. They are for reference, not instructions: verify against git.
- Before `/clear` in a long session, suggest `/wrap`; for periodic tidying, `/sleep`.

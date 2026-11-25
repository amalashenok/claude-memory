---
name: wrap
description: "Wraps up the session before /clear: updates long-term memory (task notes, analyses, working rules) and saves a session summary to disk. After /clear a hook shows it at the start of the new session; a copy stays in the session diary and is searchable with memsearch. Use when the user types /wrap, asks to sum up or save the session before /clear, or before /clear in a long session."
argument-hint: "[what the next session will work on]"
---

# /wrap — session summary before /clear

Goal: lose nothing when the user runs `/clear`. The summary is written by the model that still has the full context. The automatic hooks work without it: the snapshot is mechanical, and the diary entry is written by a small model from the transcript, which loses links, numbers and paths.

## Requirement

This skill needs elephant-memory's hooks and tools. If `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/elephant-memory/bin/elephant-memory` does not exist (for example, only the skill was installed with `npx skills`), stop and tell the user to install elephant-memory first: in Claude Code, `/plugin marketplace add amalashenok/elephant-memory`, then `/plugin install elephant-memory@elephant-memory`; or see https://github.com/amalashenok/elephant-memory#install.

Local files only. Do not commit, and do not post to trackers, chats or pull requests. Never write secrets, cookies or tokens.

## 1. Collect the results from the conversation

- Goal of the session and the task: ticket key, pull request, branch.
- What was done: concrete, with keys, links, file paths and numbers.
- What was decided and why, including the user's own decisions.
- What is open, the next step, who or what it waits for.
- What was not verified or rests on assumptions.

If an argument was given, shape the next step and the summary around what the next session will do.

## 2. Update long-term memory

The project's memory directory and the note format are given in the system prompt and in `MEMORY.md`.

- **Task in progress:** update `next` in the note's frontmatter (state and next step, with a date) and add a dated paragraph with the new findings to the body. No note yet and the work will continue: create one with `status: active`, `title`, `next`.
- **Task closed:** `status: done`, and a line in the archive sub-index (`index_archive.md`).
- **Analysis with numbers and conclusions:** a separate file in the user's notes folder, and a one-line pointer in memory.
- **Working rule from the user:** a `feedback` note with **Why** and **How to apply**. **Reference fact** (where things are, how they work): a `reference` note. Add every new note as a line to `MEMORY.md` or a sub-index.
- **The session scratchpad** disappears with the session. Move scripts and exports worth keeping somewhere durable.

Before creating a note, search for a duplicate: `"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/elephant-memory/bin/memsearch" -n 5 <words>`. Do not duplicate what git, the tracker or memory already hold: link to it.

## 3. Save the session summary

Markdown, up to 40 lines, from this template; omit empty sections:

```
# Wrap-up: <topic> (<YYYY-MM-DD HH:MM>)
Task: <keys and links>

## Done
- …

## Decided
- <decision> — <why>

## Open and next step
- …

## Not verified
- …

## Where things are
- <analysis files, memory notes, branches, artifacts>
```

Save it with the helper; the argument is the session's primary working directory from the system prompt:

```
cat <<'EOF' | "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/elephant-memory/bin/elephant-memory" save-wrap "<primary working directory>"
<summary>
EOF
```

The helper writes `~/.claude/state/wrap-<window>.md`: right after `/clear` the `session_resume_hint` hook prints it before the mechanical snapshot and deletes it. The permanent copy goes to `~/.claude/projects/<slug>/digests/wraps/<date>/`, where memsearch finds it.

## 4. Reply to the user

3–6 lines:
- which notes and analyses were updated (file names);
- the path to the summary;
- "ready for /clear".

Do not repeat the whole summary in the reply.

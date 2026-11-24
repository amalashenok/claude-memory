---
name: sleep
description: "Sleep-time consolidation of project memory: tidies the memory notes (duplicates, stale facts, contradictions, broken links, index drift), mines the latest session transcript for durable facts, feedback and the user's own terms, checks that the session diary is complete, reconciles task notes against git, and regenerates REGISTRY.md. Use when the user types /sleep, asks to consolidate or tidy memory, or runs an end-of-day routine."
---

# /sleep — consolidate memory, tidy the notes

This is the agent's "sleep": a quiet pass over what the project has accumulated. It is housekeeping, not new work. Do not touch project code, do not commit, and keep the final report to 5–8 lines.

## 0. Resolve paths (do not ask the user)

```bash
CLAUDE_HOME="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SLUG=$(pwd | sed 's#[^A-Za-z0-9]#-#g')          # /home/me/projects/shop -> -home-me-projects-shop
ROOT="$CLAUDE_HOME/projects/$SLUG"
MEM="$ROOT/memory"                               # notes + MEMORY.md
DIGESTS="$ROOT/digests"                          # session diary
LATEST=$(ls -t "$ROOT"/*.jsonl 2>/dev/null | head -1)   # transcript of the current or last session
TOOLS="$CLAUDE_HOME/claude-memory/bin"
```

If `$MEM` does not exist, there is no memory yet: skip steps 1–2 and 2a.
`$LATEST` is the current transcript. Running /sleep is not itself a finding.

## 1. Tidy memory

Read `MEMORY.md` (the index) and go through `memory/*.md`. Look for and fix:

- **Duplicates** — two notes about the same thing. Merge into one, delete the other, fix the index line.
- **Stale facts** — a state that no longer holds (PR merged, branch deleted, ticket closed). If the fact is dead, delete the note and its index line; if it just moved on, update it.
- **Contradictions** — two notes claim different things. Resolve, keep the correct one.
- **Broken links** — `[[slug]]` or `(file.md)` pointing nowhere. Run `$TOOLS/memsearch lint --project "$SLUG"`: it lists broken links, notes without a description or with a bad type, and orphans missing from the index.
- **Index drift** — a note without an index line, or an index line without a note. Exception: active tasks are not listed in `MEMORY.md`; they carry `status: active`, `title`, `next` (optionally `group`) in the frontmatter and the `active_tasks` hook prints them at session start. A closed task gets `status: done` and a line in `index_archive.md`; a task that moved on gets a new `next`.
- **Relative dates** — "yesterday", "last week" → absolute dates.

Edit conservatively: when in doubt, leave it and report it as "needs a decision". Never delete what you cannot prove dead.

## 2. Findings from the conversation

Read `$LATEST`. Extract only what **outlives the session** and is not written down yet:

- A lasting preference about style or process → `type: feedback` (with **Why** / **How to apply**).
- A fact about the user, the team or the project that cannot be derived from code or git → `type: user` / `project`.
- A decision on a task, a new state, a parked question → `type: project`.

Do not record what memory, the code, CLAUDE.md or git already hold, or anything momentary. When unsure whether it lasts, skip it. Before writing, check for a note to extend instead. Each new note gets a line in `MEMORY.md`, except an active task (see step 1). Link related notes with `[[slug]]`.

## 2a. The user's lexicon

A separate pass over `$LATEST` for the **terms and phrasings the user uses**. The goal is to talk to the user in their words instead of translating them into yours.

Collect:

- **A domain word instead of a generic one**, especially when the user replaced your word with theirs.
- **Phrases the user uses to set tasks** — record the meaning, not the fact of use.
- **Rejected words** — a word you used that the user replaced or asked not to use. This is the strongest signal; always record it.
- **Abbreviations and internal names.**

Skip conversational manner, typos, emotions, plain words without domain weight, and one-off uses with no clear preference.

Where to write:

- One cumulative glossary note, `user_lexicon.md` (`type: user`), one line per term: `**word** — meaning; instead of: <what not to say>`. Extend it; do not create a note per term.
- If it is a **rule** rather than a word ("no English loanwords in ticket titles"), a separate `feedback` note as in step 2.

If nothing new came up, write nothing. An empty pass is fine.

## 3. Session diary

The `episodic_memory` hook keeps the diary: an entry per session in `$DIGESTS/days/YYYY-MM-DD/<session id>.md`, roll-ups in `$DIGESTS/weeks/` and `$DIGESTS/months/`. Do not write diary entries here.

Only check that today's sessions have entries. If some are missing, run `$TOOLS/claude-memory catchup "$(pwd)"`.

## 4. Reconcile task notes

For `project` notes that mention a PR, branch or ticket, check the claim against reality with cheap, local, read-only calls:

- branches: `git branch -a --list '*<hint>*'`; merged: `git branch --merged <main branch>`
- PR status only if a tracker tool is at hand; otherwise skip
- "the note says X, reality says Y" → fix the note (step 1) or report it as "needs a decision"

No network-heavy or expensive calls for this step.

## 5. Registry

After steps 1–2 regenerate `$MEM/REGISTRY.md`, a table of every note with its tickets and status:

```bash
"$TOOLS/claude-memory" registry "$MEM"
```

`REGISTRY.md` is not loaded into the session (only `MEMORY.md` is), so keep it complete. Never edit it by hand: edit the notes and rerun.

## Final report

5–8 lines: what was cleaned, merged or deleted; what was written to memory (including new lexicon); diary status; what needs the user's decision. No filler.

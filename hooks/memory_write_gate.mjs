#!/usr/bin/env node
/**
 * PreToolUse (Write|Edit|Bash): reminds about the journal-first rule before a direct write to a memory note.
 *
 * Catches Write/Edit of ~/.claude/projects/<slug>/memory/<note>.md and Bash commands that write such a note
 * (sed -i, redirection, tee, open(..., 'w') in a script, mv/cp). MEMORY.md, REGISTRY.md, index_*.md and journal/
 * are skipped. Every detected write goes to the gate log (read by `elephant-memory journal check`); the reminder
 * itself is shown once per session and never blocks the call.
 *
 * The Bash part is a heuristic: a write marker anywhere in a command that names a note counts, so a command that
 * only reads a note while writing elsewhere is logged too. A false hit costs a log line and one reminder.
 */
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { GATE_DIR, KINDS, isTrackedNote, logWrites } from './journal.mjs';
import { INSTALL_DIR, PROJECTS_DIR, readPayload, runHook } from './lib.mjs';

const MARKER_TTL_MS = 14 * 24 * 3600 * 1000;
const LAUNCHER = `${INSTALL_DIR.replaceAll('\\', '/')}/bin/elephant-memory`;
const REMINDER =
    'Direct write to a memory note. Only these go straight into a note: a rule or "remember this" from the user, ' +
    "the user's correction, task state (next, status), and edits made by /wrap or /sleep. " +
    `Findings, facts from the work and guesses go to the journal first: ${LAUNCHER} journal add -k <${KINDS.join('|')}> "<text>".`;

const SLUG = String.raw`[^\\/\s'"$]+`;
const MEMORY_DIR_RE = new RegExp(String.raw`projects[\\/](${SLUG})[\\/]memory(?![\w-])`, 'g');
const NOTE_PATH_RE = new RegExp(String.raw`projects[\\/](${SLUG})[\\/]memory[\\/]([\w.-]+\.md)\b`, 'g');
const MEMORY_VAR_RE = new RegExp(String.raw`\b(\w+)=['"]?[^\s'"]*projects[\\/](${SLUG})[\\/]memory(?![\w-])`, 'g');
const VAR_NOTE_RE = /\$\{?(\w+)\}?[\\/]([\w.-]+\.md)\b/g;
const ANY_NOTE_RE = /(?<![\w.-])(\w[\w.-]*\.md)\b/g;
const BASH_WRITE_RE = new RegExp(
    [
        String.raw`\bsed\s+(?:-\w+\s+)*-\w*i`,
        String.raw`\bsed\s.*--in-place`,
        String.raw`\bperl\s+-\w*i`,
        String.raw`\btee\b`,
        String.raw`>>?\s*['"]?[^\s'"&|;]*\.md\b`,
        String.raw`\bopen\([^)]*['"][wa]\+?['"]`,
        String.raw`\.write\(|\bwrite_text\(|\bwriteFileSync\(|\bappendFileSync\(`,
        String.raw`\b(?:mv|cp|truncate|Set-Content|Add-Content|Out-File)\s`,
    ].join('|'),
);

const isMemorySlug = (slug) => existsSync(join(PROJECTS_DIR, slug, 'memory'));

/** {slug, name} of a note-level memory file, else null. */
const noteFromPath = (path) => {
    const rel = relative(PROJECTS_DIR, resolve(path));
    // on Windows a file on another drive comes back as an absolute path
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
        return null;
    }
    const parts = rel.split(sep);
    const isNoteLevel = parts.length === 3 && parts[1] === 'memory';
    return isNoteLevel && isTrackedNote(parts[2]) ? { slug: parts[0], name: parts[2] } : null;
};

/** Notes a Bash command writes; see the heuristic note at the top. */
const notesFromBash = (command) => {
    const slugs = new Set([...command.matchAll(MEMORY_DIR_RE)].map((m) => m[1]).filter(isMemorySlug));
    if (!slugs.size || !BASH_WRITE_RE.test(command)) {
        return [];
    }
    const memoryVars = new Map([...command.matchAll(MEMORY_VAR_RE)].map((m) => [m[1], m[2]]));
    // a note path spelled out, or built from a variable holding the memory dir, may create a new note
    const explicit = [
        ...[...command.matchAll(NOTE_PATH_RE)].map((m) => ({ slug: m[1], name: m[2] })),
        ...[...command.matchAll(VAR_NOTE_RE)].filter((m) => memoryVars.has(m[1])).map((m) => ({ slug: memoryVars.get(m[1]), name: m[2] })),
    ];
    const bareNames = new Set([...command.matchAll(ANY_NOTE_RE)].map((m) => m[1]));
    const existing = [...slugs].flatMap((slug) => [...bareNames].filter((name) => existsSync(join(PROJECTS_DIR, slug, 'memory', name))).map((name) => ({ slug, name })));
    const unique = new Map([...explicit, ...existing].filter((n) => slugs.has(n.slug) && isTrackedNote(n.name)).map((n) => [`${n.slug}/${n.name}`, n]));
    return [...unique.values()];
};

const detectNotes = ({ tool_name: tool, tool_input: input = {} }) => {
    if (tool === 'Bash') {
        return notesFromBash(input.command ?? '');
    }
    const note = input.file_path ? noteFromPath(input.file_path) : null;
    return note ? [note] : [];
};

const pruneOldMarkers = () => {
    const cutoff = Date.now() - MARKER_TTL_MS;
    for (const f of readdirSync(GATE_DIR).filter((name) => name.startsWith('session-'))) {
        if (statSync(join(GATE_DIR, f)).mtimeMs < cutoff) {
            rmSync(join(GATE_DIR, f), { force: true });
        }
    }
};

await runHook(() => {
    const payload = readPayload();
    const notes = detectNotes(payload);
    if (!notes.length) {
        return;
    }
    const sessionId = String(payload.session_id ?? 'unknown').replace(/[^\w-]/g, '');
    logWrites(sessionId, payload.tool_name ?? '?', notes);

    const marker = join(GATE_DIR, `session-${sessionId}`);
    if (existsSync(marker)) {
        return;
    }
    pruneOldMarkers();
    writeFileSync(marker, '');
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: REMINDER } }));
});

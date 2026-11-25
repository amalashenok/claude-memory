#!/usr/bin/env node
/**
 * elephant-memory — command-line helpers used by the /wrap and /sleep skills and by people.
 *
 *   elephant-memory save-wrap <project dir>     save a /wrap summary read from stdin
 *   elephant-memory live [list]                 parallel sessions with their current task and last action
 *   elephant-memory live files [id prefix]      files edited by live sessions
 *   elephant-memory live watch                  stream session events as they happen
 *   elephant-memory registry <memory dir>       regenerate REGISTRY.md (note ↔ case table)
 *   elephant-memory catchup [project dir]       write missing diary entries for recent sessions now
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../hooks/frontmatter.mjs';
import { LOG_FILE, STATE_DIR, localDate, localTime, projectDirOf, readStdin, windowKey, writeAtomic } from '../hooks/lib.mjs';
import { EVENTS_FILE, liveSessions } from '../hooks/live_sessions.mjs';

const HOOKS_DIR = fileURLToPath(new URL('../hooks/', import.meta.url));
const TICKET_RE = /\b(?!(?:UTF|SHA|UTC|ISO|ADR)-)[A-Z][A-Z0-9]{1,7}-\d{2,6}\b/g;
const WATCH_POLL_MS = 1000;

const fail = (message) => {
    console.error(message);
    process.exit(2);
};

/** Saves the /wrap summary: a hand-off for the session after /clear and a permanent copy in the diary. */
const saveWrap = (projectRoot) => {
    if (!projectRoot) {
        fail('usage: elephant-memory save-wrap <project dir>  (summary on stdin)');
    }
    const summary = readStdin();
    if (!summary.trim()) {
        fail('save-wrap: empty summary on stdin');
    }
    const root = resolve(projectRoot);
    const key = windowKey(root);
    const archive = join(projectDirOf(root), 'digests', 'wraps', localDate(), `${localTime().replace(':', '')}-${key}.md`);
    const handoff = join(STATE_DIR, `wrap-${key}.md`);
    writeAtomic(archive, `${summary.trimEnd()}\n`);
    writeAtomic(handoff, `${summary.trimEnd()}\n`);
    console.log(`handoff: ${handoff}\narchive: ${archive}`);
};

const liveList = () => {
    const now = Date.now();
    const sessions = liveSessions();
    if (!sessions.length) {
        console.log('no live sessions');
    }
    for (const s of sessions) {
        const age = `${Math.round((now - s.updated) / 1000)}s ago`;
        const last = `${s.lastTool ?? ''} ${s.lastTarget ?? ''}`.trim().slice(0, 60);
        console.log(`${s.sid.slice(0, 8)}  ${s.project.padEnd(14)} ${age.padStart(9)}  tools=${String(s.tools).padEnd(4)} ${s.task || '(no task yet)'}  [${last}]`);
    }
};

const liveFiles = (prefix = '') => {
    for (const s of liveSessions().filter((x) => x.sid.startsWith(prefix))) {
        console.log(`== ${s.sid}`);
        for (const [file, at] of Object.entries(s.files ?? {}).sort((a, b) => a[1] - b[1])) {
            console.log(`  ${new Date(at).toLocaleTimeString('sv-SE')}  ${file}`);
        }
    }
};

const readBytes = (path, from, to) => {
    const buffer = Buffer.alloc(to - from);
    const fd = openSync(path, 'r');
    try {
        // the file may shrink between stat and read; only the bytes actually read count
        return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, from));
    } finally {
        closeSync(fd);
    }
};

const printEvent = (line) => {
    try {
        const e = JSON.parse(line);
        console.log(`${new Date(e.at).toLocaleTimeString('sv-SE')} ${e.sid} ${e.project} ${e.event} ${e.target ?? ''}`);
    } catch {
        // a line damaged by rotation; skip it
    }
};

/** Follows the event stream; the offset is in bytes and a half-written last line waits for the next poll. */
const liveWatch = async () => {
    let offset = existsSync(EVENTS_FILE) ? statSync(EVENTS_FILE).size : 0;
    let decoder = new StringDecoder('utf8');
    let pending = '';
    for (;;) {
        await sleep(WATCH_POLL_MS);
        const size = existsSync(EVENTS_FILE) ? statSync(EVENTS_FILE).size : 0;
        if (size < offset) {
            offset = 0; // the file was rotated
            decoder = new StringDecoder('utf8');
            pending = '';
        }
        if (size === offset) {
            continue;
        }
        const chunk = readBytes(EVENTS_FILE, offset, size);
        offset += chunk.length;
        const lines = (pending + decoder.write(chunk)).split('\n');
        pending = lines.pop();
        lines.filter(Boolean).forEach(printEvent);
    }
};

/** Local YYYY-MM-DD of `modified`; a bare date is taken as written, not as UTC midnight. */
const noteDate = (modified = '', path) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(modified)) {
        return modified;
    }
    return localDate(new Date(Date.parse(modified) || statSync(path).mtimeMs));
};

/** Regenerates REGISTRY.md: one row per memory note with its tickets and status. */
const registry = (memDir) => {
    if (!memDir || !existsSync(memDir)) {
        fail('usage: elephant-memory registry <memory dir>');
    }
    const rows = readdirSync(memDir)
        .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md' && f !== 'REGISTRY.md')
        .map((file) => {
            const path = join(memDir, file);
            const { meta, lines, bodyStart } = parseFrontmatter(readFileSync(path, 'utf8'));
            const tickets = [...new Set(lines.slice(bodyStart).join('\n').match(TICKET_RE) ?? [])];
            const date = noteDate(meta.modified, path);
            const description = (meta.description || meta.name || file).replaceAll('|', '\\|');
            return { date, type: meta.type ?? '?', description, refs: tickets.join(', ') || '—', status: meta.status ?? '—', file };
        })
        .sort((a, b) => b.date.localeCompare(a.date));
    const out = [
        '# Registry — memory note ↔ case',
        '',
        `Generated by \`elephant-memory registry\` (the /sleep skill). Updated: ${localDate()}. Notes: ${rows.length}.`,
        'Date = `modified` from the frontmatter, else the file mtime. Edit the notes, not this file.',
        '',
        '| Date | Type | Case | Refs | Status | File |',
        '|---|---|---|---|---|---|',
        ...rows.map((r) => `| ${r.date} | ${r.type} | ${r.description} | ${r.refs} | ${r.status} | \`${r.file}\` |`),
    ];
    writeFileSync(join(memDir, 'REGISTRY.md'), `${out.join('\n')}\n`);
    console.log(`REGISTRY.md: ${rows.length} rows`);
};

const catchup = (projectRoot) => {
    const projectDir = projectDirOf(resolve(projectRoot ?? process.cwd()));
    const r = spawnSync(process.execPath, [join(HOOKS_DIR, 'episodic_memory.mjs'), 'catchup', projectDir], { stdio: 'inherit' });
    console.log(`catch-up finished for ${projectDir} (details in ${LOG_FILE})`);
    process.exitCode = r.status ?? 1;
};

const help = () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    console.log(source.split('*/')[0].replace(/^#!.*\n\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
};

const [command, ...args] = process.argv.slice(2);
if (command === 'save-wrap') {
    saveWrap(args[0]);
} else if (command === 'live') {
    const [sub = 'list', arg] = args;
    if (sub === 'list') {
        liveList();
    } else if (sub === 'files') {
        liveFiles(arg);
    } else if (sub === 'watch') {
        await liveWatch();
    } else {
        fail('usage: elephant-memory live [list|files [id]|watch]');
    }
} else if (command === 'registry') {
    registry(args[0]);
} else if (command === 'catchup') {
    catchup(args[0]);
} else {
    help();
    process.exitCode = command && !['-h', '--help', 'help'].includes(command) ? 2 : 0;
}

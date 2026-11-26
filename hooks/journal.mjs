/**
 * The memory journal: one Markdown file per day, memory/journal/YYYY-MM-DD.md, one line per entry:
 *   - HH:MM [kind] text                      waiting for /wrap or /sleep
 *   - HH:MM [kind] text → [[note-name]]      promoted into a note
 *   - HH:MM [kind] text → skipped: reason    rejected by the write filter
 * Also the log of direct writes to memory notes kept by the memory_write_gate hook.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PROJECTS_DIR, STATE_DIR, localDate, localTime, projectDirOf, squash } from './lib.mjs';

export const KINDS = Object.freeze(['fact', 'decision', 'rule', 'commitment', 'correction', 'guess']);
const ENTRY_RE = /^- (\d{2}:\d{2}) \[([a-z]+)\] /;
// Only a mark at the end counts: the entry text may contain an arrow or a [[link]] itself.
const DONE_RE = / → (?:\[\[[^\]]+\]\](?:,\s*\[\[[^\]]+\]\])*|skipped: .+)$/;
export const GATE_DIR = join(STATE_DIR, 'memory-gate');
export const WRITES_LOG = join(GATE_DIR, 'writes.log');
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const WRITES_LOG_MAX_BYTES = 1024 * 1024;
const GENERATED_NOTES = new Set(['MEMORY.md', 'REGISTRY.md']);

/** A note file the journal rule is about: not an index, not a generated file. */
export const isTrackedNote = (name) => name.endsWith('.md') && !GENERATED_NOTES.has(name) && !name.startsWith('index_');

/**
 * Memory dir of a project. Run from inside ~/.claude/projects/<slug>/..., the slug is taken from the path.
 * @param {string} [cwd]
 * @returns {string}
 */
export const memoryDirOf = (cwd = process.cwd()) => {
    const abs = resolve(cwd);
    const rel = relative(PROJECTS_DIR, abs);
    const isInsideProjects = rel && !rel.startsWith('..') && !isAbsolute(rel);
    const projectDir = isInsideProjects ? join(PROJECTS_DIR, rel.split(sep)[0]) : projectDirOf(abs);
    return join(projectDir, 'memory');
};

export const journalFile = (memoryDir, day = localDate()) => join(memoryDir, 'journal', `${day}.md`);

/**
 * Appends one entry to today's journal.
 * @returns {string} the journal file
 */
export const addEntry = (memoryDir, kind, text) => {
    const now = new Date();
    const file = journalFile(memoryDir, localDate(now));
    mkdirSync(join(memoryDir, 'journal'), { recursive: true });
    try {
        // 'wx' fails when the file exists, so two sessions never both write the header
        writeFileSync(file, `# Journal ${localDate(now)}\n\n`, { flag: 'wx' });
    } catch (error) {
        if (error.code !== 'EEXIST') {
            throw error;
        }
    }
    appendFileSync(file, `- ${localTime(now)} [${kind}] ${squash(text)}\n`);
    return file;
};

/** @returns {{time: string, kind: string, line: string, number: number, done: boolean}[]} */
export const readEntries = (file) => {
    if (!existsSync(file)) {
        return [];
    }
    return readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map((line, i) => ({ line, number: i + 1, match: line.match(ENTRY_RE) }))
        .filter((e) => e.match)
        .map(({ line, number, match }) => ({ time: match[1], kind: match[2], line, number, done: DONE_RE.test(line) }));
};

/**
 * Entries neither promoted nor skipped, from days before `before` (all days when it is empty).
 * @returns {{file: string, number: number, line: string}[]}
 */
export const pendingEntries = (memoryDir, before = '') => {
    const dir = join(memoryDir, 'journal');
    if (!existsSync(dir)) {
        return [];
    }
    return readdirSync(dir)
        .filter((f) => DAY_RE.test(basename(f, '.md')) && f.endsWith('.md'))
        .filter((f) => !before || basename(f, '.md') < before)
        .sort()
        .flatMap((f) => readEntries(join(dir, f)).filter((e) => !e.done).map((e) => ({ file: join(dir, f), number: e.number, line: e.line })));
};

/**
 * Appends direct note writes to the gate log, tab-separated: local ISO time, session, tool, project slug, note.
 * Past 1 MB the log is moved to writes.log.1, so it never grows without bound.
 * @param {{slug: string, name: string}[]} notes
 */
export const logWrites = (sessionId, tool, notes) => {
    mkdirSync(GATE_DIR, { recursive: true });
    if (existsSync(WRITES_LOG) && statSync(WRITES_LOG).size > WRITES_LOG_MAX_BYTES) {
        renameSync(WRITES_LOG, `${WRITES_LOG}.1`);
    }
    const now = new Date();
    const at = `${localDate(now)}T${now.toLocaleTimeString('sv-SE')}`;
    appendFileSync(WRITES_LOG, notes.map((n) => `${[at, sessionId, tool, n.slug, n.name].join('\t')}\n`).join(''));
};

/**
 * Direct note writes of one project on one day, from `since` (HH:MM) on.
 * @returns {{time: string, session: string, tool: string, note: string}[]}
 */
export const readWrites = (slug, day, since = '00:00', skipSession = '') => {
    if (!existsSync(WRITES_LOG)) {
        return [];
    }
    const from = `${day}T${since}`;
    return readFileSync(WRITES_LOG, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.split('\t'))
        .filter(([at, session, , project]) => at?.startsWith(day) && at >= from && project === slug && session !== skipSession)
        .map(([at, session, tool, , note]) => ({ time: at.slice(11, 16), session, tool, note }));
};

/** Note files (not indexes, not the journal) whose last change falls on `day` after `since`. */
export const notesChangedOn = (memoryDir, day, since = '00:00') => {
    if (!existsSync(memoryDir)) {
        return [];
    }
    return readdirSync(memoryDir)
        .filter(isTrackedNote)
        .map((f) => ({ note: f, at: statSync(join(memoryDir, f)).mtime }))
        .filter(({ at }) => localDate(at) === day && localTime(at) >= since)
        .map(({ note, at }) => ({ time: localTime(at), note }))
        .sort((a, b) => a.time.localeCompare(b.time));
};

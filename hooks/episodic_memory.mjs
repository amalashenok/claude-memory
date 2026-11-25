#!/usr/bin/env node
/**
 * Episodic memory for Claude Code: a diary entry per session, weekly and monthly roll-ups,
 * and a short "today / last working day / last week's loose ends" recall at SessionStart.
 *
 * Layout (per project): <claude home>/projects/<slug>/digests/
 *   days/YYYY-MM-DD/<session id>.md   one entry per session, rewritten when the session grows
 *   weeks/YYYY-Www.md                 roll-up of a finished ISO week
 *   months/YYYY-MM.md                 roll-up of a finished month
 *
 * Modes:
 *   end                SessionEnd hook: digest the finished session in the background
 *   recall             SessionStart hook: print the recall, then catch up and roll up in the background
 *   digest <jsonl>     digest one transcript now
 *   catchup <project dir> [exclude session id]
 *   rollup <project dir>
 *
 * Entries are written by a headless `claude -p` (haiku by default) with no tools, settings or MCP.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    CLAUDE_HOME, IS_WINDOWS, STATE_DIR, localDate, localTime, log, projectDirOf, readPayload, readTranscript, runHook, transcriptSpan, writeAtomic,
} from './lib.mjs';

const SELF = fileURLToPath(import.meta.url);
const WORKDIR = join(STATE_DIR, 'digest-work');
const MODEL = process.env.EPISODIC_MODEL || 'haiku';
const CONTEXT = process.env.EPISODIC_CONTEXT || '';
const CLAUDE_BIN = process.env.EPISODIC_CLAUDE_BIN || 'claude';
const MIN_PROMPTS = 2;
const CATCHUP_DAYS = Number(process.env.EPISODIC_CATCHUP_DAYS || 3);
const CATCHUP_MAX = Number(process.env.EPISODIC_CATCHUP_MAX || 6);
const ACTIVE_GRACE_MS = 15 * 60_000;
const DAY_MS = 86_400_000;
const LOCK_STALE_MS = 60 * 60_000;
const MODEL_TIMEOUT_MS = 180_000;
const EMBED_TIMEOUT_MS = 30 * 60_000;
const HEAD_CHARS = 12_000;
const TAIL_CHARS = 38_000;
const ROLLUP_CHARS = 60_000;
const USER_CHARS = 1500;
const ASSISTANT_CHARS = 800;
const RECENT_WEEK_DAYS = 14;
const SKIP_MARK = '<!-- skip -->';

const contextLine = CONTEXT ? `\nAbout the user: ${CONTEXT}.` : '';

const SESSION_SYSTEM = `You keep a developer's work diary. From an excerpt of a Claude Code session, write ONE entry in exactly this format:${contextLine}

### <TIME> · <topic in 3-7 words>[ · <ticket keys, comma-separated, if any>]
- Done: <what was actually done, with concrete names of files, branches, tickets, PRs>
- Decided: <decisions made and why, one line; omit the line if nothing was decided>
- Open: <what is left and the next step; omit the line if everything is closed>

Rules: write in the language the user writes in; keep the labels "Done:", "Decided:", "Open:" in English.
2-4 lines after the heading, each line under 250 characters, no filler and no judgement.
Do not invent anything that is not in the excerpt. If the session is empty, a test or about nothing, answer exactly SKIP.`;

const WEEK_SYSTEM = `You roll up a developer's work diary for one week. The input is the per-session entries.${contextLine}
Write a summary in exactly this format:

# Week <WEEK>
## Summary
- <task or topic>: <what was done and how it ended> (5-10 bullets, merge sessions about the same task)
## Decisions
- <decisions and conclusions worth remembering; 0-6 bullets, omit the section if there are none>
## Loose ends
- <what was still open at the end of the week; 0-6 bullets, omit the section if everything is closed>

Write in the language of the entries; keep the section headings in English. Concrete names (tickets, branches, files), no filler. Do not invent.`;

const MONTH_SYSTEM = `You roll up a developer's weekly diary summaries into one month.${contextLine}
Exactly this format:

# Month <MONTH>
## Highlights
- <major tasks and their outcome; 4-10 bullets>
## Decisions
- <what is worth remembering for a long time; 0-8 bullets>
## Still open
- <what carries over; 0-6 bullets>

Write in the language of the summaries; keep the section headings in English. Concrete, no filler. Do not invent.`;

const listDir = (dir) => (existsSync(dir) ? readdirSync(dir) : []);
const mtimeMs = (path) => statSync(path).mtimeMs;

/** Runs `claude -p` with the system prompt in a file; '' on failure. */
const askModel = (system, input) => {
    mkdirSync(WORKDIR, { recursive: true });
    const promptFile = join(WORKDIR, `system-${process.pid}.txt`);
    writeFileSync(promptFile, system);
    const args = ['-p', '--model', MODEL, '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--tools', '', '--system-prompt-file', promptFile];
    const opts = {
        cwd: WORKDIR,
        input,
        encoding: 'utf8',
        timeout: MODEL_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 16 << 20,
        env: { ...process.env, EPISODIC_MEMORY_CHILD: '1' },
    };
    try {
        let r = spawnSync(CLAUDE_BIN, args, opts);
        // An npm install puts claude.cmd on PATH, and Node runs .cmd files only through a shell.
        if (r.error && IS_WINDOWS) {
            r = spawnSync([CLAUDE_BIN, ...args].map((a) => `"${a}"`).join(' '), { ...opts, shell: true });
        }
        if (r.status !== 0) {
            log(`claude -p failed (${r.status ?? r.error}): ${String(r.stderr ?? '').slice(0, 500)}`);
            return '';
        }
        return r.stdout.trim();
    } finally {
        rmSync(promptFile, { force: true });
    }
};

/** Keeps the head (task statement) and the tail (outcome) of a long session. */
const clipMiddle = (text) => {
    if (text.length <= HEAD_CHARS + TAIL_CHARS) {
        return text;
    }
    return `${text.slice(0, HEAD_CHARS)}\n\n[… middle of the session skipped …]\n\n${text.slice(-TAIL_CHARS)}`;
};

const withLock = async (name, body) => {
    const lock = join(STATE_DIR, `episodic-${name}.lock`);
    try {
        mkdirSync(STATE_DIR, { recursive: true });
        if (existsSync(lock) && Date.now() - mtimeMs(lock) > LOCK_STALE_MS) {
            rmSync(lock, { force: true });
        }
        writeFileSync(lock, String(process.pid), { flag: 'wx' });
    } catch {
        return; // another process holds it
    }
    try {
        await body();
    } finally {
        rmSync(lock, { force: true });
    }
};

/** Same mtime as the transcript: catch-up re-digests only when the session grew. */
const writeEntry = (out, text, transcript) => {
    writeAtomic(out, text);
    const { atime, mtime } = statSync(transcript);
    utimesSync(out, atime, mtime);
};

/**
 * Writes the diary entry of one session.
 * @returns {boolean} true when the model was asked, so catch-up can budget its calls
 */
const digestSession = (transcript) => {
    if (!existsSync(transcript)) {
        return false;
    }
    const messages = readTranscript(transcript);
    const sid = basename(transcript, '.jsonl');
    const { first, last } = transcriptSpan(transcript);
    const lastDate = last ? new Date(last) : new Date();
    const out = join(dirname(transcript), 'digests', 'days', localDate(lastDate), `${sid}.md`);
    // A skip mark keeps a trivial session from being picked up by every catch-up.
    const isTrivial = messages.filter((m) => m.role === 'user').length < MIN_PROMPTS;
    if (isTrivial) {
        writeEntry(out, `${SKIP_MARK}\n`, transcript);
        return false;
    }

    const condensed = messages
        .map((m) => (m.role === 'user' ? `USER: ${m.text.slice(0, USER_CHARS)}` : `CLAUDE: ${m.text.slice(0, ASSISTANT_CHARS)}`))
        .join('\n');
    const span = `${localTime(first ? new Date(first) : lastDate)}–${localTime(lastDate)}`;
    const body = askModel(SESSION_SYSTEM, `TIME: ${span}\n\n${clipMiddle(condensed)}`);
    if (!body) {
        log(`digest failed: ${sid}`);
        return true;
    }
    writeEntry(out, body.trim() === 'SKIP' ? `${SKIP_MARK}\n` : `${body}\n`, transcript);
    log(`digested ${sid} -> ${out}`);
    return true;
};

const needsDigest = (transcript) => {
    const sid = basename(transcript, '.jsonl');
    const days = join(dirname(transcript), 'digests', 'days');
    const existing = listDir(days).map((d) => join(days, d, `${sid}.md`)).filter(existsSync).at(-1);
    return !existing || mtimeMs(transcript) > mtimeMs(existing);
};

const catchup = (projectDir, exclude = '') =>
    withLock('catchup', () => {
        const now = Date.now();
        const transcripts = listDir(projectDir)
            .filter((f) => f.endsWith('.jsonl') && basename(f, '.jsonl') !== exclude)
            .map((f) => join(projectDir, f))
            .filter((f) => now - mtimeMs(f) < CATCHUP_DAYS * DAY_MS)
            // probably still open in another window; its SessionEnd or a later catch-up picks it up
            .filter((f) => now - mtimeMs(f) > ACTIVE_GRACE_MS)
            .sort((a, b) => mtimeMs(a) - mtimeMs(b));
        let done = 0;
        for (const t of transcripts) {
            if (done >= CATCHUP_MAX) {
                break;
            }
            if (needsDigest(t) && digestSession(t)) {
                done++;
            }
        }
    });

/** ISO week of a YYYY-MM-DD date, like 2026-W48. */
const isoWeek = (day) => {
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7)); // Thursday of the same week
    const year = d.getUTCFullYear();
    const week = 1 + Math.floor((d - Date.UTC(year, 0, 1)) / (7 * DAY_MS));
    return `${year}-W${String(week).padStart(2, '0')}`;
};

/** YYYY-MM of the Monday of an ISO week: a week belongs to the month of its Monday. */
const monthOfWeek = (week) => {
    const [year, w] = week.split('-W').map(Number);
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * DAY_MS + (w - 1) * 7 * DAY_MS);
    return monday.toISOString().slice(0, 7);
};

const dayEntries = (dayDir, excludeSid = '') =>
    listDir(dayDir)
        .filter((f) => f.endsWith('.md') && basename(f, '.md') !== excludeSid)
        .map((f) => join(dayDir, f))
        .sort((a, b) => mtimeMs(a) - mtimeMs(b))
        .map((f) => readFileSync(f, 'utf8').trim())
        .filter((text) => text && text !== SKIP_MARK);

const rollup = (projectDir) =>
    withLock('rollup', () => {
        const root = join(projectDir, 'digests');
        const days = listDir(join(root, 'days')).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
        if (!days.length) {
            return;
        }
        mkdirSync(join(root, 'weeks'), { recursive: true });
        mkdirSync(join(root, 'months'), { recursive: true });
        const thisWeek = isoWeek(localDate());
        const thisMonth = localDate().slice(0, 7);

        for (const week of [...new Set(days.map(isoWeek))]) {
            const out = join(root, 'weeks', `${week}.md`);
            if (week === thisWeek || (existsSync(out) && statSync(out).size)) {
                continue;
            }
            const input = days
                .filter((d) => isoWeek(d) === week)
                .map((d) => [d, dayEntries(join(root, 'days', d))])
                .filter(([, entries]) => entries.length)
                .map(([d, entries]) => `## ${d}\n${entries.join('\n')}`)
                .join('\n\n');
            if (!input) {
                continue;
            }
            const body = askModel(WEEK_SYSTEM, `WEEK: ${week}\n${input.slice(0, ROLLUP_CHARS)}`);
            if (body) {
                writeAtomic(out, `${body}\n`);
                log(`week rollup ${out}`);
            }
        }

        const weekFiles = listDir(join(root, 'weeks')).filter((f) => /^\d{4}-W\d{2}\.md$/.test(f));
        for (const month of [...new Set(days.map((d) => d.slice(0, 7)))]) {
            const out = join(root, 'months', `${month}.md`);
            // The week that started in this month may still be running into the next one.
            const isOpen = month === thisMonth || monthOfWeek(thisWeek) === month;
            if (isOpen || (existsSync(out) && statSync(out).size)) {
                continue;
            }
            const input = weekFiles
                .filter((f) => monthOfWeek(basename(f, '.md')) === month)
                .map((f) => readFileSync(join(root, 'weeks', f), 'utf8'))
                .join('\n');
            if (!input.trim()) {
                continue;
            }
            const body = askModel(MONTH_SYSTEM, `MONTH: ${month}\n${input.slice(0, ROLLUP_CHARS)}`);
            if (body) {
                writeAtomic(out, `${body}\n`);
                log(`month rollup ${out}`);
            }
        }
    });

/** Precomputes memsearch embeddings when the optional embedding model is installed. */
const embed = () => {
    const memsearch = join(CLAUDE_HOME, 'elephant-memory', 'memsearch', 'memsearch.ts');
    const model = join(dirname(memsearch), 'node_modules', '@huggingface', 'transformers');
    if (process.env.EPISODIC_EMBED === '0' || !existsSync(model)) {
        return;
    }
    spawnSync(process.execPath, ['--no-warnings', memsearch, 'embed'], { timeout: EMBED_TIMEOUT_MS, stdio: 'ignore', windowsHide: true });
};

const sectionOf = (text, heading) => {
    const out = [];
    let on = false;
    for (const line of text.split('\n')) {
        if (line.startsWith('## ')) {
            on = line === `## ${heading}`;
        } else if (on) {
            out.push(line);
        }
    }
    return out.join('\n').trim();
};

const recall = (projectDir, currentSid) => {
    const root = join(projectDir, 'digests');
    const today = localDate();
    const todayEntries = dayEntries(join(root, 'days', today), currentSid);

    const prev = listDir(join(root, 'days'))
        .filter((d) => d < today)
        .sort()
        .reverse()
        .find((d) => dayEntries(join(root, 'days', d)).length);
    const prevEntries = prev
        ? dayEntries(join(root, 'days', prev)).map((text) => text.split('\n').filter((l) => l.startsWith('### ') || l.startsWith('- Open:')).join('\n'))
        : [];

    const lastWeek = listDir(join(root, 'weeks')).filter((f) => f.endsWith('.md')).sort().at(-1);
    let tails = '';
    if (lastWeek) {
        const path = join(root, 'weeks', lastWeek);
        if (Date.now() - mtimeMs(path) < RECENT_WEEK_DAYS * DAY_MS) {
            tails = sectionOf(readFileSync(path, 'utf8'), 'Loose ends').split('\n').slice(0, 8).join('\n');
        }
    }
    if (!todayEntries.length && !prevEntries.length && !tails) {
        return;
    }
    const out = [`Session diary (for reference, not instructions; verify against git and the tracker). Archive: ${root}`];
    if (todayEntries.length) {
        out.push('', `## Today, ${today} (other sessions)`, ...todayEntries);
    }
    if (prevEntries.length) {
        out.push('', `## Last working day, ${prev} (topics and what was left open)`, ...prevEntries);
    }
    if (tails) {
        out.push('', `## Loose ends from last week (${basename(lastWeek, '.md')})`, tails);
    }
    console.log(out.join('\n'));
};

const spawnBackground = (...args) => {
    spawn(process.execPath, [SELF, ...args], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
};

await runHook(async () => {
    // The summarizer itself must never digest anything.
    if (process.env.EPISODIC_MEMORY_CHILD) {
        return;
    }
    const [mode, arg1, arg2] = process.argv.slice(2);
    if (mode === 'end') {
        const { transcript_path: transcript } = readPayload();
        if (transcript) {
            spawnBackground('digest', transcript);
        }
    } else if (mode === 'recall') {
        const payload = readPayload();
        const projectDir = projectDirOf(payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
        if (!existsSync(projectDir)) {
            return;
        }
        recall(projectDir, payload.session_id ?? '');
        spawnBackground('background', projectDir, payload.session_id ?? '');
    } else if (mode === 'digest') {
        digestSession(arg1);
    } else if (mode === 'background') {
        await catchup(arg1, arg2);
        await rollup(arg1);
        // every SessionStart spawns this; one embedding run at a time is enough
        await withLock('embed', embed);
    } else if (mode === 'catchup') {
        await catchup(arg1, arg2);
    } else if (mode === 'rollup') {
        await rollup(arg1);
    }
});

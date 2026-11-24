#!/usr/bin/env node
/**
 * Live registry of parallel Claude Code sessions, kept as small JSON files (no server needed).
 *
 * Modes (hook JSON arrives on stdin):
 *   start   SessionStart: register the session, print the other live sessions into the context
 *   prompt  UserPromptSubmit: a substantial prompt becomes the session's current task
 *   tool    PostToolUse: refresh the session, remember edited files, warn when another session edited the same file
 *   end     SessionEnd: append a short entry to digests/live/<date>.md and drop the session
 *
 * state/live/sessions/<session id>.json   one file per session; a session idle for TTL is considered gone
 * state/live/events.jsonl                 append-only event stream (`claude-memory live watch`)
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { IS_WINDOWS, PROJECTS_DIR, STATE_DIR, localDate, localTime, readPayload, readTranscript, runHook, writeAtomic } from './lib.mjs';

export const LIVE_DIR = join(STATE_DIR, 'live');
export const SESSIONS_DIR = join(LIVE_DIR, 'sessions');
export const EVENTS_FILE = join(LIVE_DIR, 'events.jsonl');
export const TTL_MS = 3_600_000;
const CONFLICT_WINDOW_MS = 600_000;
const OTHERS_SHOWN = 5;
const MIN_TOOLS_FOR_DIGEST = 3;
const MIN_PROMPT_CHARS = 20; // shorter replies ("ok", "go on") say nothing about the task
const TASK_CHARS = 160;
const TARGET_CHARS = 80;
const DIGEST_FILES = 25;
const EVENTS_MAX_BYTES = 1 << 20;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const sessionFile = (sid) => join(SESSIONS_DIR, `${sid}.json`);
const samePath = (a, b) => (IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b);

export const loadSession = (path) => {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return null;
    }
};

/** Live sessions other than `exceptSid`; files of sessions idle longer than TTL are removed. */
export const liveSessions = (exceptSid = '') => {
    const now = Date.now();
    const out = [];
    for (const name of existsSync(SESSIONS_DIR) ? readdirSync(SESSIONS_DIR) : []) {
        const sid = basename(name, '.json');
        if (!name.endsWith('.json') || sid === exceptSid) {
            continue;
        }
        const path = join(SESSIONS_DIR, name);
        const s = loadSession(path);
        if (!s || now - s.updated > TTL_MS) {
            rmSync(path, { force: true });
            continue;
        }
        out.push({ sid, ...s });
    }
    return out.sort((a, b) => b.updated - a.updated);
};

const publish = (event, sid, project, target = '') => {
    mkdirSync(LIVE_DIR, { recursive: true });
    if (existsSync(EVENTS_FILE) && statSync(EVENTS_FILE).size > EVENTS_MAX_BYTES) {
        writeFileSync(EVENTS_FILE, '');
    }
    appendFileSync(EVENTS_FILE, `${JSON.stringify({ at: Date.now(), sid: sid.slice(0, 8), project, event, target })}\n`);
};

const firstPrompt = (transcript) => {
    const prompt = transcript ? readTranscript(transcript).find((m) => m.role === 'user') : null;
    return prompt ? prompt.text.slice(0, TASK_CHARS) : '';
};

const describe = (s, now) => `• ${s.project} — ${s.task || s.lastTarget || '?'} (${Math.round((now - s.updated) / 1000)}s ago, tool calls: ${s.tools})`;

const conflictsWith = (sid, file, now) =>
    liveSessions(sid).flatMap((o) => {
        const hit = Object.entries(o.files ?? {}).find(([f, at]) => samePath(f, file) && now - at <= CONFLICT_WINDOW_MS);
        return hit ? [`${file} was edited in a parallel session "${o.task || o.project}" (${Math.round((now - hit[1]) / 1000)}s ago).`] : [];
    });

const appendDigest = (s, sid, transcript, now) => {
    const projectDir = transcript ? dirname(transcript) : join(PROJECTS_DIR, 'live');
    const out = join(projectDir, 'digests', 'live', `${localDate()}.md`);
    const files = Object.keys(s.files ?? {}).slice(0, DIGEST_FILES);
    const lines = [
        `## ${localTime(new Date(s.started))}–${localTime(new Date(now))} · ${s.project} · ${s.taskFirst || s.task || '?'}`,
        `- session ${sid.slice(0, 8)}, tool calls: ${s.tools}`,
    ];
    if (s.task && s.task !== s.taskFirst) {
        lines.push(`- last topic: ${s.task}`);
    }
    if (files.length) {
        lines.push('- edited files:', ...files.map((f) => `  - ${f}`));
    }
    mkdirSync(dirname(out), { recursive: true });
    appendFileSync(out, `${lines.join('\n')}\n\n`);
};

const main = () => {
    // headless summarizer sessions are not real work
    if (process.env.EPISODIC_MEMORY_CHILD) {
        return;
    }
    const mode = process.argv[2];
    const payload = readPayload();
    const sid = payload.session_id;
    if (!sid) {
        return;
    }
    const now = Date.now();
    const cwd = payload.cwd || '';
    const project = basename(cwd) || '?';
    const path = sessionFile(sid);
    const s = loadSession(path) ?? { cwd, project, started: now, tools: 0, task: '', taskFirst: '', files: {} };
    s.updated = now;

    if (mode === 'start') {
        writeAtomic(path, JSON.stringify(s));
        publish('start', sid, project);
        const others = liveSessions(sid).slice(0, OTHERS_SHOWN);
        if (others.length) {
            console.log(`Parallel Claude sessions (live registry, \`claude-memory live list\`):\n${others.map((o) => describe(o, now)).join('\n')}`);
        }
    } else if (mode === 'prompt') {
        const text = String(payload.prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, TASK_CHARS);
        const isTask = text.length >= MIN_PROMPT_CHARS && !text.startsWith('/');
        if (isTask) {
            s.task = text;
            s.taskFirst ||= text;
            publish('task', sid, project, text);
        }
        writeAtomic(path, JSON.stringify(s));
    } else if (mode === 'tool') {
        const tool = payload.tool_name ?? '';
        const input = payload.tool_input ?? {};
        const file = input.file_path ?? input.notebook_path ?? '';
        s.tools += 1;
        s.lastTool = tool;
        s.lastTarget = file || String(input.command ?? input.pattern ?? input.query ?? '').replace(/\s+/g, ' ').slice(0, TARGET_CHARS);
        if (!s.task) {
            s.task = firstPrompt(payload.transcript_path);
            s.taskFirst ||= s.task;
        }
        const warnings = EDIT_TOOLS.has(tool) && file ? conflictsWith(sid, file, now) : [];
        if (EDIT_TOOLS.has(tool) && file) {
            s.files[file] = now;
            publish('edit', sid, project, file);
        }
        writeAtomic(path, JSON.stringify(s));
        if (warnings.length) {
            const additionalContext = `Possible conflict: ${warnings.join(' ')}`;
            console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } }));
        }
    } else if (mode === 'end') {
        if (s.tools >= MIN_TOOLS_FOR_DIGEST) {
            appendDigest(s, sid, payload.transcript_path, now);
        }
        rmSync(path, { force: true });
        publish('end', sid, project);
    }
};

const isEntryPoint = process.argv[1] && basename(process.argv[1]) === 'live_sessions.mjs';
if (isEntryPoint) {
    await runHook(main);
}

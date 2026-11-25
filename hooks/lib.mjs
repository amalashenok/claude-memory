/**
 * Shared helpers for the elephant-memory hooks and tools.
 * Plain Node.js (no dependencies), works on Linux, macOS and Windows.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const IS_WINDOWS = process.platform === 'win32';
export const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
export const STATE_DIR = join(CLAUDE_HOME, 'state');
export const PROJECTS_DIR = join(CLAUDE_HOME, 'projects');
export const LOG_FILE = join(STATE_DIR, 'elephant-memory.log');
/** Where the script installer puts hooks and tools; the launchers in its bin/ are what skills call. */
export const INSTALL_DIR = join(CLAUDE_HOME, 'elephant-memory');

const NOISE_RE = /<command-name>|<local-command|<system-reminder>|<task-notification>|Caveat: The messages below/;
const CLAUDE_CMD_RE = /@anthropic-ai[\\/]claude-code|(^|[\\/\s"])claude(\.exe|\.cmd|\.js)?("|\s|$)/i;
const MAX_PARENT_HOPS = 20;

/** Same slug Claude Code uses for ~/.claude/projects/<slug>. */
export const slugOf = (path) => path.replace(/[^A-Za-z0-9]/g, '-');

export const projectDirOf = (cwd) => join(PROJECTS_DIR, slugOf(cwd));

export const squash = (text) => text.replace(/\s+/g, ' ').trim();

export const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

export const log = (message) => {
    try {
        mkdirSync(STATE_DIR, { recursive: true });
        appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`);
    } catch {
        // logging must never break a hook
    }
};

/** Hook payload from stdin, {} when there is none. */
export const readPayload = () => {
    if (process.stdin.isTTY) {
        return {};
    }
    try {
        const raw = readFileSync(0, 'utf8');
        return raw.trim() ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
};

export const readStdin = () => {
    try {
        return readFileSync(0, 'utf8');
    } catch {
        return '';
    }
};

const slash = (path) => path.replaceAll('\\', '/');

/** Writes `path` only when its content differs; returns whether it wrote. */
const writeIfChanged = (path, text) => {
    if (existsSync(path) && readFileSync(path, 'utf8') === text) {
        return false;
    }
    writeFileSync(path, text);
    return true;
};

/**
 * Writes a launcher `<binDir>/<name>` (plus `<name>.cmd` on Windows) that runs `script` with `node`.
 * @param {string} binDir
 * @param {string} name
 * @param {string} node
 * @param {string} script
 * @param {string} [extraArgs] node flags, each followed by a space
 */
export const writeShim = (binDir, name, node, script, extraArgs = '') => {
    mkdirSync(binDir, { recursive: true });
    const posix = join(binDir, name);
    if (writeIfChanged(posix, `#!/bin/sh\nexec "${slash(node)}" ${extraArgs}"${slash(script)}" "$@"\n`)) {
        chmodSync(posix, 0o755);
    }
    if (IS_WINDOWS) {
        writeIfChanged(`${posix}.cmd`, `@echo off\r\n"${node}" ${extraArgs}"${script}" %*\r\n`);
    }
};

/** Writes through a temp file so readers never see a half-written file. */
export const writeAtomic = (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
};

/**
 * Runs a hook body and always exits 0: a failing hook must never break the session.
 * @param {() => (void | Promise<void>)} main
 */
export const runHook = async (main) => {
    try {
        await main();
    } catch (error) {
        log(`${basename(process.argv[1] ?? 'hook')}: ${error?.stack ?? error}`);
    }
    process.exitCode = 0;
};

/** @returns {string} stdout of `git -C cwd ...args`, '' on any failure. */
export const git = (cwd, args) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return r.status === 0 ? r.stdout.trimEnd() : '';
};

const textOf = (content) => {
    if (typeof content === 'string') {
        return content;
    }
    return Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join(' ') : '';
};

/**
 * Parses a Claude Code transcript (.jsonl) into real user prompts and assistant texts.
 * Tool results, slash-command echoes and injected reminders are dropped.
 * @returns {{role: 'user' | 'assistant', text: string, timestamp?: string}[]}
 */
export const readTranscript = (path) => {
    let raw;
    try {
        raw = readFileSync(path, 'utf8');
    } catch {
        return [];
    }
    const out = [];
    for (const line of raw.split('\n')) {
        if (!line.trim()) {
            continue;
        }
        let entry;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        const isUser = entry.type === 'user' && !entry.isMeta;
        if (!isUser && entry.type !== 'assistant') {
            continue;
        }
        const text = squash(textOf(entry.message?.content));
        if (!text || (isUser && NOISE_RE.test(text))) {
            continue;
        }
        out.push({ role: isUser ? 'user' : 'assistant', text, timestamp: entry.timestamp });
    }
    return out;
};

/** First and last timestamps of a transcript, including tool entries. */
export const transcriptSpan = (path) => {
    let first;
    let last;
    try {
        for (const m of readFileSync(path, 'utf8').matchAll(/"timestamp":"([^"]+)"/g)) {
            first ??= m[1];
            last = m[1];
        }
    } catch {
        // missing transcript: no span
    }
    return { first, last };
};

const processTablePosix = () => {
    const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0) {
        return new Map();
    }
    const table = new Map();
    for (const line of r.stdout.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
        if (m) {
            const name = basename(m[3].split(' ')[0]);
            table.set(Number(m[1]), { ppid: Number(m[2]), name, cmd: m[3] });
        }
    }
    return table;
};

const processTableWindows = () => {
    const query = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
        maxBuffer: 64 << 20,
    });
    if (r.status !== 0) {
        return new Map();
    }
    const table = new Map();
    for (const p of [JSON.parse(r.stdout)].flat()) {
        table.set(p.ProcessId, { ppid: p.ParentProcessId, name: p.Name ?? '', cmd: p.CommandLine ?? '' });
    }
    return table;
};

const isClaudeProcess = ({ name, cmd }) => {
    if (/^claude(\.exe)?$/i.test(name)) {
        return true;
    }
    return /^node(\.exe)?$/i.test(name) && CLAUDE_CMD_RE.test(cmd) && !cmd.includes('elephant-memory');
};

/**
 * PID of the Claude Code process above this one, or null.
 * The process survives /clear while the session id does not, so it identifies the terminal window.
 */
export const findClaudePid = () => {
    try {
        const table = IS_WINDOWS ? processTableWindows() : processTablePosix();
        let pid = process.ppid;
        for (let hop = 0; hop < MAX_PARENT_HOPS && pid > 1; hop++) {
            const p = table.get(pid);
            if (!p) {
                return null;
            }
            if (isClaudeProcess(p)) {
                return pid;
            }
            pid = p.ppid;
        }
    } catch (error) {
        log(`findClaudePid: ${error}`);
    }
    return null;
};

/**
 * Key of the current terminal window for /clear hand-offs.
 * Falls back to the project slug when the process tree is not readable.
 */
export const windowKey = (cwd) => {
    const pid = findClaudePid();
    return pid ? `pid-${pid}` : `slug-${slugOf(cwd)}`;
};

export const localDate = (date = new Date()) => date.toLocaleDateString('sv-SE');

export const localTime = (date = new Date()) => date.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });

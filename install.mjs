#!/usr/bin/env node
/**
 * Installs claude-memory into a Claude Code config dir (~/.claude or $CLAUDE_CONFIG_DIR).
 * Works on Linux, macOS and Windows; safe to run again (it replaces its own hooks, never others).
 *
 *   node install.mjs [options]
 *
 *   --uninstall        remove hooks, tools, unchanged skills and the CLAUDE.md block; memory and diaries stay
 *   --no-diary         skip the episodic diary hooks (they call `claude -p` with a small model)
 *   --no-live          skip the live registry of parallel sessions
 *   --no-embeddings    skip the optional local embedding model (memsearch --hybrid / --sem)
 *   --no-claude-md     do not add the memory conventions block to CLAUDE.md
 *   --node <path>      Node.js binary the hooks run with (default: the one running this script)
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { writeShim } from './hooks/lib.mjs';

const MIN_NODE = [22, 18];
const REPO = dirname(fileURLToPath(import.meta.url));
const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const TARGET = join(CLAUDE_HOME, 'claude-memory');
const SETTINGS = join(CLAUDE_HOME, 'settings.json');
const CLAUDE_MD = join(CLAUDE_HOME, 'CLAUDE.md');
// Outside skills/: Claude Code loads every SKILL.md there, a backup would show up as a duplicate skill.
const BACKUPS = join(CLAUDE_HOME, 'backups', 'claude-memory');
const SKILLS = ['wrap', 'sleep'];
const HOOK_MARK = 'claude-memory/hooks/';
const MD_START = '<!-- claude-memory:start -->';
const MD_END = '<!-- claude-memory:end -->';
const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);

/** [event, script, mode, timeout seconds, feature, status message] */
const HOOKS = Object.freeze([
    ['SessionStart', 'session_resume_hint.mjs', '', 20, 'core', 'Reading the last session snapshot'],
    ['SessionStart', 'episodic_memory.mjs', 'recall', 10, 'diary', 'Recalling today and the last working day'],
    ['SessionStart', 'active_tasks.mjs', '', 5, 'core', 'Collecting active tasks from memory'],
    ['SessionStart', 'live_sessions.mjs', 'start', 5, 'live'],
    ['UserPromptSubmit', 'live_sessions.mjs', 'prompt', 5, 'live'],
    ['PostToolUse', 'live_sessions.mjs', 'tool', 5, 'live'],
    ['Stop', 'session_snapshot.mjs', '', 10, 'core'],
    ['SessionEnd', 'session_snapshot.mjs', '', 20, 'core'],
    ['SessionEnd', 'episodic_memory.mjs', 'end', 10, 'diary'],
    ['SessionEnd', 'live_sessions.mjs', 'end', 5, 'live'],
]);

const { values: opts } = parseArgs({
    options: {
        uninstall: { type: 'boolean', default: false },
        'no-diary': { type: 'boolean', default: false },
        'no-live': { type: 'boolean', default: false },
        'no-embeddings': { type: 'boolean', default: false },
        'no-claude-md': { type: 'boolean', default: false },
        node: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
    },
});

const say = (message) => console.log(message);
const warn = (message) => console.log(`! ${message}`);
const fail = (message) => {
    console.error(`✗ ${message}`);
    process.exit(1);
};

const slash = (path) => path.replaceAll('\\', '/');

/** Path as the user would type it in a shell: ~/… under the home dir. */
const tilde = (path) => {
    const rel = relative(homedir(), path);
    // on Windows a path on another drive comes back absolute
    const isUnderHome = rel && !rel.startsWith('..') && !isAbsolute(rel);
    return isUnderHome ? `~/${slash(rel)}` : slash(path);
};

const versionOk = (version) => {
    const [major, minor] = version.split('.').map(Number);
    return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
};

const nodeBinary = () => {
    if (!opts.node) {
        if (!versionOk(process.versions.node)) {
            fail(`Node.js >= ${MIN_NODE.join('.')} is required, this is ${process.versions.node}. Run with a newer node or pass --node <path>.`);
        }
        return process.execPath;
    }
    const r = spawnSync(opts.node, ['-p', 'process.versions.node'], { encoding: 'utf8' });
    const version = r.stdout?.trim() ?? '';
    if (r.status !== 0 || !versionOk(version)) {
        fail(`--node ${opts.node}: Node.js >= ${MIN_NODE.join('.')} is required (got ${version || 'nothing'}).`);
    }
    return opts.node;
};

const hasCommand = (command) => spawnSync(`"${command}" --version`, { stdio: 'ignore', shell: true }).status === 0;

const readSettings = () => {
    if (!existsSync(SETTINGS)) {
        return {};
    }
    try {
        return JSON.parse(readFileSync(SETTINGS, 'utf8'));
    } catch (error) {
        return fail(`${SETTINGS} is not valid JSON (${error.message}); fix it and run again.`);
    }
};

const writeSettings = (settings) => {
    if (existsSync(SETTINGS)) {
        cpSync(SETTINGS, `${SETTINGS}.bak-claude-memory-${STAMP}`);
    }
    mkdirSync(CLAUDE_HOME, { recursive: true });
    writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
};

/** Removes this package's hook commands, keeping everything else (and dropping groups left empty). */
const stripOurHooks = (settings) => {
    const hooks = settings.hooks ?? {};
    for (const [event, groups] of Object.entries(hooks)) {
        const kept = groups
            .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !slash(h.command ?? '').includes(HOOK_MARK)) }))
            .filter((g) => g.hooks.length);
        if (kept.length) {
            hooks[event] = kept;
        } else {
            delete hooks[event];
        }
    }
    if (Object.keys(hooks).length) {
        settings.hooks = hooks;
    } else {
        delete settings.hooks;
    }
    return settings;
};

const addOurHooks = (settings, node, features) => {
    settings.hooks ??= {};
    const byEvent = new Map();
    for (const [event, script, mode, timeout, feature, statusMessage] of HOOKS) {
        if (!features.has(feature)) {
            continue;
        }
        const command = `"${slash(node)}" "${slash(join(TARGET, 'hooks', script))}"${mode ? ` ${mode}` : ''}`;
        const hook = { type: 'command', command, timeout, ...(statusMessage ? { statusMessage } : {}) };
        byEvent.set(event, [...(byEvent.get(event) ?? []), hook]);
    }
    for (const [event, hooks] of byEvent) {
        settings.hooks[event] = [...(settings.hooks[event] ?? []), { hooks }];
    }
    return settings;
};

/** Skill text with ~/.claude replaced by the real config dir. */
const renderSkillFile = (text) => text.replaceAll('~/.claude/', `${tilde(CLAUDE_HOME)}/`);

const renderedSkill = (name) => {
    const src = join(REPO, 'skills', name);
    return Object.fromEntries(readdirSync(src, { recursive: true }).filter((f) => statSync(join(src, f)).isFile()).map((f) => [slash(f), renderSkillFile(readFileSync(join(src, f), 'utf8'))]));
};

const sameSkill = (dir, files) => {
    if (!existsSync(dir)) {
        return false;
    }
    const present = readdirSync(dir, { recursive: true }).filter((f) => statSync(join(dir, f)).isFile()).map(slash);
    return present.length === Object.keys(files).length && present.every((f) => files[f] === readFileSync(join(dir, f), 'utf8'));
};

const installSkills = () => {
    for (const name of SKILLS) {
        const dir = join(CLAUDE_HOME, 'skills', name);
        const files = renderedSkill(name);
        if (sameSkill(dir, files)) {
            continue;
        }
        if (existsSync(dir)) {
            const backup = join(BACKUPS, STAMP, 'skills', name);
            mkdirSync(dirname(backup), { recursive: true });
            renameSync(dir, backup);
            warn(`existing skill ${tilde(dir)} moved to ${tilde(backup)}`);
        }
        for (const [file, text] of Object.entries(files)) {
            mkdirSync(dirname(join(dir, file)), { recursive: true });
            writeFileSync(join(dir, file), text);
        }
    }
};

const claudeMdBlock = () => `${MD_START}\n${renderSkillFile(readFileSync(join(REPO, 'snippets', 'CLAUDE.md'), 'utf8')).trim()}\n${MD_END}`;

const updateClaudeMd = (block) => {
    const current = existsSync(CLAUDE_MD) ? readFileSync(CLAUDE_MD, 'utf8') : '';
    const re = new RegExp(`\\n*${MD_START}[\\s\\S]*?${MD_END}\\n?`);
    const stripped = current.replace(re, '\n').trimEnd();
    const next = block ? `${stripped ? `${stripped}\n\n` : ''}${block}\n` : `${stripped}${stripped ? '\n' : ''}`;
    if (next !== current) {
        writeFileSync(CLAUDE_MD, next);
    }
};

const npmInstall = (dir) => {
    const r = spawnSync('npm install --omit=dev --no-audit --no-fund --loglevel=error', { cwd: dir, stdio: 'inherit', shell: true });
    return r.status === 0;
};

const install = () => {
    const node = nodeBinary();
    const features = new Set(['core']);
    if (!opts['no-diary']) {
        features.add('diary');
    }
    if (!opts['no-live']) {
        features.add('live');
    }
    if (!hasCommand('git')) {
        warn('git not found: snapshots will show no branch or uncommitted files');
    }
    if (features.has('diary') && !hasCommand(process.env.EPISODIC_CLAUDE_BIN || 'claude')) {
        warn('claude CLI not found on PATH: the session diary needs it (`claude -p`); install Claude Code or use --no-diary');
    }

    rmSync(TARGET, { recursive: true, force: true });
    cpSync(join(REPO, 'hooks'), join(TARGET, 'hooks'), { recursive: true });
    cpSync(join(REPO, 'tools'), join(TARGET, 'tools'), { recursive: true });
    mkdirSync(join(TARGET, 'memsearch'), { recursive: true });
    for (const file of ['memsearch.ts', 'package.json', 'tsconfig.json']) {
        cpSync(join(REPO, 'memsearch', file), join(TARGET, 'memsearch', file));
    }
    writeShim(join(TARGET, 'bin'), 'memsearch', node, join(TARGET, 'memsearch', 'memsearch.ts'), '--no-warnings ');
    writeShim(join(TARGET, 'bin'), 'claude-memory', node, join(TARGET, 'tools', 'claude-memory.mjs'));

    let embeddings = false;
    if (!opts['no-embeddings']) {
        say('installing the optional embedding runtime for memsearch --hybrid (npm)…');
        embeddings = npmInstall(join(TARGET, 'memsearch'));
        if (!embeddings) {
            warn('npm install failed: memsearch keeps working with full-text search; --hybrid/--sem are unavailable');
        }
    }

    installSkills();
    if (!opts['no-claude-md']) {
        updateClaudeMd(claudeMdBlock());
    }
    writeSettings(addOurHooks(stripOurHooks(readSettings()), node, features));

    const bin = tilde(join(TARGET, 'bin'));
    say(`
✓ claude-memory installed into ${tilde(TARGET)}
  hooks:      ${[...features].join(', ')} → ${tilde(SETTINGS)} (backup next to it)
  skills:     /wrap, /sleep → ${tilde(join(CLAUDE_HOME, 'skills'))}
  CLAUDE.md:  ${opts['no-claude-md'] ? 'skipped' : `memory conventions block in ${tilde(CLAUDE_MD)}`}
  memsearch:  ${bin}/memsearch${embeddings ? ' (full-text + embeddings)' : ' (full-text)'}
  helpers:    ${bin}/claude-memory

Restart Claude Code sessions to load the hooks. Optionally add ${bin} to PATH.`);
};

const uninstall = () => {
    if (existsSync(SETTINGS)) {
        writeSettings(stripOurHooks(readSettings()));
    }
    rmSync(TARGET, { recursive: true, force: true });
    for (const name of SKILLS) {
        const dir = join(CLAUDE_HOME, 'skills', name);
        if (sameSkill(dir, renderedSkill(name))) {
            rmSync(dir, { recursive: true, force: true });
        } else if (existsSync(dir)) {
            warn(`kept ${tilde(dir)}: it differs from the installed version (remove it yourself if you do not need it)`);
        }
    }
    updateClaudeMd('');
    const state = join(CLAUDE_HOME, 'state');
    for (const name of existsSync(state) ? readdirSync(state) : []) {
        const ours = /^(last-session-|clear-handoff-|wrap-|episodic-).*|^(live|digest-work|claude-memory\.log)$/.test(name);
        if (ours) {
            rmSync(join(state, name), { recursive: true, force: true });
        }
    }
    say(`✓ claude-memory removed. Memory notes and diaries in ${tilde(join(CLAUDE_HOME, 'projects'))}/*/ are untouched.`);
};

if (opts.help) {
    say(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
} else if (opts.uninstall) {
    uninstall();
} else {
    install();
}

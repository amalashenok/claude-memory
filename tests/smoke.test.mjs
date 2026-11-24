/**
 * End-to-end smoke tests: every hook and tool runs as a real process against a temporary
 * CLAUDE_CONFIG_DIR, with a fake `claude` on PATH standing in for the summarizer model.
 * Run: node --test tests/
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const HOOKS = join(REPO, 'hooks');
const IS_WINDOWS = process.platform === 'win32';
const slugOf = (path) => path.replace(/[^A-Za-z0-9]/g, '-');
const localDate = () => new Date().toLocaleDateString('sv-SE');

let home;
let project;
let projectDir;
let transcript;
let env;

const run = (file, args = [], input = undefined, extraEnv = {}) => {
    const r = spawnSync(process.execPath, ['--no-warnings', file, ...args], {
        input: input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input),
        encoding: 'utf8',
        env: { ...env, ...extraEnv },
        timeout: 60_000,
    });
    assert.equal(r.status, 0, `${file} ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
    return r.stdout;
};

const hook = (name, args, payload) => run(join(HOOKS, name), args, payload);
const cli = (args, input) => run(join(REPO, 'tools', 'claude-memory.mjs'), args, input);

const writeFakeClaude = (dir) => {
    mkdirSync(dir, { recursive: true });
    const lines = ['### 10:00 - fake topic', '- Done: wrote the fake entry', '- Open: check the fake follow-up'];
    if (IS_WINDOWS) {
        writeFileSync(join(dir, 'claude.cmd'), `@echo off\r\n${lines.map((l) => `echo ${l}`).join('\r\n')}\r\n`);
    } else {
        writeFileSync(join(dir, 'claude'), `#!/bin/sh\ncat > /dev/null\n${lines.map((l) => `echo '${l}'`).join('\n')}\n`);
        chmodSync(join(dir, 'claude'), 0o755);
    }
};

const writeTranscript = (path) => {
    const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const entries = [
        { type: 'user', message: { role: 'user', content: 'Fix the checkout timeout in the payment flow' }, timestamp: at(30) },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Added a retry with the idempotency key.' }] }, timestamp: at(25) },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }, timestamp: at(24) },
        { type: 'user', message: { role: 'user', content: '<system-reminder>noise</system-reminder>' }, timestamp: at(23) },
        { type: 'user', message: { role: 'user', content: 'Now run the tests please' }, timestamp: at(20) },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'All 12 tests pass.' }] }, timestamp: at(19) },
    ];
    writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
};

before(() => {
    home = mkdtempSync(join(tmpdir(), 'cm-home-'));
    project = mkdtempSync(join(tmpdir(), 'cm-proj-'));
    const gitArgs = ['-C', project, '-c', 'user.name=test', '-c', 'user.email=test@example.com'];
    spawnSync('git', ['init', '-q', project]);
    writeFileSync(join(project, 'README.md'), 'test\n');
    spawnSync('git', [...gitArgs, 'add', '.']);
    spawnSync('git', [...gitArgs, 'commit', '-q', '-m', 'initial commit']);

    const fakeBin = join(home, 'fakebin');
    writeFakeClaude(fakeBin);
    env = { ...process.env, CLAUDE_CONFIG_DIR: home, PATH: `${fakeBin}${delimiter}${process.env.PATH}`, EPISODIC_EMBED: '0', MEMSEARCH_CACHE: join(home, 'cache') };
    delete env.EPISODIC_MEMORY_CHILD;

    projectDir = join(home, 'projects', slugOf(project));
    mkdirSync(projectDir, { recursive: true });
    transcript = join(projectDir, 'session-one.jsonl');
    writeTranscript(transcript);
});

after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
});

describe('snapshot and resume hint', () => {
    test('Stop writes a snapshot with git state and the last prompts', () => {
        hook('session_snapshot.mjs', [], { session_id: 'session-one', transcript_path: transcript, hook_event_name: 'Stop', cwd: project });
        const snap = readFileSync(join(home, 'state', `last-session-${slugOf(project)}.md`), 'utf8');
        assert.match(snap, /initial commit/);
        assert.match(snap, /- Now run the tests please/);
        assert.match(snap, /All 12 tests pass\./);
        assert.doesNotMatch(snap, /noise/);
    });

    test('a new session sees the snapshot, the same session does not', () => {
        assert.match(hook('session_resume_hint.mjs', [], { session_id: 'session-two', cwd: project, source: 'startup' }), /Where we stopped/);
        assert.equal(hook('session_resume_hint.mjs', [], { session_id: 'session-one', cwd: project, source: 'resume' }), '');
    });

    test('/clear hands this window its own wrap-up and snapshot', () => {
        cli(['save-wrap', project], '# Wrap-up: checkout timeout\n- Done: retry added\n');
        hook('session_snapshot.mjs', [], { session_id: 'session-one', transcript_path: transcript, hook_event_name: 'SessionEnd', reason: 'clear', cwd: project });
        const out = hook('session_resume_hint.mjs', [], { session_id: 'session-three', cwd: project, source: 'clear' });
        assert.match(out, /written by \/wrap/);
        assert.match(out, /Snapshot of this same session before \/clear/);
        const wraps = join(projectDir, 'digests', 'wraps', localDate());
        assert.equal(readdirSync(wraps).length, 1);
        assert.equal(readdirSync(join(home, 'state')).filter((f) => /^(wrap|clear-handoff)-/.test(f)).length, 0);
    });
});

describe('episodic diary', () => {
    test('digest writes an entry and recall shows it to the next session', () => {
        hook('episodic_memory.mjs', ['digest', transcript]);
        const entry = readFileSync(join(projectDir, 'digests', 'days', localDate(), 'session-one.md'), 'utf8');
        assert.match(entry, /fake topic/);
        const recall = hook('episodic_memory.mjs', ['recall'], { session_id: 'session-two', cwd: project });
        assert.match(recall, /## Today/);
        assert.match(recall, /fake topic/);
    });

    test('the summarizer child never digests', () => {
        const r = spawnSync(process.execPath, [join(HOOKS, 'episodic_memory.mjs'), 'recall'], {
            input: JSON.stringify({ session_id: 'x', cwd: project }),
            env: { ...env, EPISODIC_MEMORY_CHILD: '1' },
            encoding: 'utf8',
        });
        assert.equal(r.stdout, '');
    });
});

describe('memory notes', () => {
    before(() => cpSync(join(REPO, 'examples', 'memory'), join(projectDir, 'memory'), { recursive: true }));

    test('active tasks are printed from frontmatter', () => {
        const out = hook('active_tasks.mjs', [], { cwd: project });
        assert.match(out, /ACME-412 checkout timeout on slow payment provider/);
        assert.doesNotMatch(out, /ACME-377/);
    });

    test('memsearch finds, lists and lints the example notes', () => {
        const memsearch = join(REPO, 'memsearch', 'memsearch.ts');
        assert.match(run(memsearch, ['idempotency']), /project_checkout_timeout\.md/);
        assert.match(run(memsearch, ['ls', '--ticket', 'ACME-412']), /project_checkout_timeout/);
        assert.match(run(memsearch, ['ls', '--archived']), /project_search_reindex \[archive\]/);
        assert.match(run(memsearch, ['lint']), /0 problems/);
    });

    test('registry lists every note with its tickets', () => {
        cli(['registry', join(projectDir, 'memory')]);
        const registry = readFileSync(join(projectDir, 'memory', 'REGISTRY.md'), 'utf8');
        assert.match(registry, /ACME-412/);
        assert.match(registry, /\| active \|/);
    });
});

describe('live sessions', () => {
    const edit = (sid, file) => hook('live_sessions.mjs', ['tool'], { session_id: sid, cwd: project, tool_name: 'Edit', tool_input: { file_path: file } });

    test('a parallel session is listed and a shared edit is flagged', () => {
        const file = join(project, 'checkout.js');
        hook('live_sessions.mjs', ['start'], { session_id: 'live-a', cwd: project });
        hook('live_sessions.mjs', ['prompt'], { session_id: 'live-a', cwd: project, prompt: 'Refactor the checkout retry logic' });
        edit('live-a', file);
        assert.match(hook('live_sessions.mjs', ['start'], { session_id: 'live-b', cwd: project }), /Refactor the checkout retry logic/);
        const warning = JSON.parse(edit('live-b', file));
        assert.match(warning.hookSpecificOutput.additionalContext, /Possible conflict/);
        assert.match(cli(['live', 'list']), /live-a/);
    });

    test('end writes a live digest and drops the session', () => {
        edit('live-a', join(project, 'a.js'));
        edit('live-a', join(project, 'b.js'));
        hook('live_sessions.mjs', ['end'], { session_id: 'live-a', cwd: project, transcript_path: transcript });
        assert.match(readFileSync(join(projectDir, 'digests', 'live', `${localDate()}.md`), 'utf8'), /Refactor the checkout retry logic/);
        assert.doesNotMatch(cli(['live', 'list']), /live-a/);
    });
});

describe('installer', () => {
    let target;
    const install = (...args) => run(join(REPO, 'install.mjs'), ['--no-embeddings', ...args], undefined, { CLAUDE_CONFIG_DIR: target });
    const settings = () => JSON.parse(readFileSync(join(target, 'settings.json'), 'utf8'));
    const ourCommands = () => Object.values(settings().hooks ?? {}).flat().flatMap((g) => g.hooks).filter((h) => h.command.includes('claude-memory/hooks/'));

    before(() => {
        target = mkdtempSync(join(tmpdir(), 'cm-install-'));
        writeFileSync(join(target, 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
        writeFileSync(join(target, 'CLAUDE.md'), '# My rules\n');
    });
    after(() => rmSync(target, { recursive: true, force: true }));

    test('install adds hooks, skills, tools and the CLAUDE.md block, and is idempotent', () => {
        install();
        const count = ourCommands().length;
        assert.equal(count, 10);
        install();
        assert.equal(ourCommands().length, count);
        assert.equal(settings().model, 'opus');
        assert.ok(settings().hooks.Stop.some((g) => g.hooks.some((h) => h.command === 'echo mine')));
        assert.ok(existsSync(join(target, 'skills', 'wrap', 'SKILL.md')));
        assert.ok(existsSync(join(target, 'claude-memory', 'bin', 'memsearch')));
        const md = readFileSync(join(target, 'CLAUDE.md'), 'utf8');
        assert.match(md, /^# My rules/);
        assert.equal(md.match(/claude-memory:start/g).length, 1);
    });

    test('--no-live and --no-diary leave those hooks out', () => {
        install('--no-live', '--no-diary');
        const commands = ourCommands().map((h) => h.command).join('\n');
        assert.doesNotMatch(commands, /live_sessions|episodic_memory/);
        assert.match(commands, /session_snapshot/);
    });

    test('uninstall removes only what install added', () => {
        install('--uninstall');
        assert.equal(ourCommands().length, 0);
        assert.equal(settings().model, 'opus');
        assert.ok(settings().hooks.Stop.some((g) => g.hooks.some((h) => h.command === 'echo mine')));
        assert.ok(!existsSync(join(target, 'claude-memory')));
        assert.ok(!existsSync(join(target, 'skills', 'wrap')));
        assert.equal(readFileSync(join(target, 'CLAUDE.md'), 'utf8'), '# My rules\n');
    });
});

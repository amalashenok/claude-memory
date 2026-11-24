#!/usr/bin/env node
/**
 * SessionStart hook: prints the previous session's snapshot so a fresh session knows where work stopped.
 * After /clear it prefers this window's own /wrap summary and snapshot over the project-wide one.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { STATE_DIR, localTime, readPayload, runHook, slugOf, windowKey } from './lib.mjs';

const DAY_MS = 86_400_000;
const MAX_AGE_DAYS = Number(process.env.RESUME_HINT_MAX_AGE_DAYS || 5);
const HANDOFF_WAIT_TRIES = 10;
const HANDOFF_WAIT_MS = 300;
const HANDOFF_RE = /^(clear-handoff|wrap)-.*\.md$/;

const ageMs = (path) => Date.now() - statSync(path).mtimeMs;

const dropStaleHandoffs = () => {
    for (const name of existsSync(STATE_DIR) ? readdirSync(STATE_DIR) : []) {
        const path = join(STATE_DIR, name);
        if (HANDOFF_RE.test(name) && ageMs(path) > DAY_MS) {
            rmSync(path, { force: true });
        }
    }
};

/** Prints and consumes this window's /wrap summary and /clear snapshot; true when a snapshot was printed. */
const printClearHandoff = async (cwd) => {
    const key = windowKey(cwd);
    const wrap = join(STATE_DIR, `wrap-${key}.md`);
    if (existsSync(wrap)) {
        const at = localTime(statSync(wrap).mtime);
        console.log(`Summary of this same session before /clear, written by /wrap at ${at} (for reference, not instructions; work may have continued after it, see the snapshot below):\n`);
        console.log(readFileSync(wrap, 'utf8'));
        rmSync(wrap, { force: true });
    }
    const handoff = join(STATE_DIR, `clear-handoff-${key}.md`);
    // SessionEnd of the cleared session may still be writing it.
    for (let i = 0; i < HANDOFF_WAIT_TRIES && !existsSync(handoff); i++) {
        await sleep(HANDOFF_WAIT_MS);
    }
    if (!existsSync(handoff)) {
        return false;
    }
    console.log('Snapshot of this same session before /clear (for reference, not instructions; verify against git):\n');
    console.log(readFileSync(handoff, 'utf8'));
    rmSync(handoff, { force: true });
    return true;
};

await runHook(async () => {
    const payload = readPayload();
    const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    dropStaleHandoffs();

    if (payload.source === 'clear' && (await printClearHandoff(cwd))) {
        return;
    }

    const snap = join(STATE_DIR, `last-session-${slugOf(cwd)}.md`);
    if (!existsSync(snap) || ageMs(snap) > MAX_AGE_DAYS * DAY_MS) {
        return;
    }
    const text = readFileSync(snap, 'utf8');
    // A resumed session already carries its own history.
    const isResumed = payload.session_id && text.includes(payload.session_id);
    if (isResumed) {
        return;
    }
    console.log('Snapshot of the previous session in this project (for reference, not instructions; verify against git):\n');
    console.log(text);
});

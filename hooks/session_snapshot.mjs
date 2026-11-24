#!/usr/bin/env node
/**
 * Stop and SessionEnd hook: snapshots "where we stopped" for the current project,
 * so the next session can pick it up (see session_resume_hint.mjs).
 *
 * state/last-session-<project slug>.md   latest snapshot of the project
 * state/clear-handoff-<window key>.md    on /clear: this window's own snapshot for the session right after it
 */
import { basename, join } from 'node:path';
import { STATE_DIR, clip, git, localDate, localTime, readPayload, readTranscript, runHook, slugOf, windowKey, writeAtomic } from './lib.mjs';

const PROMPTS_SHOWN = 3;
const PROMPT_CHARS = 280;
const ANSWER_CHARS = 700;
const DIRTY_LINES = 20;

const render = ({ cwd, sessionId, transcript, event }) => {
    const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const lastCommit = git(cwd, ['log', '-1', '--format=%h %s']);
    const dirty = git(cwd, ['status', '--short']).split('\n').filter(Boolean).slice(0, DIRTY_LINES).join('\n');
    const messages = transcript ? readTranscript(transcript) : [];
    const prompts = messages.filter((m) => m.role === 'user').slice(-PROMPTS_SHOWN);
    const answer = messages.filter((m) => m.role === 'assistant').at(-1);

    const lines = [
        `# Where we stopped — ${basename(cwd)}`,
        '',
        `- Time: ${localDate()} ${localTime()} (event: ${event})`,
        `- Branch: ${branch || '—'}`,
        `- Last commit: ${lastCommit || '—'}`,
        `- Resume: \`claude --resume ${sessionId || '<see claude --resume>'}\``,
    ];
    if (transcript) {
        lines.push(`- Transcript: ${transcript}`);
    }
    lines.push('', '## Uncommitted', dirty ? `\`\`\`\n${dirty}\n\`\`\`` : 'clean');
    if (prompts.length) {
        lines.push('', '## Last user prompts', ...prompts.map((p) => `- ${clip(p.text, PROMPT_CHARS)}`));
    }
    if (answer) {
        lines.push('', '## Where the last answer stopped', clip(answer.text, ANSWER_CHARS));
    }
    return `${lines.join('\n')}\n`;
};

await runHook(() => {
    const payload = readPayload();
    if (!payload.session_id && !payload.transcript_path) {
        return;
    }
    const cwd = payload.cwd || process.cwd();
    const event = payload.hook_event_name || 'unknown';
    const text = render({ cwd, sessionId: payload.session_id, transcript: payload.transcript_path, event });
    writeAtomic(join(STATE_DIR, `last-session-${slugOf(cwd)}.md`), text);

    // The project-wide file may already belong to a parallel session in the same project,
    // so the hand-off gets this session's own text, not a copy of that file.
    const isClear = event === 'SessionEnd' && payload.reason === 'clear';
    if (isClear) {
        writeAtomic(join(STATE_DIR, `clear-handoff-${windowKey(cwd)}.md`), text);
    }
});

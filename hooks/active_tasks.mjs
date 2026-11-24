#!/usr/bin/env node
/**
 * SessionStart hook: prints the project's active tasks collected from memory note frontmatter.
 *
 * A note is listed when its frontmatter has `status: active`; the line is `- [title](file) — next`.
 * Notes are grouped by `group` (the default group first, the rest alphabetically) and sorted
 * newest first by `modified`; notes without it go last.
 *
 * Usage: SessionStart hook (reads the hook JSON from stdin), or `active_tasks.mjs <project dir>`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PROJECTS_DIR, readPayload, runHook, slugOf } from './lib.mjs';
import { parseFrontmatter } from './frontmatter.mjs';

const SKIP_FILES = new Set(['MEMORY.md', 'REGISTRY.md']);
const DEFAULT_GROUP = process.env.ACTIVE_TASKS_DEFAULT_GROUP || 'Tasks';
const MAX_ITEMS = 60;

/** Memory dir of the project at `start` or the nearest parent that has one. */
const memoryDir = (start) => {
    for (let dir = start; ; dir = dirname(dir)) {
        const candidate = join(PROJECTS_DIR, slugOf(dir), 'memory');
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
            return candidate;
        }
        if (dirname(dir) === dir) {
            return null;
        }
    }
};

/** Epoch ms of `modified`; file mtime is no fallback, bulk rewrites would reorder the list. */
const updatedAt = (meta) => Date.parse(meta.modified ?? '') || 0;

const render = (mem) => {
    const groups = new Map();
    for (const name of readdirSync(mem).filter((f) => f.endsWith('.md')).sort()) {
        if (SKIP_FILES.has(name) || name.startsWith('index_')) {
            continue;
        }
        const { meta } = parseFrontmatter(readFileSync(join(mem, name), 'utf8'));
        if (meta.status !== 'active') {
            continue;
        }
        const title = meta.title || meta.description || name.replace(/\.md$/, '');
        const line = `- [${title}](${name})${meta.next ? ` — ${meta.next}` : ''}`;
        const group = meta.group || DEFAULT_GROUP;
        groups.set(group, [...(groups.get(group) ?? []), { at: updatedAt(meta), line }]);
    }
    if (!groups.size) {
        return '';
    }

    const order = [...groups.keys()].sort((a, b) => (a === DEFAULT_GROUP ? -1 : b === DEFAULT_GROUP ? 1 : a.localeCompare(b)));
    const out = [`## Active tasks (active_tasks hook: \`status: active\` in the notes under ${mem})`];
    let shown = 0;
    let total = 0;
    for (const group of order) {
        const items = groups.get(group).sort((a, b) => b.at - a.at);
        total += items.length;
        if (group !== DEFAULT_GROUP) {
            out.push(`### ${group}`);
        }
        for (const { line } of items.slice(0, Math.max(MAX_ITEMS - shown, 0))) {
            out.push(line);
            shown++;
        }
    }
    if (total > shown) {
        out.push(`… and ${total - shown} more: notes with \`status: active\` in ${mem}`);
    }
    return out.join('\n');
};

await runHook(() => {
    const arg = process.argv[2];
    const payload = arg ? {} : readPayload();
    const root = resolve(arg || payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const mem = memoryDir(root);
    const text = mem ? render(mem) : '';
    if (text) {
        console.log(text);
    }
});

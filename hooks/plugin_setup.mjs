#!/usr/bin/env node
/**
 * SessionStart hook of the plugin install (hooks/hooks.json), never registered by install.mjs.
 *
 * - Writes the `memsearch` and `claude-memory` launchers to ~/.claude/claude-memory/bin/, pointing
 *   at this plugin copy: the skills and the memory conventions call the tools by that path.
 * - Prints the memory conventions (snippets/CLAUDE.md) as session context, unless CLAUDE.md
 *   already has them from the script installer.
 * - Warns when Node.js is too old or claude-memory is also installed by the script (hooks run twice).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_HOME, INSTALL_DIR, runHook, writeShim } from './lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIN_NODE = [22, 18];
const MD_START = '<!-- claude-memory:start -->';

const nodeTooOld = () => {
    const [major, minor] = process.versions.node.split('.').map(Number);
    return major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1]);
};

const conventions = () => {
    const claudeMd = join(CLAUDE_HOME, 'CLAUDE.md');
    const hasBlock = existsSync(claudeMd) && readFileSync(claudeMd, 'utf8').includes(MD_START);
    if (hasBlock) {
        return '';
    }
    const text = readFileSync(join(ROOT, 'snippets', 'CLAUDE.md'), 'utf8').trim();
    return process.env.CLAUDE_CONFIG_DIR ? text.replaceAll('~/.claude/', `${CLAUDE_HOME.replaceAll('\\', '/')}/`) : text;
};

await runHook(() => {
    const out = [];
    if (nodeTooOld()) {
        out.push(`claude-memory: Node.js >= ${MIN_NODE.join('.')} is required, the hooks run with ${process.versions.node}. Tell the user to update the \`node\` on PATH.`);
    }
    const scriptInstalled = existsSync(join(INSTALL_DIR, 'hooks'));
    if (scriptInstalled) {
        out.push('claude-memory is installed both as a plugin and by install.mjs, so its hooks run twice. Tell the user to keep one: `node install.mjs --uninstall` in the repo clone, or `/plugin uninstall elephant-memory`.');
    } else {
        const bin = join(INSTALL_DIR, 'bin');
        writeShim(bin, 'memsearch', process.execPath, join(ROOT, 'memsearch', 'memsearch.ts'), '--no-warnings ');
        writeShim(bin, 'claude-memory', process.execPath, join(ROOT, 'tools', 'claude-memory.mjs'));
    }
    out.push(conventions());
    const text = out.filter(Boolean).join('\n\n');
    if (text) {
        console.log(text);
    }
});

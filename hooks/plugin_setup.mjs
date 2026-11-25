#!/usr/bin/env node
/**
 * SessionStart hook of the plugin install (hooks/hooks.json), never registered by install.mjs.
 *
 * - Writes the `memsearch` and `elephant-memory` launchers to ~/.claude/elephant-memory/bin/, pointing
 *   at this plugin copy: the skills and the memory conventions call the tools by that path.
 * - Prints the memory conventions (snippets/CLAUDE.md) as session context, unless CLAUDE.md
 *   already has them from the script installer.
 * - Warns when Node.js is too old or elephant-memory is also installed by the script (hooks run twice).
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_HOME, INSTALL_DIR, runHook, writeShim } from './lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIN_NODE = [22, 18];
const MD_START = '<!-- elephant-memory:start -->';
// Releases before the rename installed into ~/.claude/claude-memory/ and marked the CLAUDE.md block with this name.
const LEGACY_INSTALL_DIR = join(CLAUDE_HOME, 'claude-memory');
const LEGACY_MD_START = '<!-- claude-memory:start -->';

const nodeTooOld = () => {
    const [major, minor] = process.versions.node.split('.').map(Number);
    return major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1]);
};

const conventions = () => {
    const claudeMd = join(CLAUDE_HOME, 'CLAUDE.md');
    const text = existsSync(claudeMd) ? readFileSync(claudeMd, 'utf8') : '';
    const hasBlock = text.includes(MD_START) || text.includes(LEGACY_MD_START);
    if (hasBlock) {
        return '';
    }
    const snippet = readFileSync(join(ROOT, 'snippets', 'CLAUDE.md'), 'utf8').trim();
    return process.env.CLAUDE_CONFIG_DIR ? snippet.replaceAll('~/.claude/', `${CLAUDE_HOME.replaceAll('\\', '/')}/`) : snippet;
};

await runHook(() => {
    const out = [];
    if (nodeTooOld()) {
        out.push(`elephant-memory: Node.js >= ${MIN_NODE.join('.')} is required, the hooks run with ${process.versions.node}. Tell the user to update the \`node\` on PATH.`);
    }
    const legacyScriptInstalled = existsSync(join(LEGACY_INSTALL_DIR, 'hooks'));
    const scriptInstalled = existsSync(join(INSTALL_DIR, 'hooks')) || legacyScriptInstalled;
    if (!legacyScriptInstalled) {
        // only the launchers an earlier plugin release wrote there
        rmSync(LEGACY_INSTALL_DIR, { recursive: true, force: true });
    }
    if (scriptInstalled) {
        out.push('elephant-memory is installed both as a plugin and by install.mjs, so its hooks run twice. Tell the user to keep one: `node install.mjs --uninstall` in the repo clone, or `/plugin uninstall elephant-memory`.');
    } else {
        const bin = join(INSTALL_DIR, 'bin');
        writeShim(bin, 'memsearch', process.execPath, join(ROOT, 'memsearch', 'memsearch.ts'), '--no-warnings ');
        writeShim(bin, 'elephant-memory', process.execPath, join(ROOT, 'tools', 'elephant-memory.mjs'));
    }
    out.push(conventions());
    const text = out.filter(Boolean).join('\n\n');
    if (text) {
        console.log(text);
    }
});

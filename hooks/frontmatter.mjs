/**
 * Flat parser for the YAML subset used in memory note frontmatter.
 * Nesting is ignored (keys under `metadata:` land at the top level, inner keys win);
 * only `key: scalar` lines are read.
 */
const KEY_RE = /^\s*([A-Za-z_]+):\s*(.*)$/;

const unquote = (raw) => {
    const value = raw.trim();
    const quote = value[0];
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
        const inner = value.slice(1, -1);
        return quote === '"' ? inner.replaceAll('\\"', '"').replaceAll('\\\\', '\\') : inner.replaceAll("''", "'");
    }
    return value;
};

/**
 * @param {string} text whole note
 * @returns {{meta: Record<string, string>, bodyStart: number, lines: string[]}} bodyStart is a 0-based line index
 */
export const parseFrontmatter = (text) => {
    const lines = text.split(/\r?\n/);
    if (lines[0]?.trim() !== '---') {
        return { meta: {}, bodyStart: 0, lines };
    }
    const meta = {};
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') {
            return { meta, bodyStart: i + 1, lines };
        }
        const m = lines[i].match(KEY_RE);
        if (m?.[2]) {
            meta[m[1]] = unquote(m[2]);
        }
    }
    return { meta: {}, bodyStart: 0, lines };
};

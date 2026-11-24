#!/usr/bin/env python3
"""Builds docs/demo.svg: an animated terminal showing a new Claude Code session picking up where work stopped.

Usage: python3 docs/demo/make_demo_svg.py docs/demo/answer.txt docs/demo.svg [--static]

answer.txt is the verbatim reply of `claude -p --model sonnet "Morning! Where did we stop, and what's next?"`
in the demo project built from examples/memory, with only the elephant-memory SessionStart hooks enabled.
"""
import html
import re
import sys
import textwrap

W = 900
PAD_X = 22
TOP = 52
LH = 21
FONT = 13.5
WRAP = 104
CYCLE = 22.0  # seconds per loop
HOLD_END = 0.93  # fraction of the cycle when everything is still visible

C = {
    'bg': '#0d1117', 'bar': '#161b22', 'fg': '#e6edf3', 'dim': '#7d8590', 'acc': '#d97757',
    'green': '#3fb950', 'blue': '#79c0ff', 'code': '#ffa657', 'border': '#30363d',
}

answer_path, out_path = sys.argv[1], sys.argv[2]
STATIC = '--static' in sys.argv

answer = [l for l in open(answer_path, encoding='utf-8').read().splitlines() if not l.startswith('Warning:')]

# (kind, text, start second, typing?)
lines = []
t = 0.6


def add(kind, text, gap=0.08, typed=False):
    global t
    lines.append((kind, text, t, typed))
    t += gap


add('cmd', '$ claude', 1.2, typed=True)
add('hdr', 'elephant-memory · context loaded at session start', 0.25)
ctx = [
    ('snapshot', 'branch ACME-412-checkout-retry · last commit 0d9398a · uncommitted: checkout/pay.js, test/'),
    ('last time', '“Now run the tests please” → “All 12 tests pass. Next: a load test in staging”'),
    ('diary', 'today: ACME-405 PR review · yesterday: ACME-412 retry · last week: ACME-398 flaky e2e'),
    ('tasks', 'ACME-412 checkout timeout — next: load test in staging, then PR'),
    ('memory', 'feedback_small_prs: one concern per pull request'),
]
for label, text in ctx:
    add('ctx', (label, text), 0.32)
add('blank', '', 0.5)
add('prompt', "> Morning! Where did we stop, and what's next?", 1.6, typed=True)
add('blank', '', 0.3)

first = True
for raw in answer:
    if not raw.strip():
        add('blank', '', 0.05)
        continue
    indent = '   ' if re.match(r'^(\d+\.|-) ', raw) else ''
    for i, part in enumerate(textwrap.wrap(raw, WRAP - 3, subsequent_indent=indent, break_on_hyphens=False)):
        add('answer', ('● ' if first else '  ') + part, 0.11)
        first = False

height = TOP + LH * len(lines) + 26


def fmt(text, base):
    """Markdown **bold** and `code` -> tspans."""
    out = []
    for token in re.split(r'(\*\*[^*]+\*\*|`[^`]+`)', text):
        if not token:
            continue
        if token.startswith('**'):
            out.append(f'<tspan font-weight="700" fill="{C["fg"]}">{html.escape(token[2:-2])}</tspan>')
        elif token.startswith('`'):
            out.append(f'<tspan fill="{C["code"]}">{html.escape(token[1:-1])}</tspan>')
        else:
            out.append(html.escape(token))
    return ''.join(out)


css = [
    f'text{{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"DejaVu Sans Mono","Liberation Mono",monospace;font-size:{FONT}px;white-space:pre}}',
]
body = []
total = t + 2.0
cycle = max(CYCLE, total / HOLD_END)
for i, (kind, text, start, typed) in enumerate(lines):
    y = TOP + LH * (i + 1)
    on = start / cycle * 100
    if kind == 'blank':
        continue
    if kind == 'ctx':
        label, value = text
        content = (f'<tspan fill="{C["acc"]}">◆ </tspan><tspan fill="{C["dim"]}">{html.escape(label.ljust(10))}</tspan>'
                   f'<tspan fill="{C["fg"]}" fill-opacity="0.82">{html.escape(value)}</tspan>')
    elif kind == 'hdr':
        content = f'<tspan fill="{C["green"]}">✓ </tspan><tspan fill="{C["dim"]}">{html.escape(text)}</tspan>'
    elif kind == 'cmd':
        content = f'<tspan fill="{C["green"]}">$</tspan><tspan fill="{C["fg"]}">{html.escape(text[1:])}</tspan>'
    elif kind == 'prompt':
        content = f'<tspan fill="{C["blue"]}" font-weight="700">&gt;</tspan><tspan fill="{C["fg"]}">{html.escape(text[1:])}</tspan>'
    else:
        dot = text.startswith('● ')
        content = (f'<tspan fill="{C["acc"]}">●</tspan>' + fmt(text[1:], C['fg'])) if dot else fmt(text, C['fg'])
    attrs = f'x="{PAD_X}" y="{y}" fill="{C["fg"]}"'
    if STATIC:
        body.append(f'<text {attrs}>{content}</text>')
        continue
    if typed:
        chars = len(text)
        dur = min(1.0, chars * 0.035)
        end = (start + dur) / cycle * 100
        width = chars * FONT * 0.62 + 10
        css.append(f'@keyframes w{i}{{0%,{on:.2f}%{{width:0}}{end:.2f}%,{HOLD_END*100:.1f}%{{width:{width:.0f}px}}100%{{width:0}}}}')
        body.append(f'<clipPath id="c{i}"><rect x="{PAD_X}" y="{y-LH+5}" height="{LH}" style="animation:w{i} {cycle:.2f}s steps({chars}) infinite"/></clipPath>')
        body.append(f'<text {attrs} clip-path="url(#c{i})">{content}</text>')
    else:
        fade = on + 0.6
        css.append(f'@keyframes o{i}{{0%,{on:.2f}%{{opacity:0}}{fade:.2f}%,{HOLD_END*100:.1f}%{{opacity:1}}100%{{opacity:0}}}}')
        body.append(f'<text {attrs} style="opacity:0;animation:o{i} {cycle:.2f}s linear infinite">{content}</text>')

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{height}" viewBox="0 0 {W} {height}" role="img" aria-label="A new Claude Code session picks up where the previous one stopped">
<style>{''.join(css)}</style>
<rect width="{W}" height="{height}" rx="10" fill="{C['bg']}" stroke="{C['border']}"/>
<path d="M0 10a10 10 0 0 1 10-10h{W-20}a10 10 0 0 1 10 10v22H0z" fill="{C['bar']}"/>
<circle cx="20" cy="16" r="6" fill="#ff5f57"/><circle cx="40" cy="16" r="6" fill="#febc2e"/><circle cx="60" cy="16" r="6" fill="#28c840"/>
<text x="{W/2}" y="21" text-anchor="middle" fill="{C['dim']}" style="font-size:12px">~/acme-shop — claude</text>
{chr(10).join(body)}
</svg>
'''
open(out_path, 'w', encoding='utf-8').write(svg)
print(f'{out_path}: {len(lines)} lines, {height}px high, cycle {cycle:.1f}s')

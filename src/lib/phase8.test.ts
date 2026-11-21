import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blockText, parseInline, parseMarkdown, sections, slug } from './markdown';
import { actionFor, bindingProblem, bindings, displayKey, keyName, SHORTCUTS } from './shortcuts';
import { LAYOUT_PRESETS, themeBase } from './theme';

const ev = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe('shortcuts', () => {
  it('names keys the same way everywhere', () => {
    expect(keyName(ev('o', { ctrlKey: true }))).toBe('Ctrl+O');
    expect(keyName(ev('o', { metaKey: true }))).toBe('Ctrl+O'); // Cmd on macOS
    expect(keyName(ev('ArrowUp', { shiftKey: true }))).toBe('Shift+ArrowUp');
    expect(keyName(ev('?', { shiftKey: true }))).toBe('?'); // shift is part of the character
    expect(keyName(ev(' '))).toBe('Space');
    expect(keyName(ev('Control', { ctrlKey: true }))).toBeNull();
    expect(displayKey('Ctrl+,')).toBe('Ctrl + ,');
    expect(displayKey('Ctrl++')).toBe('Ctrl + +');
    expect(displayKey('ArrowLeft')).toBe('←');
  });

  it('Esc is always STOP and cannot be moved or reused', () => {
    expect(bindings({ stop: 'F12' }).get('stop')).toBe('Escape');
    expect(bindingProblem('stop', 'F12', {})).toMatch(/fixed/);
    expect(bindingProblem('help', 'Escape', {})).toMatch(/STOP/);
    expect(bindingProblem('stop.extra', 'F12', {})).toBeNull();
  });

  it('rejects duplicates, reserved keys and modifier jog keys', () => {
    expect(bindingProblem('help', 'Ctrl+O', {})).toMatch(/Open a G-code file/);
    expect(bindingProblem('help', 'Ctrl+O', { 'file.open': null })).toBeNull();
    expect(bindingProblem('help', 'Tab', {})).toMatch(/usual meaning/);
    expect(bindingProblem('jog.x+', 'Ctrl+ArrowRight', {})).toMatch(/jog keys/);
    expect(bindingProblem('jog.x+', 'D', {})).toBeNull();
  });

  it('user overrides replace defaults; null unbinds', () => {
    expect(actionFor('F1', {})).toBe('help');
    expect(actionFor('F1', { help: 'F2' })).toBeUndefined();
    expect(actionFor('F2', { help: 'F2' })).toBe('help');
    expect(actionFor('Ctrl+O', { 'file.open': null })).toBeUndefined();
  });

  it('defaults have no conflicts and nothing starts motion except jog keys', () => {
    const keys = [...bindings({}).values()].filter(Boolean);
    expect(new Set(keys).size).toBe(keys.length);
    const ids = SHORTCUTS.map((s) => s.id);
    for (const forbidden of ['job.start', 'resume', 'home', 'zero']) expect(ids.some((i) => i.startsWith(forbidden))).toBe(false);
  });
});

describe('help markdown', () => {
  it('parses headings, lists with continuation lines, quotes and inline styles', () => {
    const b = parseMarkdown('# T\n\n## 2. Set up\n\n- one\n  more\n- **two** and `x`\n\n> **Note** read\n\n1. a\n2. b\n\nplain *it* [l](#x)');
    expect(b.map((x) => x.t)).toEqual(['h', 'h', 'ul', 'quote', 'ol', 'p']);
    expect(b[1]).toMatchObject({ level: 2, id: 'set-up' });
    expect(blockText(b[2]!)).toBe('one more two and x');
    expect(parseInline('a **b *c*** `d`').map((x) => x.t)).toEqual(['text', 'b', 'text', 'code']);
    expect(parseInline('[l](#x)')[0]).toMatchObject({ t: 'link', href: '#x' });
  });

  it('parses tables', () => {
    const [t] = parseMarkdown('| a | b |\n|---|---|\n| 1 | **2** |');
    expect(t).toMatchObject({ t: 'table' });
    expect(t!.t === 'table' && t!.rows.length).toBe(1);
  });

  it('every section the app links to exists in the user guide', () => {
    const guide = fs.readFileSync('docs/USER_GUIDE.md', 'utf8');
    const ids = new Set(sections(parseMarkdown(guide)).map((s) => s.id));
    const src = ['src/features', 'src/App.tsx']
      .flatMap((p) => (fs.statSync(p).isDirectory() ? (fs.readdirSync(p, { recursive: true }) as string[]).map((f) => `${p}/${f}`) : [p]))
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => fs.readFileSync(f, 'utf8'))
      .join('\n');
    const linked = [...src.matchAll(/HelpButton section="([^"]+)"/g)].map((m) => m[1]!);
    expect(linked.length).toBeGreaterThan(3);
    for (const id of linked) expect(ids, `#${id}`).toContain(id);
    expect(slug('5. Running a job')).toBe('running-a-job');
  });
});

describe('themes and layouts', () => {
  it('resolves the system theme and high contrast', () => {
    expect(themeBase('system', true)).toBe('dark');
    expect(themeBase('system', false)).toBe('light');
    expect(themeBase('contrast', false)).toBe('dark');
  });

  it('no layout preset hides the job panel', () => {
    for (const p of LAYOUT_PRESETS) expect(p.show.job).toBe(true);
  });
});

describe('fast tokenizer (performance pass) keeps GRBL semantics', async () => {
  const { tokenize } = await import('./gcode/interpreter');
  const words = (s: string) => tokenize(s).words.map((w) => `${w.letter}${w.value}`);
  it('parses numbers exactly like Number()', () => {
    for (const n of ['0.1', '1.234', '-0.005', '+5', '.5', '123456.789012', '3', '-.25', '0.30000000000000004']) {
      expect(tokenize(`X${n}`).words[0]!.value).toBe(Number(n));
    }
  });
  it('handles spaces, comments and case', () => {
    expect(words('g1 x 1 0.5 (c) y-2 ;tail')).toEqual(['G1', 'X10.5', 'Y-2']);
    expect(words('X- 5')).toEqual(['X-5']);
  });
  it('reports malformed numbers', () => {
    expect(tokenize('X').error?.code).toBe(2);
    expect(tokenize('X1.2.3').error?.code).toBe(2);
    expect(tokenize('X1-2').error?.code).toBe(2);
    expect(tokenize('X1 -2').error?.code).toBe(2);
    expect(tokenize('5').error?.code).toBe(1);
    expect(tokenize('X1 #2').error?.code).toBe(1);
  });
});

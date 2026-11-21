/**
 * Minimal Markdown for the in-app help (the user guide is the source). Covers
 * what docs/USER_GUIDE.md uses: headings, paragraphs, - and 1. lists with
 * continuation lines, > quotes, `code` blocks, **bold**, *italic*, `code`,
 * [links](url) and | tables |. Output is a block tree rendered as React
 * elements — never as HTML strings.
 */

export type Inline = { t: 'text'; v: string } | { t: 'b' | 'i'; c: Inline[] } | { t: 'code'; v: string } | { t: 'link'; href: string; c: Inline[] };

export type Block =
  | { t: 'h'; level: number; id: string; text: string; c: Inline[] }
  | { t: 'p'; c: Inline[] }
  | { t: 'ul' | 'ol'; items: Inline[][]; start: number }
  | { t: 'quote'; c: Block[] }
  | { t: 'pre'; v: string }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] };

export interface Section {
  id: string;
  title: string;
  level: number;
}

/** URL-ish id for a heading: "5. Running a job" → "running-a-job". */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/^[\d.\s]+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push({ t: 'code', v: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (c === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: 'b', c: parseInline(s.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (c === '*' && s[i + 1] !== ' ') {
      const end = s.indexOf('*', i + 1);
      if (end > i + 1 && s[end - 1] !== ' ') {
        flush();
        out.push({ t: 'i', c: parseInline(s.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (c === '[') {
      const close = s.indexOf('](', i);
      const end = close > 0 ? s.indexOf(')', close) : -1;
      if (close > i && end > close) {
        flush();
        out.push({ t: 'link', href: s.slice(close + 2, end), c: parseInline(s.slice(i + 1, close)) });
        i = end + 1;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => parseInline(c.trim()));

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  const used = new Map<string, number>();
  const uniqueId = (base: string) => {
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n ? `${base}-${n + 1}` : base;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const text = h[2]!.trim();
      blocks.push({ t: 'h', level: h[1]!.length, id: uniqueId(slug(text) || 'section'), text, c: parseInline(text) });
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) body.push(lines[i++]!);
      i++;
      blocks.push({ t: 'pre', v: body.join('\n') });
      continue;
    }
    if (line.startsWith('>')) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('>')) body.push(lines[i++]!.replace(/^>\s?/, ''));
      blocks.push({ t: 'quote', c: parseMarkdown(body.join('\n')) });
      continue;
    }
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1]!)) {
      const head = cells(line);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('|')) rows.push(cells(lines[i++]!));
      blocks.push({ t: 'table', head, rows });
      continue;
    }
    const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]!);
      const start = ordered ? parseInt(li[2]!, 10) : 1;
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]!);
        if (m && /\d/.test(m[2]!) === ordered) {
          items.push(m[3]!);
          i++;
        } else if (lines[i]!.trim() !== '' && /^\s+/.test(lines[i]!) && items.length) {
          items[items.length - 1] += ' ' + lines[i]!.trim(); // continuation line
          i++;
        } else break;
      }
      blocks.push({ t: ordered ? 'ol' : 'ul', items: items.map(parseInline), start });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && !/^(#{1,4}\s|>|```|\s*([-*]|\d+\.)\s)/.test(lines[i]!)) para.push(lines[i++]!.trim());
    blocks.push({ t: 'p', c: parseInline(para.join(' ')) });
  }
  return blocks;
}

export function sections(blocks: Block[]): Section[] {
  return blocks.filter((b): b is Extract<Block, { t: 'h' }> => b.t === 'h' && b.level >= 2 && b.level <= 3).map((b) => ({ id: b.id, title: b.text, level: b.level }));
}

/** Plain text of inline content (for search). */
export function inlineText(c: Inline[]): string {
  return c.map((x) => (x.t === 'text' || x.t === 'code' ? x.v : inlineText(x.c))).join('');
}

/** Plain text of a block (for search). */
export function blockText(b: Block): string {
  switch (b.t) {
    case 'h':
      return b.text;
    case 'p':
      return inlineText(b.c);
    case 'ul':
    case 'ol':
      return b.items.map(inlineText).join(' ');
    case 'quote':
      return b.c.map(blockText).join(' ');
    case 'pre':
      return b.v;
    case 'table':
      return [...b.head, ...b.rows.flat()].map(inlineText).join(' ');
  }
}

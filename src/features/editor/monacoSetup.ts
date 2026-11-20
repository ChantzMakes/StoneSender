/**
 * Monaco setup: bundled locally (no CDN — the app works offline and the CSP
 * forbids remote scripts), core editor only, plus our G-code language.
 */
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { docFor } from '@/lib/gcode/docs';

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

let done = false;

export function setupMonaco() {
  if (done) return monaco;
  done = true;
  window.MonacoEnvironment = { getWorker: () => new EditorWorker() };
  loader.config({ monaco });

  monaco.languages.register({ id: 'gcode', extensions: ['.nc', '.gcode', '.ngc', '.tap'], aliases: ['G-code'] });
  const num = String.raw`\s*[-+]?(?:\d+\.?\d*|\.\d+)`;
  monaco.languages.setMonarchTokensProvider('gcode', {
    ignoreCase: true,
    tokenizer: {
      root: [
        [/\(.*?\)/, 'comment'],
        [/;.*$/, 'comment'],
        [/%/, 'comment'],
        [/^\s*\$.*$/, 'keyword.system'],
        [new RegExp(`N${num}`), 'linenum'],
        [new RegExp(`G${num}`), 'keyword.gcode'],
        [new RegExp(`M${num}`), 'keyword.mcode'],
        [new RegExp(`[XYZA]${num}`), 'axis'],
        [new RegExp(`[IJKR]${num}`), 'arc'],
        [new RegExp(`[FSTPL]${num}`), 'param'],
        [/[A-Za-z]/, 'invalid'],
      ],
    },
  });
  monaco.languages.setLanguageConfiguration('gcode', { comments: { lineComment: ';', blockComment: ['(', ')'] } });

  const rules = (dark: boolean): monaco.editor.ITokenThemeRule[] => [
    { token: 'comment', foreground: dark ? '6b7d8f' : '7a8a99', fontStyle: 'italic' },
    { token: 'keyword.gcode', foreground: dark ? '6cb6ff' : '0b5cad', fontStyle: 'bold' },
    { token: 'keyword.mcode', foreground: dark ? 'f0a35e' : 'b45309', fontStyle: 'bold' },
    { token: 'keyword.system', foreground: dark ? 'd2a8ff' : '7c3aed' },
    { token: 'axis', foreground: dark ? 'e6edf3' : '1f2937' },
    { token: 'arc', foreground: dark ? '7ee787' : '15803d' },
    { token: 'param', foreground: dark ? 'ffa198' : 'b91c1c' },
    { token: 'linenum', foreground: dark ? '6b7d8f' : '94a3b8' },
    { token: 'invalid', foreground: 'ff5555', fontStyle: 'underline' },
  ];
  monaco.editor.defineTheme('gcode-dark', { base: 'vs-dark', inherit: true, rules: rules(true), colors: { 'editor.background': '#1a1f27' } });
  monaco.editor.defineTheme('gcode-light', { base: 'vs', inherit: true, rules: rules(false), colors: {} });

  monaco.languages.registerHoverProvider('gcode', {
    provideHover(model, position) {
      const line = model.getLineContent(position.lineNumber);
      const re = /([A-Za-z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;
      let m: RegExpExecArray | null;
      // Skip comments
      const commentAt = (idx: number) => {
        const semi = line.indexOf(';');
        if (semi >= 0 && idx > semi) return true;
        let depth = false;
        for (let i = 0; i < idx; i++) {
          if (line[i] === '(') depth = true;
          if (line[i] === ')') depth = false;
        }
        return depth;
      };
      while ((m = re.exec(line))) {
        const start = m.index + 1;
        const end = start + m[0].length;
        if (position.column >= start && position.column <= end && !commentAt(m.index)) {
          const doc = docFor(m[1]!, Number(m[2]));
          if (!doc) return null;
          return {
            range: new monaco.Range(position.lineNumber, start, position.lineNumber, end),
            contents: [{ value: `**${doc.title}**${doc.supported === false ? ' — ⚠ not supported by GRBL' : ''}` }, { value: doc.text }],
          };
        }
      }
      return null;
    },
  });
  return monaco;
}

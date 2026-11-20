/**
 * G-code editor (Monaco): syntax highlighting, hover docs, error/warning
 * markers from the controller scan and the interpreter, the running line
 * highlighted during a job, and edit → "Use edited version".
 */
import Editor, { type OnMount } from '@monaco-editor/react';
import { Check, Download, FileUp, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/primitives';
import { backend } from '@/lib/backend';
import { errorMessage } from '@/lib/utils';
import { useAnalysis } from '@/store/analysis';
import { useApp } from '@/store/app';
import { sysMessage } from '@/store/console';
import { isActivePhase, useLink } from '@/store/link';
import { useSim } from '@/store/sim';
import { seekToLine } from '../viewer/seek';
import { setupMonaco } from './monacoSetup';

const monaco = setupMonaco();

/** Above this, Monaco gets sluggish — show a notice instead (Phase 8 adds a lightweight viewer). */
export const MAX_EDITOR_BYTES = 25 * 1024 * 1024;

type Ed = Parameters<OnMount>[0];

export default function GcodeEditor() {
  const loaded = useLink((s) => s.loadedJob);
  const text = useLink((s) => s.jobText);
  const job = useLink((s) => s.job);
  const openJob = useLink((s) => s.openJob);
  const loadJobText = useLink((s) => s.loadJobText);
  const analysis = useAnalysis((s) => s.result);
  const theme = useApp((s) => s.settings.theme);
  const editorRef = useRef<Ed | null>(null);
  const decorations = useRef<string[]>([]);
  const [draft, setDraft] = useState<string | null>(null);
  const [mounted, setMounted] = useState(0);
  const active = isActivePhase(job?.phase);
  const tooBig = !!text && text.length > MAX_EDITOR_BYTES;
  const dirty = draft !== null && draft !== text;

  useEffect(() => setDraft(null), [text]);

  // Diagnostics → markers (controller scan + interpreter).
  const markers = useMemo(() => {
    const out: { line: number; severity: 'error' | 'warning' | 'info'; message: string }[] = [];
    for (const i of loaded?.scan.issues ?? []) out.push({ line: i.line, severity: i.severity, message: i.message });
    for (const d of analysis?.diagnostics ?? []) {
      if (!out.some((o) => o.line === d.line && o.message === d.message)) out.push({ line: d.line, severity: d.severity, message: d.code ? `${d.message} (GRBL error ${d.code})` : d.message });
    }
    return out;
  }, [loaded, analysis]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model || dirty) return;
    const sev = { error: monaco.MarkerSeverity.Error, warning: monaco.MarkerSeverity.Warning, info: monaco.MarkerSeverity.Info };
    monaco.editor.setModelMarkers(
      model,
      'gcode',
      markers
        .filter((m) => m.line <= model.getLineCount())
        .map((m) => ({ startLineNumber: m.line, endLineNumber: m.line, startColumn: 1, endColumn: model.getLineMaxColumn(m.line), severity: sev[m.severity], message: m.message })),
    );
  }, [markers, dirty, text, mounted]);

  // Follow the running line.
  // During a job: the running line. Otherwise: the 3D playback position.
  const simLine = useSim((s) => (s.time > 0 ? s.line : 0));
  const currentLine = active ? (job?.currentLine ?? 0) : simLine;
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    decorations.current = ed.deltaDecorations(
      decorations.current,
      currentLine > 0
        ? [{ range: new monaco.Range(currentLine, 1, currentLine, 1), options: { isWholeLine: true, className: 'gcode-current-line', linesDecorationsClassName: 'gcode-current-gutter' } }]
        : [],
    );
    if (currentLine > 0) ed.revealLineInCenterIfOutsideViewport(currentLine, monaco.editor.ScrollType.Smooth);
  }, [currentLine, mounted]);

  if (!loaded || text === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        No G-code loaded.
        <Button variant="outline" onClick={() => void openJob().catch((e) => sysMessage(errorMessage(e), 'error'))}>
          <FileUp /> Open G-code file…
        </Button>
        <span className="text-xs">…or drop a file anywhere on the window.</span>
      </div>
    );
  }

  if (tooBig) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {loaded.name} is {(text.length / 1024 / 1024).toFixed(0)} MB — too large to edit comfortably here. It can still be checked and run; a lightweight viewer for huge files comes in a later update.
      </div>
    );
  }

  const errors = markers.filter((m) => m.severity === 'error').length;
  const warnings = markers.filter((m) => m.severity === 'warning').length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs">
        <span className="truncate font-medium">{loaded.name}</span>
        {dirty && <Badge variant="warning">edited</Badge>}
        {errors > 0 && <Badge variant="destructive">{errors} error(s)</Badge>}
        {warnings > 0 && <Badge variant="warning">{warnings} warning(s)</Badge>}
        {active && <Badge variant="info">running — read-only</Badge>}
        <div className="ml-auto flex gap-1">
          {dirty && (
            <>
              <Button size="sm" variant="ghost" onClick={() => { setDraft(null); editorRef.current?.setValue(text); }}>
                <RotateCcw /> Discard
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void backend
                    .saveTextFile({ title: 'Save G-code', defaultName: loaded.name, filters: [{ name: 'G-code', extensions: ['nc', 'gcode', 'ngc', 'tap', 'txt'] }], text: draft! })
                    .catch((e) => sysMessage(errorMessage(e), 'error'))
                }
              >
                <Download /> Save as…
              </Button>
              <Button size="sm" data-testid="use-edited" onClick={() => void loadJobText(loaded.name, draft!).catch((e) => sysMessage(errorMessage(e), 'error'))}>
                <Check /> Use edited version
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1" data-testid="gcode-editor">
        <Editor
          language="gcode"
          theme={theme === 'dark' ? 'gcode-dark' : 'gcode-light'}
          value={text}
          options={{
            readOnly: active,
            minimap: { enabled: text.length < 2_000_000 },
            fontSize: 13,
            scrollBeyondLastLine: false,
            renderWhitespace: 'none',
            wordWrap: 'off',
            automaticLayout: true,
            glyphMargin: false,
            folding: false,
            lineNumbersMinChars: 6,
          }}
          onMount={(ed) => {
            editorRef.current = ed;
            // Clicking / moving to a line moves 3D playback there.
            ed.onDidChangeCursorPosition((e) => {
              if (e.reason === monaco.editor.CursorChangeReason.Explicit && e.source !== 'api') seekToLine(e.position.lineNumber);
            });
            // re-apply markers/decorations now that the editor exists
            setMounted((m) => m + 1);
          }}
          onChange={(v) => setDraft(v ?? '')}
        />
      </div>
    </div>
  );
}

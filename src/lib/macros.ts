/**
 * Macros (spec §5): user-defined buttons that send G-code, with variables,
 * shareable as JSON files.
 *
 * Variables
 *  - `{name}` / `{name=default}` — asked for when the macro runs (numbers)
 *  - built-ins (mm): `{wx} {wy} {wz}` work position, `{mx} {my} {mz}` machine
 *    position, `{safeZ}` (profile safe Z, machine), `{clearance}` (profile
 *    clearance above work zero)
 *
 * Safety: lines with real-time characters (? ! ~ or non-ASCII) and settings
 * writes (`$n=`) are refused — settings go through the `$$` editor with its
 * per-change confirmation. Each line waits for the controller's answer;
 * alarms, errors and STOP end the macro. Macros are refused while a job runs.
 */
import { z } from 'zod';

export const MacroSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(40),
  gcode: z.string().max(10_000),
  description: z.string().max(200).default(''),
});
export type Macro = z.infer<typeof MacroSchema>;

export const MACRO_FILE_FORMAT = 'cnc-sender-macros';

export const MacroFileSchema = z.object({
  format: z.literal(MACRO_FILE_FORMAT),
  version: z.literal(1),
  macros: z.array(MacroSchema.omit({ id: true })).max(200),
});

let seq = 0;
export function macroId(): string {
  return `macro-${Date.now().toString(36)}-${(seq++).toString(36)}`;
}

export const BUILTIN_VARIABLES = ['wx', 'wy', 'wz', 'mx', 'my', 'mz', 'safeZ', 'clearance'] as const;
export type BuiltinVariable = (typeof BUILTIN_VARIABLES)[number];

export interface MacroVariable {
  name: string;
  default: string | null;
}

const VAR = /\{([A-Za-z_][A-Za-z0-9_]*)(?:=([^}]*))?\}/g;

/** Variables the user has to fill in (built-ins excluded), in order of first use. */
export function promptVariables(gcode: string): MacroVariable[] {
  const out = new Map<string, MacroVariable>();
  for (const m of gcode.matchAll(VAR)) {
    const name = m[1]!;
    if ((BUILTIN_VARIABLES as readonly string[]).includes(name)) continue;
    const prev = out.get(name);
    if (!prev) out.set(name, { name, default: m[2] ?? null });
    else if (prev.default === null && m[2] !== undefined) prev.default = m[2];
  }
  return [...out.values()];
}

const fmt = (v: number) => String(Number(v.toFixed(4)));

export interface ExpandResult {
  lines: string[];
  errors: string[];
}

/** Substitute variables, strip comments / blank lines and check each line. */
export function expandMacro(gcode: string, values: Record<string, number | undefined>): ExpandResult {
  const errors: string[] = [];
  const lines: string[] = [];
  gcode.split(/\r?\n/).forEach((raw, i) => {
    const text = raw
      .replace(VAR, (_m, name: string) => {
        const v = values[name];
        if (v === undefined || !Number.isFinite(v)) {
          errors.push(`Line ${i + 1}: no value for {${name}}.`);
          return '0';
        }
        return fmt(v);
      })
      .replace(/\([^)]*\)/g, '')
      .replace(/;.*$/, '')
      .trim();
    if (!text) return;
    if (/[?!~]/.test(text) || [...text].some((c) => c.charCodeAt(0) > 0x7e || c.charCodeAt(0) < 0x20)) {
      errors.push(`Line ${i + 1}: contains ?, ! or ~ (or non-ASCII) — GRBL would treat it as a real-time command.`);
      return;
    }
    if (/^\$\d+\s*=/.test(text) || /^\$(RST|SLP)\b/i.test(text)) {
      errors.push(`Line ${i + 1}: macros can't change or reset controller settings — use the $$ editor.`);
      return;
    }
    if (text.length > 250) {
      errors.push(`Line ${i + 1}: too long.`);
      return;
    }
    lines.push(text);
  });
  return { lines, errors };
}

/** JSON file for sharing (ids are not exported). */
export function exportMacros(macros: Macro[]): string {
  return JSON.stringify({ format: MACRO_FILE_FORMAT, version: 1, macros: macros.map(({ id: _id, ...m }) => m) }, null, 2);
}

/** Parse a shared file; returns macros with fresh ids for review before saving. */
export function parseMacroFile(text: string): { macros: Macro[] } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: 'This is not a macro file (not valid JSON).' };
  }
  const r = MacroFileSchema.safeParse(raw);
  if (!r.success) return { error: `This is not a StoneSender macro file: ${r.error.issues[0]?.message ?? 'unknown format'}.` };
  return { macros: r.data.macros.map((m) => ({ ...m, id: macroId() })) };
}

/** Problems in a macro's G-code that would stop it from running (for the editor / import review). */
export function macroProblems(m: Pick<Macro, 'gcode'>): string[] {
  const values: Record<string, number> = {};
  for (const v of [...promptVariables(m.gcode).map((p) => p.name), ...BUILTIN_VARIABLES]) values[v] = 0;
  return expandMacro(m.gcode, values).errors;
}

export function defaultMacros(): Macro[] {
  return [
    { id: 'macro-default-1', name: 'Raise to safe Z', gcode: 'G21\nG53 G0 Z{safeZ}', description: 'Lift the tool to the profile’s safe height' },
    { id: 'macro-default-2', name: 'Spindle warm-up', gcode: '(warm up the spindle in steps)\nM3 S{low=8000}\nG4 P{seconds=30}\nM3 S{high=16000}\nG4 P{seconds=30}\nM5', description: 'Runs the spindle at two speeds' },
  ];
}

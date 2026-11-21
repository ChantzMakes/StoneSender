import { describe, expect, it } from 'vitest';
import { defaultMacros, expandMacro, exportMacros, macroProblems, parseMacroFile, promptVariables } from './macros';

describe('macros', () => {
  it('finds the variables to ask for, with defaults, skipping built-ins', () => {
    expect(promptVariables('G0 X{x=10} Y{y}\nG1 X{x} Z{wz}')).toEqual([
      { name: 'x', default: '10' },
      { name: 'y', default: null },
    ]);
  });

  it('expands variables and strips comments', () => {
    const r = expandMacro('G21 (mm)\nG53 G0 Z{safeZ}\n\nG0 X{x=1} Y{y} ; go\n', { safeZ: -5, x: 12.5, y: 1 / 3 });
    expect(r.errors).toEqual([]);
    expect(r.lines).toEqual(['G21', 'G53 G0 Z-5', 'G0 X12.5 Y0.3333']);
  });

  it('refuses real-time characters, settings writes and missing values', () => {
    expect(expandMacro('G0 X1 ?', {}).errors[0]).toContain('real-time');
    expect(expandMacro('$110=5000', {}).errors[0]).toContain('$$ editor');
    expect(expandMacro('$RST=*', {}).errors[0]).toContain('$$ editor');
    expect(expandMacro('G0 X{x}', {}).errors[0]).toContain('{x}');
    expect(expandMacro('$H\n$X\n$J=G91 X1 F100', {}).errors).toEqual([]);
  });

  it('round-trips through the sharing format with new ids', () => {
    const file = exportMacros(defaultMacros());
    expect(file).not.toContain('macro-default-1');
    const r = parseMacroFile(file);
    if ('error' in r) throw new Error(r.error);
    expect(r.macros.map((m) => m.name)).toEqual(defaultMacros().map((m) => m.name));
    expect(r.macros[0]!.id).not.toBe('macro-default-1');
    expect('error' in parseMacroFile('{"format":"other"}')).toBe(true);
    expect('error' in parseMacroFile('not json')).toBe(true);
  });

  it('reports problems for the editor and import review', () => {
    expect(macroProblems({ gcode: 'G0 X1\n$100=80' })).toHaveLength(1);
    for (const m of defaultMacros()) expect(macroProblems(m)).toEqual([]);
  });
});

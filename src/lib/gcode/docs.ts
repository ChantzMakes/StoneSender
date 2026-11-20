/** Short hobbyist-friendly docs for G/M codes and words (editor hover). */

export interface CodeDoc {
  title: string;
  text: string;
  /** false when GRBL rejects it */
  supported?: boolean;
}

export const G_DOCS: Record<string, CodeDoc> = {
  G0: { title: 'Rapid move', text: 'Move as fast as possible to the given position. Not for cutting — the path between points may not be straight on all machines.' },
  G1: { title: 'Linear move (cut)', text: 'Move in a straight line at the feed rate F.' },
  G2: { title: 'Clockwise arc', text: 'Cut a clockwise arc to X/Y/Z. Centre given by I/J/K offsets from the start point, or radius R (negative R = long way round).' },
  G3: { title: 'Counter-clockwise arc', text: 'Like G2 but counter-clockwise.' },
  G4: { title: 'Dwell', text: 'Pause for P seconds (e.g. G4 P2). Commonly used after M3 to let the spindle reach speed.' },
  G10: { title: 'Set work offsets', text: 'G10 L2 Pn sets work system n to the given machine coordinates. G10 L20 Pn makes the current position the given work coordinate (P0 = active system).' },
  G17: { title: 'XY plane', text: 'Arcs are in the XY plane (default).' },
  G18: { title: 'ZX plane', text: 'Arcs are in the ZX plane.' },
  G19: { title: 'YZ plane', text: 'Arcs are in the YZ plane.' },
  G20: { title: 'Inches', text: 'All following coordinates and feeds are in inches.' },
  G21: { title: 'Millimetres', text: 'All following coordinates and feeds are in millimetres.' },
  G28: { title: 'Go to G28 position', text: 'Rapid via the given intermediate point (if any) to the position stored with G28.1.' },
  'G28.1': { title: 'Store G28 position', text: 'Remember the current position for G28.' },
  G30: { title: 'Go to G30 position', text: 'Rapid via the given intermediate point to the position stored with G30.1.' },
  'G30.1': { title: 'Store G30 position', text: 'Remember the current position for G30.' },
  'G38.2': { title: 'Probe toward (error if no contact)', text: 'Move toward the target until the probe touches; alarm if it never does.' },
  'G38.3': { title: 'Probe toward', text: 'Move toward the target until the probe touches; no alarm if it does not.' },
  'G38.4': { title: 'Probe away (error if no release)', text: 'Move until the probe stops touching; alarm if it never does.' },
  'G38.5': { title: 'Probe away', text: 'Move until the probe stops touching.' },
  G40: { title: 'Cutter compensation off', text: 'GRBL never applies cutter compensation; accepted for compatibility.' },
  G41: { title: 'Cutter compensation left', text: 'Not supported by GRBL. Let your CAM software offset the toolpath instead.', supported: false },
  G42: { title: 'Cutter compensation right', text: 'Not supported by GRBL.', supported: false },
  'G43.1': { title: 'Tool length offset', text: 'Shift Z by the given amount (G43.1 Z…) until G49.' },
  G49: { title: 'Cancel tool length offset', text: 'Removes the G43.1 offset.' },
  G53: { title: 'Machine coordinates', text: 'This line only: X/Y/Z are machine coordinates, ignoring work offsets. Only with G0/G1.' },
  G54: { title: 'Work system 1', text: 'Use work coordinate system 1 (the default).' },
  G55: { title: 'Work system 2', text: 'Use work coordinate system 2.' },
  G56: { title: 'Work system 3', text: 'Use work coordinate system 3.' },
  G57: { title: 'Work system 4', text: 'Use work coordinate system 4.' },
  G58: { title: 'Work system 5', text: 'Use work coordinate system 5.' },
  G59: { title: 'Work system 6', text: 'Use work coordinate system 6.' },
  G61: { title: 'Exact path mode', text: 'GRBL always uses this mode.' },
  G80: { title: 'Cancel motion mode', text: 'No motion until a new G0/G1/G2/G3.' },
  G81: { title: 'Drilling cycle', text: 'Canned cycles are not supported by GRBL. Post-process with a GRBL post so drilling is output as G0/G1 moves.', supported: false },
  G83: { title: 'Peck drilling cycle', text: 'Not supported by GRBL.', supported: false },
  G90: { title: 'Absolute coordinates', text: 'X/Y/Z are positions in the work coordinate system (default).' },
  G91: { title: 'Incremental coordinates', text: 'X/Y/Z are distances from the current position.' },
  'G91.1': { title: 'Incremental arc centres', text: 'I/J/K are offsets from the arc start (GRBL always works this way).' },
  G92: { title: 'Temporary offset', text: 'Makes the current position the given coordinates by adding a temporary offset. Cleared with G92.1 or a reset.' },
  'G92.1': { title: 'Clear G92 offset', text: 'Removes the temporary G92 offset.' },
  G93: { title: 'Inverse time feed', text: 'F means "complete this move in 1/F minutes". F is needed on every move.' },
  G94: { title: 'Units per minute feed', text: 'F is in mm/min (or in/min) — the normal mode.' },
};

export const M_DOCS: Record<string, CodeDoc> = {
  M0: { title: 'Pause', text: 'Stop and wait for the user to press Resume (cycle start).' },
  M1: { title: 'Optional pause', text: 'Ignored by GRBL.' },
  M2: { title: 'Program end', text: 'End of program: spindle and coolant off, modes reset.' },
  M3: { title: 'Spindle on (clockwise) / laser on', text: 'Start the spindle at speed S. For lasers: constant power S.' },
  M4: { title: 'Spindle counter-clockwise / laser dynamic power', text: 'For spindles: reverse. For lasers in laser mode: power scales with speed so corners do not over-burn.' },
  M5: { title: 'Spindle / laser off', text: 'Stop the spindle or turn the laser off.' },
  M6: { title: 'Tool change', text: 'Change to tool T. Stock GRBL 1.1 rejects M6; this app handles it according to your profile.' },
  M7: { title: 'Mist coolant on', text: 'Not supported by stock GRBL 1.1 (needs a custom build or grblHAL).' },
  M8: { title: 'Flood coolant on', text: 'Turns on the coolant / air assist output.' },
  M9: { title: 'Coolant off', text: 'Turns off mist and flood coolant.' },
  M30: { title: 'Program end', text: 'Same as M2.' },
};

export const WORD_DOCS: Record<string, string> = {
  X: 'X coordinate (left/right)',
  Y: 'Y coordinate (front/back)',
  Z: 'Z coordinate (up/down)',
  A: 'A axis (rotary), degrees',
  I: 'Arc centre offset in X from the start point',
  J: 'Arc centre offset in Y from the start point',
  K: 'Arc centre offset in Z from the start point',
  R: 'Arc radius (negative = more than half a circle)',
  F: 'Feed rate (mm/min, or in/min after G20)',
  S: 'Spindle speed (RPM) or laser power',
  T: 'Tool number',
  P: 'Parameter: dwell seconds (G4) or work system number (G10)',
  L: 'G10 mode (L2 or L20)',
  N: 'Line number (ignored)',
};

/** Normalise "G01" → "G1", "G38.20" → "G38.2" */
export function codeKey(letter: string, value: number): string {
  const v = Math.round(value * 10) / 10;
  return `${letter.toUpperCase()}${Number.isInteger(v) ? v.toFixed(0) : v}`;
}

export function docFor(letter: string, value: number): CodeDoc | null {
  const key = codeKey(letter, value);
  const L = letter.toUpperCase();
  if (L === 'G') return G_DOCS[key] ?? (value >= 81 && value <= 89 ? { title: `${key} canned cycle`, text: 'Not supported by GRBL.', supported: false } : { title: key, text: 'Not supported by GRBL.', supported: false });
  if (L === 'M') return M_DOCS[key] ?? { title: key, text: 'Not supported by GRBL.', supported: false };
  const w = WORD_DOCS[L];
  return w ? { title: `${L}${value}`, text: w } : null;
}

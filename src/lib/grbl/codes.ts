/**
 * GRBL error and alarm codes with plain-language explanations and fixes.
 * Codes 1–38 / alarms 1–9 are GRBL 1.1 (gnea/grbl error_codes_en_US.csv,
 * alarm_codes_en_US.csv). Alarms 10–15 are grblHAL additions.
 */

export interface CodeInfo {
  title: string;
  /** What happened, for hobbyists */
  meaning: string;
  /** What to do about it */
  fix: string;
}

export const ERRORS: Record<number, CodeInfo> = {
  1: { title: 'Expected command letter', meaning: 'A line contained a number without a letter in front of it.', fix: 'Check the line for a stray number or typo. G-code words are a letter followed by a number, like X10.' },
  2: { title: 'Bad number format', meaning: 'A letter was not followed by a valid number (e.g. "X" alone or "X1.2.3").', fix: 'Fix the typo in that line.' },
  3: { title: 'Invalid $ command', meaning: 'The controller did not recognise a $ system command.', fix: 'Check the spelling. Send $ on its own to list valid commands.' },
  4: { title: 'Negative value', meaning: 'A setting or word that must be positive got a negative number.', fix: 'Use a positive value.' },
  5: { title: 'Homing is disabled', meaning: 'You asked for homing ($H) but homing is turned off ($22=0).', fix: 'If your machine has limit switches, enable homing in the controller settings ($22=1). Otherwise, set your zero by hand.' },
  6: { title: 'Step pulse too short', meaning: 'The step pulse time ($0) must be at least 3 microseconds.', fix: 'Set $0 to 3 or more (10 is typical).' },
  7: { title: 'Settings memory read failed', meaning: 'The controller could not read its stored settings and restored defaults.', fix: 'Check every setting in the $$ editor (or restore your backup) — the defaults are probably wrong for your machine.' },
  8: { title: 'Not idle', meaning: 'That $ command only works when the machine is idle, not while it is moving or holding.', fix: 'Wait for the job or jog to finish (or stop it), then try again.' },
  9: { title: 'Locked (alarm or jog)', meaning: 'G-code is refused while the controller is in an alarm or jogging.', fix: 'Clear the alarm first: home the machine ($H) or unlock it ($X) once you know it is safe.' },
  10: { title: 'Soft limits need homing', meaning: 'Soft limits ($20) cannot be turned on unless homing ($22) is enabled.', fix: 'Enable homing first, or leave soft limits off.' },
  11: { title: 'Line too long', meaning: 'The line was longer than the controller can store (80 characters on GRBL) and was not run.', fix: 'Shorten the line — remove comments or extra digits — or regenerate the file with a GRBL post processor.' },
  12: { title: 'Step rate too high', meaning: 'That setting would need more than 30,000 steps per second.', fix: 'Lower the max rate ($110–$112) or steps/mm.' },
  13: { title: 'Safety door open', meaning: 'The safety door input is triggered.', fix: 'Close the door (or check the door switch wiring), then resume.' },
  14: { title: 'Startup line too long', meaning: 'A startup block or build info string was too long to store.', fix: 'Use a shorter line.' },
  15: { title: 'Jog would exceed travel', meaning: 'That jog would move past the machine limits (soft limits are on), so it was ignored.', fix: 'Jog a shorter distance or the other way. If the limits seem wrong, re-home or check $130–$132.' },
  16: { title: 'Invalid jog command', meaning: 'The jog command contained something not allowed in a jog.', fix: 'Jog commands may only contain G20/G21, G90/G91, G53, axis words and F.' },
  17: { title: 'Laser mode needs PWM', meaning: 'Laser mode ($32) needs a variable-speed (PWM) spindle output.', fix: 'Your firmware build has no PWM output; laser mode cannot be used.' },
  20: { title: 'Unsupported command', meaning: 'The line uses a G or M code this controller does not support (for example M6 or M7 on stock GRBL, canned cycles, cutter compensation).', fix: 'Regenerate the file with a GRBL post processor in your CAM, or remove that command.' },
  21: { title: 'Conflicting commands', meaning: 'The line has two commands from the same group (e.g. G0 and G1 together).', fix: 'Split the line or remove one of the commands.' },
  22: { title: 'No feed rate', meaning: 'A cutting move (G1/G2/G3) had no feed rate set yet.', fix: 'Add an F value (e.g. F500) before or on the first cutting move.' },
  23: { title: 'Needs a whole number', meaning: 'A command needed an integer value but got a decimal.', fix: 'Fix the value on that line.' },
  24: { title: 'Two commands want axis words', meaning: 'More than one command on the line uses X/Y/Z words.', fix: 'Split the line.' },
  25: { title: 'Repeated word', meaning: 'The same letter appears twice on one line (e.g. two X values).', fix: 'Remove the duplicate.' },
  26: { title: 'Missing axis words', meaning: 'A command that needs X/Y/Z values did not have any.', fix: 'Add the target coordinates.' },
  27: { title: 'Bad line number', meaning: 'The N line number is invalid.', fix: 'Remove or fix the N word.' },
  28: { title: 'Missing value', meaning: 'A command is missing a required value (e.g. G4 without P, G10 without L/P).', fix: 'Add the missing value.' },
  29: { title: 'G59.x not supported', meaning: 'Only G54–G59 work coordinate systems exist on GRBL.', fix: 'Use G54–G59.' },
  30: { title: 'G53 needs G0 or G1', meaning: 'Machine-coordinate moves (G53) only work with G0 or G1.', fix: 'Use G53 with G0/G1 only.' },
  31: { title: 'Unused axis words', meaning: 'The line has X/Y/Z values but nothing uses them (e.g. after G80).', fix: 'Add a motion command or remove the values.' },
  32: { title: 'Arc missing plane axis', meaning: 'An arc (G2/G3) needs at least one end point on its plane.', fix: 'Check the arc line and the selected plane (G17/G18/G19).' },
  33: { title: 'Invalid target', meaning: 'The move target is invalid — often an arc whose end point does not fit its centre.', fix: 'Regenerate the toolpath; try lowering arc precision in CAM or outputting arcs as lines.' },
  34: { title: 'Arc radius error', meaning: 'An R-form arc cannot reach its end point with that radius.', fix: 'Regenerate the toolpath or use IJK arcs.' },
  35: { title: 'Arc missing offsets', meaning: 'An arc needs I/J/K offsets (or R) on its plane.', fix: 'Check the arc line.' },
  36: { title: 'Unused words', meaning: 'The line has values nothing uses.', fix: 'Remove the extra words.' },
  37: { title: 'Tool length offset axis', meaning: 'G43.1 must only set the Z (tool length) axis.', fix: 'Use G43.1 Z…' },
  38: { title: 'Tool number too high', meaning: 'The T number is above what the controller supports.', fix: 'Use a lower tool number.' },
};

export const ALARMS: Record<number, CodeInfo> = {
  1: { title: 'Hard limit triggered', meaning: 'A limit switch was hit while moving. The machine stopped instantly, so its position is probably lost.', fix: 'Check nothing is jammed, then reset and re-home ($H). If no switch was really hit, check the wiring for electrical noise.' },
  2: { title: 'Soft limit', meaning: 'A move would have gone outside the machine\'s travel. It stopped before moving there; position is kept.', fix: 'Reset, then check the job fits the work area and that your work zero is where you expect. You can unlock ($X) safely.' },
  3: { title: 'Reset while moving', meaning: 'The controller was reset in the middle of a move, so it no longer knows exactly where it is.', fix: 'Re-home ($H) before running anything. Without switches, unlock ($X) and set your zero again.' },
  4: { title: 'Probe already triggered', meaning: 'The probe was already touching (or not touching, for G38.4/5) before probing started.', fix: 'Check the probe clip and plate aren\'t touching, and the probe wiring. Then unlock ($X).' },
  5: { title: 'Probe did not touch', meaning: 'The probe moved its full distance without touching anything.', fix: 'Start closer to the plate, check the clip is attached and the plate is under the bit. Then unlock ($X).' },
  6: { title: 'Homing interrupted', meaning: 'The homing cycle was reset before it finished.', fix: 'Run homing again ($H).' },
  7: { title: 'Homing: door opened', meaning: 'The safety door opened during homing.', fix: 'Close the door and home again.' },
  8: { title: 'Homing: switch did not release', meaning: 'After touching a limit switch, backing off by the pull-off distance did not release it.', fix: 'Increase the pull-off distance ($27) or check the switch wiring.' },
  9: { title: 'Homing: switch not found', meaning: 'The machine moved its full travel without finding a limit switch.', fix: 'Check the switch wiring and the homing direction ($23). Make sure max travel ($130–$132) is not too small.' },
  10: { title: 'E-stop pressed (grblHAL)', meaning: 'The emergency stop input is active.', fix: 'Release the E-stop, then reset and home.' },
  11: { title: 'Homing required (grblHAL)', meaning: 'The controller requires homing before anything else.', fix: 'Home the machine ($H).' },
  12: { title: 'Limit switch engaged (grblHAL)', meaning: 'A limit switch is active at start-up.', fix: 'Move the axis off the switch by hand (power off) or check the wiring.' },
  13: { title: 'Probe protection (grblHAL)', meaning: 'The probe triggered outside a probing move.', fix: 'Check the probe and its wiring.' },
  14: { title: 'Spindle at-speed timeout (grblHAL)', meaning: 'The spindle did not report reaching speed in time.', fix: 'Check the spindle/VFD and its feedback wiring.' },
  15: { title: 'Auto-squaring failed (grblHAL)', meaning: 'Dual-motor homing could not square the gantry.', fix: 'Check both Y switches and the squaring settings.' },
};

export function errorInfo(code: number | null | undefined): CodeInfo | null {
  return code == null ? null : (ERRORS[code] ?? null);
}

export function alarmInfo(code: number | null | undefined): CodeInfo | null {
  return code == null ? null : (ALARMS[code] ?? null);
}

/** Alarms after which the machine position cannot be trusted. */
export function alarmLosesPosition(code: number | null | undefined): boolean {
  return code === 1 || code === 3 || code === 6 || code === 10;
}

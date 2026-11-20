/**
 * Field metadata for the profile editor: labels, hobbyist-friendly help,
 * units and visibility. The editor UI is generated from this table, so adding
 * a field to the schema means adding one entry here.
 */
import type { MachineProfile } from './schema';
import type { UnitKind } from './units';

export type FieldKind = 'number' | 'boolean' | 'enum' | 'text' | 'textarea' | 'numberList';

export interface FieldMeta {
  path: string;
  label: string;
  help: string;
  kind: FieldKind;
  unit?: UnitKind;
  options?: { value: string; label: string }[];
  step?: number;
  /** Shown but not editable here (e.g. mirrored from `$$`). */
  readOnly?: string;
  advanced?: boolean;
  showIf?: (p: MachineProfile) => boolean;
}

export interface FieldGroup {
  id: string;
  title: string;
  description: string;
  fields: FieldMeta[];
  showIf?: (p: MachineProfile) => boolean;
}

const isRotary = (p: MachineProfile) => p.machineType === 'rotary';
const hasSpindle = (p: MachineProfile) => p.machineType !== 'laser';
const hasLaser = (p: MachineProfile) => p.machineType === 'laser' || p.machineType === 'router-laser';
const aAxis = (p: MachineProfile) => isRotary(p) && p.rotary.mode === 'a-axis';

const axisFields = (base: string, label: string, help: string, unit: UnitKind, aUnit: UnitKind, extra: Partial<FieldMeta> = {}): FieldMeta[] => [
  { path: `${base}.x`, label: `${label} X`, help, kind: 'number', unit, ...extra },
  { path: `${base}.y`, label: `${label} Y`, help, kind: 'number', unit, ...extra },
  { path: `${base}.z`, label: `${label} Z`, help, kind: 'number', unit, ...extra },
  { path: `${base}.a`, label: `${label} A`, help, kind: 'number', unit: aUnit, showIf: aAxis, ...extra },
];

const STEPS_READONLY = 'Mirrors $100–$103 on your controller. Change these from the controller settings ($$) editor so the machine and profile never disagree.';

export const FIELD_GROUPS: FieldGroup[] = [
  {
    id: 'identity',
    title: 'Identity',
    description: 'What this machine is called and how it is shown.',
    fields: [
      { path: 'identity.name', label: 'Profile name', help: 'Shown in the toolbar switcher. Use something you will recognise, like "Garage Shapeoko".', kind: 'text' },
      { path: 'identity.icon', label: 'Icon', help: 'An emoji shown next to the name (optional).', kind: 'text' },
      { path: 'identity.notes', label: 'Notes', help: 'Anything worth remembering: upgrades, spoilboard height, quirks.', kind: 'textarea' },
      {
        path: 'units',
        label: 'Display units',
        help: 'How lengths and feeds are shown and typed in. The app always stores millimetres internally, so switching is lossless.',
        kind: 'enum',
        options: [
          { value: 'mm', label: 'Millimetres (mm)' },
          { value: 'inch', label: 'Inches (in)' },
        ],
      },
    ],
  },
  {
    id: 'type',
    title: 'Machine type',
    description: 'Decides which panels, simulations and safety checks you see.',
    fields: [
      {
        path: 'machineType',
        label: 'Machine type',
        help: 'Router/mill cuts with a spinning bit. Laser burns with a beam. Router + laser has both heads. Rotary adds a 4th axis that turns the stock.',
        kind: 'enum',
        options: [
          { value: 'router', label: '3-axis router / mill' },
          { value: 'laser', label: 'Laser engraver / cutter' },
          { value: 'router-laser', label: 'Router + laser combo' },
          { value: 'rotary', label: '4-axis rotary (A axis)' },
        ],
      },
    ],
  },
  {
    id: 'controller',
    title: 'Controller',
    description: 'How the app talks to the electronics.',
    fields: [
      {
        path: 'controller.firmware',
        label: 'Firmware',
        help: 'Leave on auto-detect unless you know better. The app reads the startup message to tell GRBL 1.1, old GRBL 0.9 and grblHAL apart.',
        kind: 'enum',
        options: [
          { value: 'auto', label: 'Auto-detect' },
          { value: 'grbl', label: 'GRBL 1.1' },
          { value: 'grblhal', label: 'grblHAL' },
        ],
      },
      {
        path: 'controller.baudRate',
        label: 'Baud rate',
        help: 'Serial speed. Almost every GRBL board uses 115200. Some older boards use 9600.',
        kind: 'enum',
        unit: 'baud',
        options: ['9600', '19200', '38400', '57600', '115200', '230400', '250000', '460800', '921600'].map((v) => ({ value: v, label: v })),
      },
      { path: 'controller.statusPollHz', label: 'Status updates per second', help: 'How often the position display refreshes. 5–10 is plenty; higher adds serial traffic.', kind: 'number', unit: 'hz', step: 1 },
      {
        path: 'controller.streamingMode',
        label: 'Streaming mode',
        help: 'Character-counting keeps GRBL\'s buffer full for smooth motion and is recommended. Send-response waits for each "ok" — slower, but works with odd USB adapters.',
        kind: 'enum',
        advanced: true,
        options: [
          { value: 'character-counting', label: 'Character counting (recommended)' },
          { value: 'send-response', label: 'Send-response (compatibility)' },
        ],
      },
      { path: 'controller.rxBufferSize', label: 'Controller receive buffer', help: 'Size of the controller\'s serial buffer. 128 for GRBL on an Arduino; grblHAL boards report a larger value (often 1024).', kind: 'number', unit: 'bytes', advanced: true, step: 1 },
    ],
  },
  {
    id: 'geometry',
    title: 'Work area & frame',
    description: 'How far the machine can move and how it is built.',
    fields: [
      { path: 'geometry.envelope.x', label: 'Travel X', help: 'How far the tool can move left–right. Matches $130.', kind: 'number', unit: 'length' },
      { path: 'geometry.envelope.y', label: 'Travel Y', help: 'How far the tool can move front–back. Matches $131.', kind: 'number', unit: 'length' },
      { path: 'geometry.envelope.z', label: 'Travel Z', help: 'How far the tool can move up–down. Matches $132.', kind: 'number', unit: 'length' },
      {
        path: 'geometry.gantryStyle',
        label: 'What moves in Y?',
        help: 'On most routers the gantry rides front-to-back over a fixed bed. On many small desktop machines (like 3018s) the bed slides instead.',
        kind: 'enum',
        options: [
          { value: 'moving-gantry', label: 'The gantry moves (bed is fixed)' },
          { value: 'moving-table', label: 'The bed/table moves' },
        ],
      },
      { path: 'geometry.dualMotorY', label: 'Two Y motors', help: 'Machines with a motor on each side of the gantry (most mid-size routers).', kind: 'boolean' },
      {
        path: 'geometry.homeCorner',
        label: 'Home corner',
        help: 'The corner the tool goes to when you press Home, as seen standing at the front of the machine.',
        kind: 'enum',
        options: [
          { value: 'back-right', label: 'Back right' },
          { value: 'back-left', label: 'Back left' },
          { value: 'front-left', label: 'Front left' },
          { value: 'front-right', label: 'Front right' },
        ],
      },
      {
        path: 'geometry.zHomeDirection',
        label: 'Z homes',
        help: 'Almost always up (away from the work), so the bit clears everything.',
        kind: 'enum',
        options: [
          { value: 'up', label: 'Up (normal)' },
          { value: 'down', label: 'Down' },
        ],
      },
      {
        path: 'geometry.coordinateMode',
        label: 'Machine coordinates after homing',
        help: 'Stock GRBL calls the home position 0 and the rest of the work area negative numbers. Some custom builds make the home corner 0 with positive numbers instead.',
        kind: 'enum',
        advanced: true,
        options: [
          { value: 'negative-space', label: 'Negative (stock GRBL)' },
          { value: 'positive-space', label: 'Positive (force-origin builds)' },
        ],
      },
      { path: 'geometry.frame.auto', label: 'Size 3D frame automatically', help: 'Build the 3D machine model around the travel area. Turn off to enter the outside dimensions yourself.', kind: 'boolean', advanced: true },
      ...(['x', 'y', 'z'] as const).map(
        (a): FieldMeta => ({
          path: `geometry.frame.size.${a}`,
          label: `Frame size ${a.toUpperCase()}`,
          help: 'Outside dimension of the machine, used only for the 3D model.',
          kind: 'number',
          unit: 'length',
          advanced: true,
          showIf: (p) => !p.geometry.frame.auto,
        }),
      ),
    ],
  },
  {
    id: 'motion',
    title: 'Motion',
    description: 'Speed and acceleration limits. Used for time estimates and the simulator.',
    fields: [
      ...axisFields('motion.maxRate', 'Max speed', 'Fastest this axis can move ($110–$113).', 'feed', 'angleFeed'),
      ...axisFields('motion.acceleration', 'Acceleration', 'How quickly this axis can speed up and slow down ($120–$123).', 'accel', 'angleAccel'),
      { path: 'motion.junctionDeviation', label: 'Junction deviation', help: 'How much GRBL may round corners to keep speed ($11). 0.01 mm is typical.', kind: 'number', unit: 'length', advanced: true },
      { path: 'motion.arcTolerance', label: 'Arc tolerance', help: 'How closely arcs are split into straight segments ($12). 0.002 mm is typical.', kind: 'number', unit: 'length', advanced: true },
      ...axisFields('motion.stepsPerUnit', 'Steps per unit', 'Motor steps for one mm (or degree) of travel.', 'stepsPerLength', 'stepsPerAngle', { readOnly: STEPS_READONLY }),
    ],
  },
  {
    id: 'homing',
    title: 'Homing & limits',
    description: 'Limit switches and the homing cycle.',
    fields: [
      { path: 'homing.enabled', label: 'Homing switches installed', help: 'Turn on if your machine has limit switches and homes with $H ($22).', kind: 'boolean' },
      { path: 'homing.softLimits', label: 'Soft limits', help: 'Refuse moves outside the travel area ($20). Needs homing, because the machine must know where it is.', kind: 'boolean' },
      { path: 'homing.hardLimits', label: 'Hard limits', help: 'Stop immediately if a limit switch is hit during a job ($21).', kind: 'boolean' },
      { path: 'homing.pullOff', label: 'Pull-off distance', help: 'How far to back off the switch after homing ($27).', kind: 'number', unit: 'length', showIf: (p) => p.homing.enabled },
      { path: 'homing.seekRate', label: 'Homing seek speed', help: 'Fast search for the switch ($25).', kind: 'number', unit: 'feed', showIf: (p) => p.homing.enabled, advanced: true },
      { path: 'homing.feedRate', label: 'Homing locate speed', help: 'Slow, precise touch of the switch ($24).', kind: 'number', unit: 'feed', showIf: (p) => p.homing.enabled, advanced: true },
      {
        path: 'homing.sequence',
        label: 'Homing order',
        help: 'Order the axes home in. Set when GRBL is compiled; stock GRBL homes Z first, then X and Y together. Used for the simulation.',
        kind: 'enum',
        advanced: true,
        showIf: (p) => p.homing.enabled,
        options: [
          { value: 'z-then-xy', label: 'Z, then X+Y together (stock)' },
          { value: 'z-then-x-then-y', label: 'Z, then X, then Y' },
          { value: 'all-together', label: 'All at once' },
        ],
      },
    ],
  },
  {
    id: 'spindle',
    title: 'Spindle',
    description: 'What spins the cutting bit.',
    showIf: hasSpindle,
    fields: [
      {
        path: 'spindle.type',
        label: 'Spindle type',
        help: 'A trim router has its own speed dial (the app can only switch it on/off). A PWM spindle or VFD lets the G-code set the speed.',
        kind: 'enum',
        options: [
          { value: 'router', label: 'Trim router (manual speed dial)' },
          { value: 'pwm', label: 'PWM spindle (speed from G-code)' },
          { value: 'vfd', label: 'VFD spindle (speed from G-code)' },
        ],
      },
      { path: 'spindle.minRpm', label: 'Min speed', help: 'Lowest speed / S value ($31).', kind: 'number', unit: 'rpm' },
      { path: 'spindle.maxRpm', label: 'Max speed', help: 'The S value that means full speed ($30). Some boards use 1000 instead of RPM.', kind: 'number', unit: 'rpm' },
      { path: 'spindle.spinUpDelaySec', label: 'Spin-up delay', help: 'Pause after starting the spindle so it reaches speed before cutting. Inserted as a dwell after M3.', kind: 'number', unit: 'seconds', step: 0.5 },
      { path: 'spindle.supportsM4', label: 'Can run in reverse (M4)', help: 'Only some spindles can spin counter-clockwise.', kind: 'boolean', advanced: true },
    ],
  },
  {
    id: 'laser',
    title: 'Laser',
    description: 'Laser power and framing.',
    showIf: hasLaser,
    fields: [
      { path: 'laser.maxPower', label: 'Max power S value', help: 'The S value that means 100 % power ($30). Usually 1000 or 255.', kind: 'number', unit: 'sValue' },
      { path: 'laser.laserMode', label: 'Laser mode ($32)', help: 'GRBL laser mode keeps moving through power changes and turns the beam off during rapids. Must be ON for lasers and OFF for spindles.', kind: 'boolean' },
      { path: 'laser.defaultM4Dynamic', label: 'Use dynamic power (M4)', help: 'M4 scales power with speed so corners do not burn darker. Recommended.', kind: 'boolean' },
      { path: 'laser.focusHeight', label: 'Focus height', help: 'Distance from the laser to the material surface when in focus. 0 if you focus by hand.', kind: 'number', unit: 'length' },
      { path: 'laser.framingFeed', label: 'Framing speed', help: 'Speed used to trace the outline of a job before burning.', kind: 'number', unit: 'feed' },
      { path: 'laser.framingPowerPercent', label: 'Framing power', help: 'Beam power while framing. 0 % traces with the beam off; 1 % gives a faint visible dot on most diode lasers.', kind: 'number', unit: 'percent', step: 0.5 },
      {
        path: 'laser.airAssist',
        label: 'Air assist on',
        help: 'Which coolant command switches your air pump. Stock GRBL 1.1 only supports M8 — M7 needs a custom build or grblHAL.',
        kind: 'enum',
        options: [
          { value: 'none', label: 'No air assist' },
          { value: 'M8', label: 'M8 (flood)' },
          { value: 'M7', label: 'M7 (mist)' },
        ],
      },
    ],
  },
  {
    id: 'rotary',
    title: 'Rotary',
    description: 'The 4th axis that turns round stock.',
    showIf: isRotary,
    fields: [
      {
        path: 'rotary.mode',
        label: 'How the rotary is wired',
        help: 'A true 4th axis has its own driver (A axis). Y-substitution plugs the rotary into the Y motor socket, so Y moves turn the stock.',
        kind: 'enum',
        options: [
          { value: 'a-axis', label: 'True 4th axis (A)' },
          { value: 'y-substitution', label: 'Replaces the Y motor' },
        ],
      },
      {
        path: 'rotary.axisParallelTo',
        label: 'Rotation axis runs along',
        help: 'Which machine axis the rotary spindle is lined up with.',
        kind: 'enum',
        options: [
          { value: 'x', label: 'X (left–right)' },
          { value: 'y', label: 'Y (front–back)' },
        ],
      },
      { path: 'rotary.defaultStockDiameter', label: 'Default stock diameter', help: 'Starting diameter for new jobs and the simulator.', kind: 'number', unit: 'length' },
      {
        path: 'rotary.diameterHandling',
        label: 'Stock diameter',
        help: 'Ask before each job (recommended for Y-substitution, where the diameter changes the scale) or always use the default.',
        kind: 'enum',
        options: [
          { value: 'ask-per-job', label: 'Ask for each job' },
          { value: 'fixed', label: 'Always use the default' },
        ],
      },
      {
        path: 'rotary.yMmPerRevolution',
        label: 'Y distance for one turn',
        help: 'With Y-substitution: the Y move (with your current $101) that turns the rotary exactly once.',
        kind: 'number',
        unit: 'length',
        showIf: (p) => p.rotary.mode === 'y-substitution',
      },
    ],
  },
  {
    id: 'probe',
    title: 'Probe & touch plate',
    description: 'Finding the top and corner of your stock automatically.',
    fields: [
      {
        path: 'probe.plateType',
        label: 'Touch plate',
        help: 'Z-only plates find the top of the stock. XYZ corner plates also find the left and front edges.',
        kind: 'enum',
        options: [
          { value: 'none', label: 'No touch plate' },
          { value: 'z', label: 'Z plate (top only)' },
          { value: 'xyz', label: 'XYZ corner plate' },
        ],
      },
      { path: 'probe.plateThickness', label: 'Plate thickness', help: 'Measured with calipers where the bit touches.', kind: 'number', unit: 'length', showIf: (p) => p.probe.plateType !== 'none' },
      { path: 'probe.xyOffset.x', label: 'Plate X offset', help: 'Distance from the plate\'s X touch face to the stock edge (the plate wall thickness).', kind: 'number', unit: 'length', showIf: (p) => p.probe.plateType === 'xyz' },
      { path: 'probe.xyOffset.y', label: 'Plate Y offset', help: 'Distance from the plate\'s Y touch face to the stock edge.', kind: 'number', unit: 'length', showIf: (p) => p.probe.plateType === 'xyz' },
      { path: 'probe.fastFeed', label: 'Fast probe speed', help: 'First touch, to find the plate quickly.', kind: 'number', unit: 'feed', showIf: (p) => p.probe.plateType !== 'none' },
      { path: 'probe.slowFeed', label: 'Slow probe speed', help: 'Second touch, for accuracy.', kind: 'number', unit: 'feed', showIf: (p) => p.probe.plateType !== 'none' },
      { path: 'probe.retract', label: 'Retract distance', help: 'How far to back off between touches.', kind: 'number', unit: 'length', showIf: (p) => p.probe.plateType !== 'none' },
      { path: 'probe.maxTravel', label: 'Max probe distance', help: 'Give up (with an alarm) if nothing is touched within this distance.', kind: 'number', unit: 'length', showIf: (p) => p.probe.plateType !== 'none' },
      { path: 'probe.toolSetter.enabled', label: 'Fixed tool setter', help: 'A switch mounted on the bed that measures tool length automatically after tool changes.', kind: 'boolean', advanced: true },
      ...(['x', 'y', 'z'] as const).map(
        (a): FieldMeta => ({
          path: `probe.toolSetter.position.${a}`,
          label: `Tool setter ${a.toUpperCase()} (machine)`,
          help: 'Machine coordinates above the tool setter where probing starts.',
          kind: 'number',
          unit: 'length',
          advanced: true,
          showIf: (p) => p.probe.toolSetter.enabled,
        }),
      ),
    ],
  },
  {
    id: 'toolchange',
    title: 'Tool changes',
    description: 'What happens when a job asks for a new bit (M6).',
    showIf: hasSpindle,
    fields: [
      {
        path: 'toolChange.strategy',
        label: 'On a tool change',
        help: 'Ignore skips M6. Pause stops and waits for you. Pause + re-probe also measures the new bit with the touch plate. Tool setter uses the fixed setter.',
        kind: 'enum',
        options: [
          { value: 'pause-reprobe', label: 'Pause, change bit, re-probe Z (recommended)' },
          { value: 'pause', label: 'Pause and wait for me' },
          { value: 'tool-setter', label: 'Use the fixed tool setter' },
          { value: 'ignore', label: 'Ignore M6' },
        ],
      },
      ...(['x', 'y', 'z'] as const).map(
        (a): FieldMeta => ({
          path: `toolChange.position.${a}`,
          label: `Change position ${a.toUpperCase()} (machine)`,
          help: 'Machine coordinates the tool moves to so you can reach the collet comfortably.',
          kind: 'number',
          unit: 'length',
          showIf: (p) => p.toolChange.strategy !== 'ignore',
        }),
      ),
    ],
  },
  {
    id: 'safety',
    title: 'Safe heights',
    description: 'Clearances used for moves the app generates.',
    fields: [
      { path: 'safety.safeZMachine', label: 'Safe Z (machine)', help: 'Machine Z height for moves across the bed, e.g. −5 = 5 mm below the top of travel.', kind: 'number', unit: 'length' },
      { path: 'safety.clearanceZ', label: 'Clearance above work', help: 'Height above the work zero used when the app retracts between operations.', kind: 'number', unit: 'length' },
      ...(['x', 'y', 'z'] as const).map(
        (a): FieldMeta => ({
          path: `safety.parkPosition.${a}`,
          label: `Park ${a.toUpperCase()} (machine)`,
          help: 'Where the Park button sends the tool, in machine coordinates.',
          kind: 'number',
          unit: 'length',
        }),
      ),
    ],
  },
  {
    id: 'defaults',
    title: 'Defaults',
    description: 'Starting values for jogging and the simulator.',
    fields: [
      { path: 'defaults.jog.stepsMm', label: 'Jog step sizes', help: 'Buttons offered for step jogging, comma separated.', kind: 'numberList', unit: 'length' },
      { path: 'defaults.jog.defaultStepMm', label: 'Default jog step', help: 'Step size selected at start-up.', kind: 'number', unit: 'length' },
      { path: 'defaults.jog.feedXY', label: 'Jog speed XY', help: 'Speed for X/Y jogging.', kind: 'number', unit: 'feed' },
      { path: 'defaults.jog.feedZ', label: 'Jog speed Z', help: 'Speed for Z jogging. Keep it modest.', kind: 'number', unit: 'feed' },
      { path: 'defaults.stock.size.x', label: 'Stock X', help: 'Default stock width for the simulator.', kind: 'number', unit: 'length' },
      { path: 'defaults.stock.size.y', label: 'Stock Y', help: 'Default stock depth for the simulator.', kind: 'number', unit: 'length' },
      { path: 'defaults.stock.size.z', label: 'Stock thickness', help: 'Default stock thickness for the simulator.', kind: 'number', unit: 'length' },
      {
        path: 'defaults.stock.material',
        label: 'Material',
        help: 'Default material for the simulator.',
        kind: 'enum',
        options: ['softwood', 'hardwood', 'plywood', 'mdf', 'acrylic', 'hdpe', 'aluminum', 'brass', 'foam', 'pcb', 'leather', 'cardboard', 'other'].map((m) => ({
          value: m,
          label: m === 'mdf' || m === 'pcb' || m === 'hdpe' ? m.toUpperCase() : m[0]!.toUpperCase() + m.slice(1),
        })),
      },
      { path: 'defaults.stock.color', label: 'Stock colour', help: 'Colour of the stock in the 3D view (#rrggbb).', kind: 'text' },
    ],
  },
];

export function visibleGroups(p: MachineProfile): FieldGroup[] {
  return FIELD_GROUPS.filter((g) => !g.showIf || g.showIf(p));
}

// ---- path helpers --------------------------------------------------------

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Immutable set: returns a structurally-shared copy with `path` replaced. */
export function setPath<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split('.');
  const rec = (cur: unknown, i: number): unknown => {
    const k = keys[i]!;
    const base = typeof cur === 'object' && cur !== null ? (cur as Record<string, unknown>) : {};
    const next = i === keys.length - 1 ? value : rec(base[k], i + 1);
    return { ...base, [k]: next };
  };
  return rec(obj, 0) as T;
}

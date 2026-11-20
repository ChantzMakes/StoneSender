/**
 * Machine Profile schema — the single source of truth for profile shape,
 * validation and defaults. `crates/grbl-core/src/profile.rs` mirrors it with
 * serde; parity is enforced by tests that load every preset on both sides.
 *
 * Units: lengths mm, feeds mm/min, accelerations mm/s². A-axis values are in
 * degrees. `units` only changes how values are displayed and entered.
 *
 * When changing the shape: bump SCHEMA_VERSION, add a migration in
 * `migrate.ts`, update the Rust mirror and the presets.
 */
import { z } from 'zod';

export const SCHEMA_VERSION = 1;

const finite = () => z.number({ invalid_type_error: 'must be a number' }).finite('must be a finite number');
const positive = (max = 1e9) => finite().gt(0, 'must be greater than 0').max(max, `must be at most ${max}`);
const nonNegative = (max = 1e9) => finite().min(0, 'must be 0 or more').max(max, `must be at most ${max}`);
const machineCoord = () => finite().min(-100000).max(100000);

const axis3 = <T extends z.ZodTypeAny>(s: T) => z.object({ x: s, y: s, z: s }).strict();
const axis4 = <T extends z.ZodTypeAny>(s: T) => z.object({ x: s, y: s, z: s, a: s }).strict();

export const UnitsSchema = z.enum(['mm', 'inch']);
export const MachineTypeSchema = z.enum(['router', 'laser', 'router-laser', 'rotary']);
export const FirmwareSchema = z.enum(['auto', 'grbl', 'grblhal']);
export const StreamingModeSchema = z.enum(['character-counting', 'send-response']);
export const GantryStyleSchema = z.enum(['moving-gantry', 'moving-table']);
export const HomeCornerSchema = z.enum(['front-left', 'front-right', 'back-left', 'back-right']);
export const ZHomeDirectionSchema = z.enum(['up', 'down']);
export const CoordinateModeSchema = z.enum(['negative-space', 'positive-space']);
export const HomingSequenceSchema = z.enum(['z-then-xy', 'z-then-x-then-y', 'all-together']);
export const SpindleTypeSchema = z.enum(['router', 'pwm', 'vfd']);
export const AirAssistSchema = z.enum(['none', 'M7', 'M8']);
export const RotaryModeSchema = z.enum(['a-axis', 'y-substitution']);
export const DiameterHandlingSchema = z.enum(['fixed', 'ask-per-job']);
export const PlateTypeSchema = z.enum(['none', 'z', 'xyz']);
export const ToolChangeStrategySchema = z.enum(['ignore', 'pause', 'pause-reprobe', 'tool-setter']);
export const MaterialSchema = z.enum([
  'softwood',
  'hardwood',
  'plywood',
  'mdf',
  'acrylic',
  'hdpe',
  'aluminum',
  'brass',
  'foam',
  'pcb',
  'leather',
  'cardboard',
  'other',
]);

export const MachineProfileSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/, 'id may only contain letters, digits, - and _'),
    createdAt: z.string(),
    updatedAt: z.string(),
    identity: z
      .object({
        name: z.string().trim().min(1, 'give the profile a name').max(60, 'at most 60 characters'),
        notes: z.string().max(4000),
        /** Emoji or small data: URL image (≤ 256 KB) */
        icon: z.string().max(350_000).nullable(),
        presetId: z.string().nullable(),
      })
      .strict(),
    units: UnitsSchema,
    machineType: MachineTypeSchema,
    controller: z
      .object({
        firmware: FirmwareSchema,
        baudRate: z.number().int().min(1200).max(2_000_000),
        statusPollHz: finite().min(1).max(20),
        streamingMode: StreamingModeSchema,
        rxBufferSize: z.number().int().min(64).max(16384),
      })
      .strict(),
    geometry: z
      .object({
        envelope: axis3(positive(10000)),
        gantryStyle: GantryStyleSchema,
        dualMotorY: z.boolean(),
        frame: z.object({ auto: z.boolean(), size: axis3(positive(20000)) }).strict(),
        homeCorner: HomeCornerSchema,
        zHomeDirection: ZHomeDirectionSchema,
        coordinateMode: CoordinateModeSchema,
      })
      .strict(),
    motion: z
      .object({
        maxRate: axis4(positive(200000)),
        acceleration: axis4(positive(100000)),
        junctionDeviation: positive(10),
        arcTolerance: positive(10),
        stepsPerUnit: axis4(positive(100000)),
      })
      .strict(),
    homing: z
      .object({
        enabled: z.boolean(),
        softLimits: z.boolean(),
        hardLimits: z.boolean(),
        pullOff: nonNegative(100),
        seekRate: positive(100000),
        feedRate: positive(100000),
        sequence: HomingSequenceSchema,
      })
      .strict(),
    spindle: z
      .object({
        type: SpindleTypeSchema,
        minRpm: nonNegative(200000),
        maxRpm: positive(200000),
        spinUpDelaySec: nonNegative(120),
        supportsM4: z.boolean(),
      })
      .strict(),
    laser: z
      .object({
        maxPower: positive(100000),
        laserMode: z.boolean(),
        defaultM4Dynamic: z.boolean(),
        focusHeight: nonNegative(1000),
        framingFeed: positive(100000),
        framingPowerPercent: nonNegative(100),
        airAssist: AirAssistSchema,
      })
      .strict(),
    rotary: z
      .object({
        mode: RotaryModeSchema,
        axisParallelTo: z.enum(['x', 'y']),
        defaultStockDiameter: positive(2000),
        diameterHandling: DiameterHandlingSchema,
        yMmPerRevolution: positive(100000),
      })
      .strict(),
    probe: z
      .object({
        plateType: PlateTypeSchema,
        plateThickness: nonNegative(200),
        xyOffset: z.object({ x: nonNegative(200), y: nonNegative(200) }).strict(),
        fastFeed: positive(10000),
        slowFeed: positive(10000),
        retract: nonNegative(200),
        maxTravel: positive(1000),
        toolSetter: z.object({ enabled: z.boolean(), position: axis3(machineCoord()) }).strict(),
      })
      .strict(),
    toolChange: z
      .object({
        strategy: ToolChangeStrategySchema,
        position: axis3(machineCoord()),
      })
      .strict(),
    safety: z
      .object({
        safeZMachine: machineCoord(),
        clearanceZ: nonNegative(1000),
        parkPosition: axis3(machineCoord()),
      })
      .strict(),
    defaults: z
      .object({
        jog: z
          .object({
            stepsMm: z.array(positive(10000)).min(1, 'need at least one jog step').max(12),
            defaultStepMm: positive(10000),
            feedXY: positive(100000),
            feedZ: positive(100000),
          })
          .strict(),
        stock: z
          .object({
            size: axis3(positive(10000)),
            material: MaterialSchema,
            color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'use a #rrggbb colour'),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.spindle.minRpm >= p.spindle.maxRpm) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['spindle', 'minRpm'], message: 'must be below max RPM' });
    }
    if (p.probe.slowFeed > p.probe.fastFeed) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['probe', 'slowFeed'], message: 'should not be faster than the fast probe feed' });
    }
    if (p.homing.softLimits && !p.homing.enabled) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['homing', 'softLimits'], message: 'soft limits need homing enabled (GRBL refuses $20=1 without $22=1)' });
    }
  });

export type MachineProfile = z.infer<typeof MachineProfileSchema>;
export type MachineType = z.infer<typeof MachineTypeSchema>;
export type Units = z.infer<typeof UnitsSchema>;
export type HomeCorner = z.infer<typeof HomeCornerSchema>;
export type Axis3 = { x: number; y: number; z: number };

export interface ValidationResult {
  ok: boolean;
  profile?: MachineProfile;
  /** dotted path → message, e.g. `geometry.envelope.x` */
  errors: Record<string, string>;
}

export function validateProfile(value: unknown): ValidationResult {
  const r = MachineProfileSchema.safeParse(value);
  if (r.success) return { ok: true, profile: r.data, errors: {} };
  const errors: Record<string, string> = {};
  for (const issue of r.error.issues) {
    const key = issue.path.join('.') || '(profile)';
    if (!errors[key]) errors[key] = issue.message;
  }
  return { ok: false, errors };
}

/**
 * Parametric machine model built from the active profile (spec §6b).
 *
 * Scene frame = work coordinates (origin at work zero). A machine-coordinate
 * point m is drawn at m − wco. Moving parts are updated every frame from the
 * current tool pose (live position, or the playback position).
 *
 * Kinematics:
 *  - moving gantry: gantry follows Y, X carriage follows X, Z plate follows Z
 *  - moving table (3018-style): gantry fixed, the table (and everything on it:
 *    stock, toolpath, markers) moves in −Y under the spindle — see `TableGroup`
 *  - rotary (A axis ∥ X): chuck, jaws and round stock rotate with A
 *    (or with Y in Y-substitution mode)
 */
import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { type ReactNode, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { AnalysisResult } from '@/lib/gcode/client';
import { sampleAt } from '@/lib/gcode/render';
import { SEG } from '@/lib/gcode/toolpath';
import { homePosition, machineBounds } from '@/lib/profile/geometry';
import type { MachineProfile } from '@/lib/profile/schema';
import type { Problem } from '@/lib/sim/checks';
import { stockBox, type StockSetup, type ToolSetup, type Vec3 } from '@/lib/sim/setup';
import { isActivePhase, useLink } from '@/store/link';
import { useSim } from '@/store/sim';

export interface ToolPose {
  /** work coordinates x, y, z, a */
  pos: [number, number, number, number];
  /** spindle / laser on */
  powerOn: boolean;
  source: 'live' | 'sim' | 'idle';
}

/** Where the tool is right now: playback (preview), live machine, or parked at the clearance height. */
export function currentToolPose(analysis: AnalysisResult | null, profile: MachineProfile): ToolPose {
  const link = useLink.getState();
  const sim = useSim.getState();
  const jobActive = isActivePhase(link.job?.phase);
  if (analysis && !jobActive && (sim.time > 0 || sim.playing)) {
    const s = sampleAt(analysis.toolpath, analysis.render.segEnd, sim.time);
    const seg = s.seg;
    const on = seg >= 0 && analysis.toolpath.spindle[seg]! > 0 && analysis.toolpath.kind[seg] !== SEG.rapid;
    return { pos: s.pos, powerOn: on, source: 'sim' };
  }
  const w = link.state === 'connected' ? link.status?.wpos : undefined;
  if (w && w.length >= 3) return { pos: [w[0]!, w[1]!, w[2]!, w[3] ?? 0], powerOn: (link.status?.spindle ?? 0) > 0, source: 'live' };
  return { pos: [0, 0, profile.safety.clearanceZ, 0], powerOn: false, source: 'idle' };
}

// ---------------------------------------------------------------------------

export interface MachineLayout {
  /** Travel in work coordinates */
  min: Vec3;
  max: Vec3;
  bedTop: number;
  frameMin: Vec3;
  frameMax: Vec3;
  railH: number;
  railW: number;
  beamZ: number;
  beamY: number;
  movingTable: boolean;
  /** Fixed spindle Y (work) for moving-table machines */
  tableSpindleY: number;
  spindleLen: number;
  spindleR: number;
}

export function machineLayout(profile: MachineProfile, wco: Vec3, tool: ToolSetup): MachineLayout {
  const b = machineBounds(profile);
  const min: Vec3 = [b.min.x - wco[0], b.min.y - wco[1], b.min.z - wco[2]];
  const max: Vec3 = [b.max.x - wco[0], b.max.y - wco[1], b.max.z - wco[2]];
  const env = profile.geometry.envelope;
  const big = Math.max(env.x, env.y);
  const margin = Math.max(30, big * 0.08);
  const railW = Math.max(20, big * 0.04);
  const railH = Math.max(30, big * 0.06);
  const bedTop = min[2];
  let frameMin: Vec3 = [min[0] - margin, min[1] - margin, bedTop - 25];
  let frameMax: Vec3 = [max[0] + margin, max[1] + margin, bedTop];
  if (!profile.geometry.frame.auto) {
    const f = profile.geometry.frame.size;
    const cx = (min[0] + max[0]) / 2;
    const cy = (min[1] + max[1]) / 2;
    frameMin = [cx - f.x / 2, cy - f.y / 2, bedTop - 25];
    frameMax = [cx + f.x / 2, cy + f.y / 2, bedTop];
  }
  const spindleLen = profile.machineType === 'laser' ? 50 : Math.max(60, Math.min(110, env.z * 1.1));
  const spindleR = profile.machineType === 'laser' ? 18 : Math.max(18, Math.min(32, big * 0.03));
  // Beam sits behind the spindle at about the spindle's mid height with Z at the top.
  const beamZ = max[2] + tool.stickout + spindleLen * 0.5;
  const beamY = spindleR + 35;
  return {
    min,
    max,
    bedTop,
    frameMin,
    frameMax,
    railH,
    railW,
    beamZ,
    beamY,
    movingTable: profile.geometry.gantryStyle === 'moving-table',
    tableSpindleY: (min[1] + max[1]) / 2,
    spindleLen,
    spindleR,
  };
}

const MAT = {
  frame: new THREE.MeshStandardMaterial({ color: '#4a525d', metalness: 0.3, roughness: 0.6 }),
  alu: new THREE.MeshStandardMaterial({ color: '#a3acb7', metalness: 0.6, roughness: 0.35 }),
  dark: new THREE.MeshStandardMaterial({ color: '#2c3138', metalness: 0.2, roughness: 0.7 }),
  spindle: new THREE.MeshStandardMaterial({ color: '#dfe3e8', metalness: 0.5, roughness: 0.3 }),
  bit: new THREE.MeshStandardMaterial({ color: '#c9ced4', metalness: 0.9, roughness: 0.2 }),
  bed: new THREE.MeshStandardMaterial({ color: '#6b5640', roughness: 0.9 }),
  laser: new THREE.MeshStandardMaterial({ color: '#1f2937', metalness: 0.3, roughness: 0.5 }),
  beam: new THREE.MeshBasicMaterial({ color: '#ff2a2a', transparent: true, opacity: 0.85 }),
  chuck: new THREE.MeshStandardMaterial({ color: '#7c8591', metalness: 0.7, roughness: 0.3 }),
};

/** Axis-aligned box from min/max corners. */
function Block({ min, max, material }: { min: Vec3; max: Vec3; material: THREE.Material }) {
  const size: Vec3 = [Math.max(max[0] - min[0], 0.1), Math.max(max[1] - min[1], 0.1), Math.max(max[2] - min[2], 0.1)];
  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  return (
    <mesh position={center} material={material}>
      <boxGeometry args={size} />
    </mesh>
  );
}

/** Cylinder along Z from z0 to z1 at (x, y) (inside a group positioned at x, y). */
function ZCyl({ r, z0, z1, material, rTop }: { r: number; z0: number; z1: number; material: THREE.Material; rTop?: number }) {
  return (
    <mesh position={[0, 0, (z0 + z1) / 2]} rotation={[Math.PI / 2, 0, 0]} material={material}>
      <cylinderGeometry args={[rTop ?? r, r, Math.max(z1 - z0, 0.1), 24]} />
    </mesh>
  );
}

/**
 * Everything that sits on the bed. On moving-table machines it slides in Y so
 * the tool stays under the fixed spindle.
 */
export function TableGroup({ layout, analysis, profile, children }: { layout: MachineLayout; analysis: AnalysisResult | null; profile: MachineProfile; children: ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!ref.current) return;
    // Without the machine drawn there is no fixed spindle to slide under: keep the job still.
    if (!layout.movingTable || !useSim.getState().showMachine) {
      ref.current.position.y = 0;
      return;
    }
    const pose = currentToolPose(analysis, profile);
    ref.current.position.y = layout.tableSpindleY - pose.pos[1];
  });
  return <group ref={ref}>{children}</group>;
}

/** Bed / spoilboard. Rendered inside the table group. */
export function Bed({ layout }: { layout: MachineLayout }) {
  const { min, max, bedTop } = layout;
  const m = 15;
  return <Block min={[min[0] - m, min[1] - m, bedTop - 18]} max={[max[0] + m, max[1] + m, bedTop]} material={MAT.bed} />;
}

export function StockBody({ stock, profile }: { stock: StockSetup; profile: MachineProfile }) {
  const box = stockBox(stock);
  const material = useMemo(() => new THREE.MeshStandardMaterial({ color: stock.color, transparent: true, opacity: 0.35, roughness: 0.9, depthWrite: false }), [stock.color]);
  if (profile.machineType === 'rotary') return null; // drawn by the rotary model
  return <Block min={box.min} max={box.max} material={material} />;
}

export function MachineFrame({ layout, profile, analysis, tool, hideStock = false }: { layout: MachineLayout; profile: MachineProfile; analysis: AnalysisResult | null; tool: ToolSetup; hideStock?: boolean }) {
  const gantry = useRef<THREE.Group>(null);
  const xCarriage = useRef<THREE.Group>(null);
  const zGroup = useRef<THREE.Group>(null);
  const beam = useRef<THREE.Mesh>(null);
  const rotor = useRef<THREE.Group>(null);
  const { frameMin, frameMax, railH, railW, beamZ, beamY, bedTop, spindleLen, spindleR } = layout;
  const type = profile.machineType;
  const laser = type === 'laser' || type === 'router-laser';
  const spindle = type !== 'laser';
  const focus = profile.laser.focusHeight > 0 ? profile.laser.focusHeight : 5;
  const rotary = type === 'rotary';
  const ySub = rotary && profile.rotary.mode === 'y-substitution';

  useFrame(() => {
    const pose = currentToolPose(analysis, profile);
    const [x, y, z, a] = pose.pos;
    const gy = layout.movingTable ? layout.tableSpindleY : ySub ? 0 : y;
    if (gantry.current) gantry.current.position.y = gy;
    if (xCarriage.current) xCarriage.current.position.x = x;
    if (zGroup.current) zGroup.current.position.z = z;
    if (beam.current) beam.current.visible = laser && pose.powerOn;
    if (rotor.current) {
      const deg = ySub ? (y / profile.rotary.yMmPerRevolution) * 360 : a;
      rotor.current.rotation.x = THREE.MathUtils.degToRad(deg);
    }
  });

  const beamTop = beamZ + 30;
  const sideX0 = frameMin[0] + railW / 2;
  const sideX1 = frameMax[0] - railW / 2;
  const railTop = bedTop + railH * 0.4;
  const toolLen = spindle ? tool.stickout : 0;

  // Rotary: axis ∥ X through work Y0 Z0 (Z0 = stock centreline, the usual convention).
  const dia = profile.rotary.defaultStockDiameter;
  const box = rotary ? { x0: 0, x1: Math.max(profile.defaults.stock.size.x, 40) } : null;

  return (
    <group>
      {/* Base frame and Y rails */}
      <Block min={[frameMin[0], frameMin[1], frameMin[2]]} max={[frameMax[0], frameMax[1], frameMin[2] + 8]} material={MAT.frame} />
      {!layout.movingTable && (
        <>
          <Block min={[frameMin[0], frameMin[1], frameMin[2]]} max={[frameMin[0] + railW, frameMax[1], railTop]} material={MAT.alu} />
          <Block min={[frameMax[0] - railW, frameMin[1], frameMin[2]]} max={[frameMax[0], frameMax[1], railTop]} material={MAT.alu} />
        </>
      )}
      {layout.movingTable && (
        <>
          {/* Fixed uprights for a moving-table machine */}
          <Block min={[frameMin[0], layout.tableSpindleY + beamY - 20, frameMin[2]]} max={[frameMin[0] + railW, layout.tableSpindleY + beamY + 20, beamTop]} material={MAT.alu} />
          <Block min={[frameMax[0] - railW, layout.tableSpindleY + beamY - 20, frameMin[2]]} max={[frameMax[0], layout.tableSpindleY + beamY + 20, beamTop]} material={MAT.alu} />
        </>
      )}

      {/* Gantry (moves in Y unless the table moves) */}
      <group ref={gantry}>
        {!layout.movingTable && (
          <>
            <Block min={[sideX0 - railW / 2, beamY - 35, railTop]} max={[sideX0 + railW / 2, beamY + 35, beamTop]} material={MAT.dark} />
            <Block min={[sideX1 - railW / 2, beamY - 35, railTop]} max={[sideX1 + railW / 2, beamY + 35, beamTop]} material={MAT.dark} />
          </>
        )}
        <Block min={[frameMin[0], beamY - 20, beamZ - 30]} max={[frameMax[0], beamY + 20, beamZ + 30]} material={MAT.alu} />

        {/* X carriage + Z assembly */}
        <group ref={xCarriage}>
          <Block min={[-45, beamY - 32, beamZ - 50]} max={[45, beamY - 20, beamZ + 50]} material={MAT.dark} />
          <group ref={zGroup}>
            {/* Z plate (moves with the tool tip) */}
            <Block min={[-35, spindleR + 2, toolLen + 5]} max={[35, spindleR + 12, toolLen + spindleLen + 20]} material={MAT.dark} />
            {spindle && (
              <group position={[type === 'router-laser' ? -30 : 0, 0, 0]}>
                <ZCyl r={spindleR} z0={toolLen + 8} z1={toolLen + spindleLen} material={MAT.spindle} />
                <ZCyl r={spindleR * 0.45} rTop={spindleR * 0.6} z0={toolLen} z1={toolLen + 8} material={MAT.alu} />
                <ZCyl r={tool.diameter / 2} z0={0} z1={toolLen} material={MAT.bit} />
              </group>
            )}
            {laser && (
              <group position={[type === 'router-laser' ? 40 : 0, 0, 0]}>
                <Block min={[-20, -20, focus]} max={[20, 20, focus + 55]} material={MAT.laser} />
                <mesh ref={beam} position={[0, 0, focus / 2]} rotation={[Math.PI / 2, 0, 0]} material={MAT.beam} visible={false}>
                  <cylinderGeometry args={[0.4, 0.4, focus, 8]} />
                </mesh>
              </group>
            )}
          </group>
        </group>
      </group>

      {/* Rotary: headstock, chuck + round stock (rotating), tailstock */}
      {rotary && box && (
        <group>
          <Block min={[box.x0 - 70, -45, bedTop]} max={[box.x0 - 20, 45, Math.max(dia / 2 + 20, 25)]} material={MAT.dark} />
          <Block min={[box.x1 + 20, -25, bedTop]} max={[box.x1 + 45, 25, 15]} material={MAT.dark} />
          <group ref={rotor}>
            <mesh position={[box.x0 - 12, 0, 0]} rotation={[0, 0, Math.PI / 2]} material={MAT.chuck}>
              <cylinderGeometry args={[dia / 2 + 15, dia / 2 + 15, 16, 32]} />
            </mesh>
            {[0, 1, 2].map((j) => (
              <mesh key={j} position={[box.x0 - 2, Math.cos((j * 2 * Math.PI) / 3) * (dia / 2 + 4), Math.sin((j * 2 * Math.PI) / 3) * (dia / 2 + 4)]} material={MAT.alu}>
                <boxGeometry args={[14, 8, 8]} />
              </mesh>
            ))}
            <mesh position={[(box.x0 + box.x1) / 2, 0, 0]} rotation={[0, 0, Math.PI / 2]} visible={!hideStock}>
              <cylinderGeometry args={[dia / 2, dia / 2, box.x1 - box.x0, 48]} />
              <meshStandardMaterial color={profile.defaults.stock.color} transparent opacity={0.45} roughness={0.9} />
            </mesh>
            {/* reference stripe so rotation is visible */}
            <mesh position={[(box.x0 + box.x1) / 2, 0, dia / 2 + 0.3]} visible={!hideStock}>
              <boxGeometry args={[box.x1 - box.x0, 2, 0.6]} />
              <meshBasicMaterial color="#ef4444" />
            </mesh>
          </group>
        </group>
      )}
    </group>
  );
}

/** Home position and the travel box (soft limits when enabled). Rendered inside the table group. */
export function TravelAndHome({ profile, wco }: { profile: MachineProfile; wco: Vec3 }) {
  const b = machineBounds(profile);
  const min: Vec3 = [b.min.x - wco[0], b.min.y - wco[1], b.min.z - wco[2]];
  const max: Vec3 = [b.max.x - wco[0], b.max.y - wco[1], b.max.z - wco[2]];
  const h = homePosition(profile);
  const home: Vec3 = [h.x - wco[0], h.y - wco[1], h.z - wco[2]];
  const soft = profile.homing.enabled && profile.homing.softLimits;
  const edges = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2])), [min[0], min[1], min[2], max[0], max[1], max[2]]);
  return (
    <group>
      <lineSegments geometry={edges} position={[(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]}>
        <lineBasicMaterial color={soft ? '#f97316' : '#8b5cf6'} transparent opacity={0.6} />
      </lineSegments>
      <Html zIndexRange={[20, 0]} position={[min[0], max[1], max[2]]} className="pointer-events-none select-none">
        <span className="text-[10px] whitespace-nowrap" style={{ color: soft ? '#f97316' : '#8b5cf6' }}>
          {soft ? 'soft limits' : 'travel'}
        </span>
      </Html>
      {profile.homing.enabled && (
        <group position={home}>
          <mesh>
            <sphereGeometry args={[3, 16, 16]} />
            <meshBasicMaterial color="#22c55e" />
          </mesh>
          <Html zIndexRange={[20, 0]} center position={[0, 0, 8]} className="pointer-events-none select-none">
            <span className="text-[10px] font-semibold text-green-500">home</span>
          </Html>
        </group>
      )}
    </group>
  );
}

const PROBLEM_COLOR: Record<Problem['kind'], string> = { travel: '#ef4444', 'below-stock': '#e879f9', 'rapid-through-stock': '#f97316' };

export function ProblemMarkers({ problems }: { problems: Problem[] }) {
  return (
    <group>
      {problems.map((p, i) => (
        <mesh key={i} position={p.point}>
          <sphereGeometry args={[1.6, 10, 10]} />
          <meshBasicMaterial color={PROBLEM_COLOR[p.kind]} />
        </mesh>
      ))}
    </group>
  );
}

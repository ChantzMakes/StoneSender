/**
 * Three.js scene for the toolpath viewer (react-three-fiber).
 *
 * Rendering is on demand (`frameloop="demand"`): frames are drawn when the
 * camera moves, a store changes, or playback / a live job is running.
 * Per-frame values (playback time, tool positions) are read from stores
 * inside `useFrame`, so React does not re-render at 60 Hz.
 */
import { Grid, Html, OrbitControls } from '@react-three/drei';
import { type ThreeEvent, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { AnalysisResult } from '@/lib/gcode/client';
import { buildSnapIndex, niceStep, sampleAt, type SnapIndex } from '@/lib/gcode/render';
import type { MachineProfile } from '@/lib/profile/schema';
import { formatLength, toDisplay, unitLabel } from '@/lib/profile/units';
import type { Problem } from '@/lib/sim/checks';
import type { StockSetup, ToolSetup } from '@/lib/sim/setup';
import { isActivePhase, useLink } from '@/store/link';
import { Bed, currentToolPose, MachineFrame, type MachineLayout, ProblemMarkers, StockBody, TableGroup, TravelAndHome } from './MachineModel';
import { useRemoval } from '@/store/removal';
import { useSim, type Vec3 } from '@/store/sim';
import { RemovalView } from './RemovalView';

// Z is up for CNC.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export interface Palette {
  background: string;
  grid: string;
  section: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Toolpath
// ---------------------------------------------------------------------------

const VERT = /* glsl */ `
attribute float aKind;
attribute float aFeed;
attribute float aPower;
attribute float aTime;
uniform float uTime;
uniform float uMode;
uniform float uShowRapids;
uniform vec2 uFeedRange;
uniform vec2 uZRange;
uniform vec2 uPowerRange;
varying vec4 vColor;

vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 a = vec3(0.17, 0.38, 1.0);
  vec3 b = vec3(0.15, 0.85, 0.55);
  vec3 c = vec3(1.0, 0.82, 0.2);
  vec3 d = vec3(1.0, 0.27, 0.27);
  if (t < 0.33) return mix(a, b, t / 0.33);
  if (t < 0.66) return mix(b, c, (t - 0.33) / 0.33);
  return mix(c, d, (t - 0.66) / 0.34);
}
float norm(float v, vec2 r) { return r.y > r.x ? (v - r.x) / (r.y - r.x) : 0.5; }

void main() {
  vec3 col;
  float alpha = 1.0;
  if (aKind < 0.5) {
    // Rapids: neutral (ink-muted) — orange is reserved for the brand / completed cut.
    col = vec3(0.64, 0.66, 0.69);
    alpha = 0.5 * uShowRapids;
  } else if (uMode < 0.5) {
    if (aKind < 1.5) col = vec3(0.31, 0.63, 1.0);
    else if (aKind < 2.5) col = vec3(0.35, 0.84, 0.55);
    else if (aKind < 3.5) col = vec3(1.0, 0.36, 0.48);
    else col = vec3(0.77, 0.55, 1.0);
  } else if (uMode < 1.5) {
    col = ramp(norm(aFeed, uFeedRange));
  } else if (uMode < 2.5) {
    col = ramp(norm(position.z, uZRange));
  } else {
    col = ramp(norm(aPower, uPowerRange));
  }
  if (uTime >= 0.0 && aTime <= uTime) {
    // Completed cut in brand (spindle orange #E8590C), per the design system.
    col = mix(col, vec3(0.91, 0.35, 0.05), 0.85);
    alpha *= 0.85;
  }
  vColor = vec4(col, alpha);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
varying vec4 vColor;
void main() {
  if (vColor.a < 0.01) discard;
  gl_FragColor = vColor;
}`;

const MODE_INDEX = { type: 0, feed: 1, z: 2, power: 3 } as const;

/** Planned time the shader treats as "done" (−1 = nothing done). */
export function effectiveTime(analysis: AnalysisResult | null): number {
  const link = useLink.getState();
  const job = link.job;
  if (analysis && job && isActivePhase(job.phase) && job.mode === 'run') {
    const t = analysis.lineEndTime[Math.min(job.currentLine, analysis.lineEndTime.length - 1)];
    return t ?? -1;
  }
  const sim = useSim.getState();
  return sim.time > 0 || sim.playing ? sim.time : -1;
}

function ToolpathLines({ analysis, profile }: { analysis: AnalysisResult; profile: MachineProfile }) {
  const r = analysis.render;
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(r.positions, 3));
    g.setAttribute('aKind', new THREE.BufferAttribute(r.kind, 1));
    g.setAttribute('aFeed', new THREE.BufferAttribute(r.feed, 1));
    g.setAttribute('aPower', new THREE.BufferAttribute(r.power, 1));
    g.setAttribute('aTime', new THREE.BufferAttribute(r.time, 1));
    g.computeBoundingSphere();
    return g;
  }, [r]);
  useEffect(() => () => geom.dispose(), [geom]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        uniforms: {
          uTime: { value: -1 },
          uMode: { value: 0 },
          uShowRapids: { value: 1 },
          uFeedRange: { value: new THREE.Vector2(0, 1) },
          uZRange: { value: new THREE.Vector2(0, 1) },
          uPowerRange: { value: new THREE.Vector2(0, 1) },
        },
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);

  useEffect(() => {
    const s = analysis.stats;
    const b = s.cutBounds.empty ? s.workBounds : s.cutBounds;
    material.uniforms.uFeedRange!.value.set(s.feedRange?.[0] ?? 0, s.feedRange?.[1] ?? 1);
    material.uniforms.uZRange!.value.set(b.min[2], b.max[2]);
    const pmax = profile.machineType === 'laser' ? profile.laser.maxPower : Math.max(s.spindleRange?.[1] ?? 1, 1);
    material.uniforms.uPowerRange!.value.set(0, pmax);
  }, [analysis, profile, material]);

  useFrame(() => {
    const sim = useSim.getState();
    material.uniforms.uTime!.value = effectiveTime(analysis);
    material.uniforms.uMode!.value = MODE_INDEX[sim.colorMode];
    material.uniforms.uShowRapids!.value = sim.showRapids ? 1 : 0;
  });

  return <lineSegments geometry={geom} material={material} frustumCulled={false} />;
}

// ---------------------------------------------------------------------------
// Scene furniture
// ---------------------------------------------------------------------------

function Axes({ size, palette }: { size: number; palette: Palette }) {
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, size, 0, 0, 0, 0, 0, 0, size, 0, 0, 0, 0, 0, 0, size], 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute([1, 0.3, 0.3, 1, 0.3, 0.3, 0.3, 0.9, 0.4, 0.3, 0.9, 0.4, 0.3, 0.55, 1, 0.3, 0.55, 1], 3));
    return g;
  }, [size]);
  return (
    <group>
      <lineSegments geometry={geom}>
        <lineBasicMaterial vertexColors />
      </lineSegments>
      {(['X', 'Y', 'Z'] as const).map((a, i) => (
        <Html zIndexRange={[20, 0]} key={a} position={[i === 0 ? size * 1.08 : 0, i === 1 ? size * 1.08 : 0, i === 2 ? size * 1.08 : 0]} center className="pointer-events-none select-none">
          <span className="text-[11px] font-bold" style={{ color: ['#ff8787', '#69db7c', '#74c0fc'][i], textShadow: `0 0 3px ${palette.background}` }}>
            {a}
          </span>
        </Html>
      ))}
    </group>
  );
}

/** Live machine position (solid) and playback position (ghost). */
function ToolMarkers({ analysis, profile }: { analysis: AnalysisResult | null; profile: MachineProfile }) {
  const live = useRef<THREE.Group>(null);
  const ghost = useRef<THREE.Group>(null);
  const laser = profile.machineType === 'laser';
  useFrame(() => {
    const link = useLink.getState();
    const wpos = link.state === 'connected' ? link.status?.wpos : undefined;
    // With the machine model shown, the model itself is the marker for whichever
    // pose it follows; the red cone then only marks the live machine during playback.
    const machineShown = useSim.getState().showMachine;
    const poseSource = currentToolPose(analysis, profile).source;
    if (live.current) {
      live.current.visible = !!wpos && wpos.length >= 3 && (!machineShown || poseSource === 'sim');
      if (wpos) live.current.position.set(wpos[0]!, wpos[1]!, wpos[2]!);
    }
    if (ghost.current) {
      const sim = useSim.getState();
      const jobActive = isActivePhase(link.job?.phase);
      const show = !!analysis && !jobActive && (sim.time > 0 || sim.playing) && !sim.showMachine;
      ghost.current.visible = show;
      if (show && analysis) {
        const s = sampleAt(analysis.toolpath, analysis.render.segEnd, sim.time);
        ghost.current.position.set(s.pos[0], s.pos[1], s.pos[2]);
      }
    }
  });
  const marker = (color: string, opacity: number) =>
    laser ? (
      <>
        <mesh position={[0, 0, 6]}>
          <cylinderGeometry args={[3, 3, 8, 16]} />
          <meshBasicMaterial color={color} transparent opacity={opacity} />
        </mesh>
        <mesh position={[0, 0, 0.8]}>
          <sphereGeometry args={[0.8, 12, 12]} />
          <meshBasicMaterial color="#ff2d2d" transparent opacity={opacity} />
        </mesh>
      </>
    ) : (
      <mesh position={[0, 0, 6]} rotation={[-Math.PI / 2, 0, 0]}>
        <coneGeometry args={[3, 12, 20]} />
        <meshBasicMaterial color={color} transparent opacity={opacity} />
      </mesh>
    );
  return (
    <>
      <group ref={live} visible={false}>
        {marker('#e8590c', 0.95)}
      </group>
      <group ref={ghost} visible={false}>
        {marker('#38bdf8', 0.6)}
      </group>
    </>
  );
}

/** Tick labels along the X and Y edges of the job (display units). */
function Rulers({ analysis, profile, palette }: { analysis: AnalysisResult; profile: MachineProfile; palette: Palette }) {
  const ticks = useMemo(() => {
    const s = analysis.stats;
    const b = s.cutBounds.empty ? s.workBounds : s.cutBounds;
    if (b.empty) return null;
    const units = profile.units;
    const out: { pos: Vec3; text: string }[] = [];
    const span = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]);
    const stepDisp = niceStep(toDisplay(span, 'length', units), 6);
    const step = units === 'inch' ? stepDisp * 25.4 : stepDisp;
    const margin = Math.max(span * 0.06, 3);
    const z = b.min[2];
    for (const axis of [0, 1] as const) {
      const lo = Math.ceil(b.min[axis] / step) * step;
      for (let v = lo, n = 0; v <= b.max[axis] + 1e-9 && n < 40; v += step, n++) {
        const pos: Vec3 = axis === 0 ? [v, b.min[1] - margin, z] : [b.min[0] - margin, v, z];
        out.push({ pos, text: formatLength(v, units, stepDisp < 1 ? 2 : 0) });
      }
    }
    const lineGeom = new THREE.BufferGeometry();
    const pts: number[] = [];
    pts.push(b.min[0], b.min[1] - margin * 0.5, z, b.max[0], b.min[1] - margin * 0.5, z);
    pts.push(b.min[0] - margin * 0.5, b.min[1], z, b.min[0] - margin * 0.5, b.max[1], z);
    for (const t of out) {
      if (t.pos[1] === b.min[1] - margin) pts.push(t.pos[0], b.min[1] - margin * 0.5, z, t.pos[0], b.min[1] - margin * 0.3, z);
      else pts.push(b.min[0] - margin * 0.5, t.pos[1], z, b.min[0] - margin * 0.3, t.pos[1], z);
    }
    lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return { out, lineGeom, unit: unitLabel('length', units) };
  }, [analysis, profile.units]);
  useEffect(() => () => ticks?.lineGeom.dispose(), [ticks]);
  if (!ticks) return null;
  return (
    <group>
      <lineSegments geometry={ticks.lineGeom}>
        <lineBasicMaterial color={palette.label} transparent opacity={0.6} />
      </lineSegments>
      {ticks.out.map((t, i) => (
        <Html zIndexRange={[20, 0]} key={i} position={t.pos} center className="pointer-events-none select-none">
          <span className="tabular text-[10px] whitespace-nowrap" style={{ color: palette.label }}>
            {t.text}
          </span>
        </Html>
      ))}
    </group>
  );
}

function MeasureTool({ analysis, profile }: { analysis: AnalysisResult | null; profile: MachineProfile }) {
  const measuring = useSim((s) => s.measuring);
  const points = useSim((s) => s.measure);
  const add = useSim((s) => s.addMeasurePoint);
  const snap = useRef<SnapIndex | null>(null);
  useEffect(() => {
    snap.current = null;
  }, [analysis]);
  const line = useMemo(() => {
    if (points.length < 2) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([...points[0]!, ...points[1]!], 3));
    return g;
  }, [points]);
  useEffect(() => () => line?.dispose(), [line]);

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (!measuring) return;
    e.stopPropagation();
    let p: Vec3 = [e.point.x, e.point.y, 0];
    if (analysis) {
      snap.current ??= buildSnapIndex(analysis.toolpath, 2);
      const s = snap.current.nearest(p[0], p[1], 3);
      if (s) p = s;
    }
    add(p);
  };

  const units = profile.units;
  const u = unitLabel('length', units);
  const [a, b] = points;
  const d = a && b ? [b[0] - a[0], b[1] - a[1], b[2] - a[2]] : null;
  return (
    <group>
      {measuring && (
        <mesh onClick={onClick}>
          <planeGeometry args={[1e6, 1e6]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
        </mesh>
      )}
      {points.map((p, i) => (
        <mesh key={i} position={p}>
          <sphereGeometry args={[0.9, 12, 12]} />
          <meshBasicMaterial color="#facc15" />
        </mesh>
      ))}
      {line && (
        <lineSegments geometry={line}>
          <lineBasicMaterial color="#facc15" />
        </lineSegments>
      )}
      {a && b && d && (
        <Html zIndexRange={[20, 0]} position={[(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]} center className="pointer-events-none select-none">
          <div className="tabular rounded bg-black/75 px-2 py-1 text-[11px] whitespace-nowrap text-yellow-300" data-testid="measure-label">
            {formatLength(Math.hypot(d[0]!, d[1]!, d[2]!), units, 2)} {u}
            <span className="ml-2 text-yellow-100/70">
              ΔX {formatLength(d[0]!, units, 2)} ΔY {formatLength(d[1]!, units, 2)} ΔZ {formatLength(d[2]!, units, 2)}
            </span>
          </div>
        </Html>
      )}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export interface ViewBounds {
  min: Vec3;
  max: Vec3;
}

function CameraRig({ bounds, machine }: { bounds: ViewBounds; machine: ViewBounds }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera, invalidate } = useThree();
  const req = useSim((s) => s.viewRequest);
  const lastFollow = useRef<THREE.Vector3 | null>(null);
  const boundsKey = `${bounds.min.join(',')}|${bounds.max.join(',')}`;

  const apply = (kind: 'top' | 'front' | 'side' | 'iso' | 'fit' | 'machine') => {
    const c = controls.current;
    if (!c) return;
    if (kind === 'machine') {
      fitTo(machine, new THREE.Vector3(0.75, -1, 0.85).normalize());
      return;
    }
    fitTo(bounds, null, kind);
  };

  const fitTo = (bounds: ViewBounds, fixedDir: THREE.Vector3 | null, kind: 'top' | 'front' | 'side' | 'iso' | 'fit' = 'iso') => {
    const c = controls.current;
    if (!c) return;
    const center = new THREE.Vector3((bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2);
    const size = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2], 20);
    const dist = size * 1.5;
    const dir = fixedDir
      ? fixedDir.clone()
      : kind === 'top'
        ? new THREE.Vector3(0, -0.0001, 1)
        : kind === 'front'
          ? new THREE.Vector3(0, -1, 0.0001)
          : kind === 'side'
            ? new THREE.Vector3(1, 0, 0.0001)
            : kind === 'fit'
              ? camera.position.clone().sub(c.target).normalize()
              : new THREE.Vector3(0.75, -1, 0.85).normalize();
    camera.position.copy(center).add(dir.normalize().multiplyScalar(dist));
    const cam = camera as THREE.PerspectiveCamera;
    cam.near = Math.max(dist / 2000, 0.01);
    cam.far = dist * 200;
    cam.updateProjectionMatrix();
    c.target.copy(center);
    c.update();
    invalidate();
  };

  useEffect(() => {
    if (req) apply(req.kind);
    // apply() reads the latest bounds
  }, [req?.seq]);

  useEffect(() => {
    apply('iso');
  }, [boundsKey]);

  useFrame(() => {
    const sim = useSim.getState();
    const c = controls.current;
    if (!sim.follow || !c) {
      lastFollow.current = null;
      return;
    }
    const link = useLink.getState();
    const w = link.state === 'connected' ? link.status?.wpos : undefined;
    if (!w || w.length < 3) return;
    const p = new THREE.Vector3(w[0], w[1], w[2]);
    if (lastFollow.current) {
      const delta = p.clone().sub(lastFollow.current);
      if (delta.lengthSq() > 0) {
        camera.position.add(delta);
        c.target.add(delta);
        c.update();
      }
    }
    lastFollow.current = p;
  });

  return <OrbitControls ref={controls} makeDefault enableDamping={false} screenSpacePanning />;
}

/** Keeps frames coming while something animates; otherwise renders on demand. */
function Ticker({ analysis }: { analysis: AnalysisResult | null }) {
  const { invalidate } = useThree();
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lineSent = 0;
    const loop = () => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      const sim = useSim.getState();
      if (sim.playing && analysis) {
        const total = analysis.stats.time.total;
        const t = Math.min(total, sim.time + dt * sim.speed);
        sim.setTime(t);
        if (t >= total) sim.setPlaying(false);
        if (now - lineSent > 100) {
          lineSent = now;
          useSim.setState({ line: sampleAt(analysis.toolpath, analysis.render.segEnd, t).line });
        }
        invalidate();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const unsubs = [useSim.subscribe(() => invalidate()), useLink.subscribe(() => invalidate())];
    return () => {
      cancelAnimationFrame(raf);
      unsubs.forEach((u) => u());
    };
  }, [analysis, invalidate]);
  return null;
}

// ---------------------------------------------------------------------------

export interface SceneProps {
  analysis: AnalysisResult | null;
  profile: MachineProfile;
  palette: Palette;
  bounds: ViewBounds;
  layout: MachineLayout;
  stock: StockSetup;
  tool: ToolSetup;
  wco: Vec3;
  problems: Problem[];
}

export function Scene({ analysis, profile, palette, bounds, layout, stock, tool, wco, problems }: SceneProps) {
  const showGrid = useSim((s) => s.showGrid);
  const showEnvelope = useSim((s) => s.showEnvelope);
  const showMachine = useSim((s) => s.showMachine);
  const showStock = useSim((s) => s.showStock);
  const showToolpath = useSim((s) => s.showToolpath);
  const showRemoval = useSim((s) => s.showRemoval);
  const removalReady = useRemoval((s) => s.status === 'ready');
  const removalShown = showRemoval && removalReady;
  const size = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], 20);
  return (
    <>
      <color attach="background" args={[palette.background]} />
      <ambientLight intensity={0.75} />
      <directionalLight position={[1, -1.5, 2]} intensity={1.6} />
      <directionalLight position={[-1, 1, 0.5]} intensity={0.4} />
      {showGrid && (
        <Grid
          rotation={[Math.PI / 2, 0, 0]}
          position={[0, 0, (showMachine ? layout.frameMin[2] : Math.min(bounds.min[2], layout.bedTop)) - 0.5]}
          cellSize={size > 600 ? 50 : 10}
          sectionSize={size > 600 ? 500 : 100}
          cellColor={palette.grid}
          sectionColor={palette.section}
          infiniteGrid
          fadeDistance={size * 6}
          fadeStrength={1.5}
        />
      )}
      <Axes size={Math.max(size * 0.12, 10)} palette={palette} />
      {showMachine && <MachineFrame layout={layout} profile={profile} analysis={analysis} tool={tool} hideStock={removalShown && showStock} />}
      <TableGroup layout={layout} analysis={analysis} profile={profile}>
        {showMachine && <Bed layout={layout} />}
        {showStock && !removalShown && <StockBody stock={stock} profile={profile} />}
        {showStock && removalShown && <RemovalView analysis={analysis} profile={profile} color={stock.color} />}
        {showEnvelope && <TravelAndHome profile={profile} wco={wco} />}
        {analysis && showToolpath && <ToolpathLines analysis={analysis} profile={profile} />}
        {analysis && showGrid && <Rulers analysis={analysis} profile={profile} palette={palette} />}
        <ProblemMarkers problems={problems} />
        <ToolMarkers analysis={analysis} profile={profile} />
        <MeasureTool analysis={analysis} profile={profile} />
      </TableGroup>
      <CameraRig bounds={bounds} machine={{ min: layout.frameMin, max: [layout.frameMax[0], layout.frameMax[1], layout.beamZ + 40] }} />
      <Ticker analysis={analysis} />
    </>
  );
}

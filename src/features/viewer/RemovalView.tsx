/**
 * Material-removal result in the 3D view (spec §6c):
 *  - router: heightfield mesh over the stock (one vertex per cell) with side
 *    walls; gouges / cuts below the stock / islands are tinted
 *  - laser: burn map texture on the stock's top face
 *  - rotary: cylinder of remaining radius, rotating with A
 *
 * Geometry is created once per simulation grid; worker patches update only
 * the changed rectangle of the vertex buffers (no React re-render).
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { AnalysisResult } from '@/lib/gcode/client';
import type { MachineProfile } from '@/lib/profile/schema';
import type { Box3 } from '@/lib/sim/setup';
import { FLAG_BELOW, FLAG_GOUGE, FLAG_ISLAND, type Grid } from '@/lib/sim/removal';
import { buffers, useRemoval } from '@/store/removal';
import { currentToolPose } from './MachineModel';

const GOUGE = new THREE.Color('#ef4444');
const BELOW = new THREE.Color('#e879f9');
const ISLAND = new THREE.Color('#facc15');
/** Laser darkening: 1 − exp(−k·e), e = seconds of full power per mm of track */
export const BURN_K = 40;

interface Rect {
  i0: number;
  j0: number;
  i1: number;
  j1: number;
}

function fullRect(g: Grid): Rect {
  return { i0: 0, j0: 0, i1: g.nx - 1, j1: g.ny - 1 };
}

/** Subscribe to patches; `apply(rect)` updates GPU buffers for that rectangle. */
function usePatches(grid: Grid, target: object, apply: (r: Rect) => void) {
  const { invalidate } = useThree();
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    if (buffers.data) applyRef.current(fullRect(grid));
    invalidate();
    return useRemoval.subscribe((s, prev) => {
      if (s.version === prev.version || !buffers.data) return;
      const p = buffers.lastPatch;
      applyRef.current(p ? { i0: p.i0, j0: p.j0, i1: p.i0 + p.w - 1, j1: p.j0 + p.h - 1 } : fullRect(grid));
      invalidate();
    });
  }, [grid, target, invalidate]);
}

// ---------------------------------------------------------------------------
// Router heightfield
// ---------------------------------------------------------------------------

function HeightField({ grid, color, bottom, top }: { grid: Grid; color: string; bottom: number; top: number }) {
  const { nx, ny } = grid;
  const base = useMemo(() => new THREE.Color(color), [color]);
  const cut = useMemo(() => new THREE.Color(color).lerp(new THREE.Color('#fff7e6'), 0.35), [color]);

  const { surface, walls } = useMemo(() => {
    const n = nx * ny;
    const pos = new Float32Array(n * 3);
    const nor = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        pos[k * 3] = grid.x0 + (i + 0.5) * grid.res;
        pos[k * 3 + 1] = grid.y0 + (j + 0.5) * grid.resY;
        pos[k * 3 + 2] = top;
        nor[k * 3 + 2] = 1;
      }
    }
    const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
    let q = 0;
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        const b = a + 1;
        const c = a + nx;
        const d = c + 1;
        idx[q++] = a;
        idx[q++] = b;
        idx[q++] = d;
        idx[q++] = a;
        idx[q++] = d;
        idx[q++] = c;
      }
    }
    const surface = new THREE.BufferGeometry();
    surface.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    surface.setAttribute('normal', new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage));
    surface.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    surface.setIndex(new THREE.BufferAttribute(idx, 1));
    surface.boundingSphere = new THREE.Sphere(new THREE.Vector3(grid.x0 + (nx * grid.res) / 2, grid.y0 + (ny * grid.resY) / 2, (top + bottom) / 2), Math.hypot(nx * grid.res, ny * grid.resY, top - bottom));

    // Side walls: a strip along the perimeter from the edge heights down to the bottom, plus the bottom face.
    const perim: number[] = [];
    for (let i = 0; i < nx; i++) perim.push(i);
    for (let j = 1; j < ny; j++) perim.push(j * nx + nx - 1);
    for (let i = nx - 2; i >= 0; i--) perim.push((ny - 1) * nx + i);
    for (let j = ny - 2; j >= 1; j--) perim.push(j * nx);
    const m = perim.length;
    const wpos = new Float32Array((m + 1) * 2 * 3 + 4 * 3);
    const widx: number[] = [];
    for (let s = 0; s < m; s++) {
      const a = s * 2;
      const b = ((s + 1) % m) * 2;
      // outward-facing (perimeter runs counter-clockwise seen from above)
      widx.push(a, a + 1, b + 1, a, b + 1, b);
    }
    const bot = m * 2 + 2;
    const xa = grid.x0 + 0.5 * grid.res;
    const xb = grid.x0 + (nx - 0.5) * grid.res;
    const ya = grid.y0 + 0.5 * grid.resY;
    const yb = grid.y0 + (ny - 0.5) * grid.resY;
    wpos.set([xa, ya, bottom, xb, ya, bottom, xb, yb, bottom, xa, yb, bottom], bot * 3);
    widx.push(bot, bot + 2, bot + 1, bot, bot + 3, bot + 2);
    const walls = new THREE.BufferGeometry();
    walls.setAttribute('position', new THREE.BufferAttribute(wpos, 3).setUsage(THREE.DynamicDrawUsage));
    walls.setIndex(widx);
    walls.userData.perim = perim;
    walls.boundingSphere = surface.boundingSphere.clone();
    return { surface, walls };
  }, [grid, top, bottom]);
  useEffect(
    () => () => {
      surface.dispose();
      walls.dispose();
    },
    [surface, walls],
  );

  usePatches(grid, surface, (r) => {
    const data = buffers.data!;
    const flags = buffers.flags!;
    const pos = surface.getAttribute('position') as THREE.BufferAttribute;
    const nor = surface.getAttribute('normal') as THREE.BufferAttribute;
    const col = surface.getAttribute('color') as THREE.BufferAttribute;
    const P = pos.array as Float32Array;
    const N = nor.array as Float32Array;
    const C = col.array as Float32Array;
    const depthRange = Math.max(top - bottom, 0.01);
    for (let j = r.j0; j <= r.j1; j++) {
      for (let i = r.i0; i <= r.i1; i++) {
        const k = j * nx + i;
        const h = data[k]!;
        P[k * 3 + 2] = h;
        const f = flags[k]!;
        let c: THREE.Color;
        if (f & FLAG_GOUGE) c = GOUGE;
        else if (f & FLAG_BELOW) c = BELOW;
        else if (f & FLAG_ISLAND) c = ISLAND;
        else c = h < top - 1e-3 ? cut : base;
        // darker the deeper the cut, so depth reads even from the top
        const shade = f ? 1 : 1 - 0.35 * Math.min(1, (top - h) / depthRange);
        C[k * 3] = c.r * shade;
        C[k * 3 + 1] = c.g * shade;
        C[k * 3 + 2] = c.b * shade;
      }
    }
    // normals over the rect grown by one cell (neighbours' gradients changed too)
    const i0 = Math.max(0, r.i0 - 1);
    const i1 = Math.min(nx - 1, r.i1 + 1);
    const j0 = Math.max(0, r.j0 - 1);
    const j1 = Math.min(ny - 1, r.j1 + 1);
    const dx2 = 2 * grid.res;
    const dy2 = 2 * grid.resY;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * nx + i;
        const hl = data[i > 0 ? k - 1 : k]!;
        const hr = data[i < nx - 1 ? k + 1 : k]!;
        const hd = data[j > 0 ? k - nx : k]!;
        const hu = data[j < ny - 1 ? k + nx : k]!;
        const gx = (hl - hr) / dx2;
        const gy = (hd - hu) / dy2;
        const inv = 1 / Math.sqrt(gx * gx + gy * gy + 1);
        N[k * 3] = gx * inv;
        N[k * 3 + 1] = gy * inv;
        N[k * 3 + 2] = inv;
      }
    }
    const start = (j0 * nx + i0) * 3;
    const count = ((j1 * nx + i1) * 3 + 3) - start;
    for (const a of [pos, nor]) {
      a.clearUpdateRanges();
      a.addUpdateRange(start, count);
      a.needsUpdate = true;
    }
    col.clearUpdateRanges();
    col.addUpdateRange((r.j0 * nx + r.i0) * 3, ((r.j1 * nx + r.i1) * 3 + 3) - (r.j0 * nx + r.i0) * 3);
    col.needsUpdate = true;

    // walls follow the edge heights when the patch touches the border
    if (r.i0 === 0 || r.j0 === 0 || r.i1 === nx - 1 || r.j1 === ny - 1) {
      const perim = walls.userData.perim as number[];
      const wp = walls.getAttribute('position') as THREE.BufferAttribute;
      const W = wp.array as Float32Array;
      perim.forEach((k, s) => {
        const x = P[k * 3]!;
        const y = P[k * 3 + 1]!;
        W.set([x, y, data[k]!, x, y, bottom], s * 6);
      });
      wp.needsUpdate = true;
    }
  });

  return (
    <group>
      <mesh geometry={surface} frustumCulled={false} data-testid="removal-mesh">
        <meshStandardMaterial vertexColors roughness={0.85} metalness={0} />
      </mesh>
      <mesh geometry={walls} frustumCulled={false}>
        <meshStandardMaterial color={base.clone().multiplyScalar(0.8)} roughness={0.9} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Laser burn map
// ---------------------------------------------------------------------------

function BurnMap({ grid, color, stock }: { grid: Grid; color: string; stock: Box3 }) {
  const top = stock.max[2];
  const bottom = stock.min[2];
  const { nx, ny } = grid;
  const base = useMemo(() => new THREE.Color(color), [color]);
  const burnt = useMemo(() => new THREE.Color('#1c130c'), []);
  const tex = useMemo(() => {
    const t = new THREE.DataTexture(new Uint8Array(nx * ny * 4), nx, ny, THREE.RGBAFormat);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [nx, ny]);
  useEffect(() => () => tex.dispose(), [tex]);
  const baseHex = base.getHexString();

  usePatches(grid, tex, (r) => {
    const data = buffers.data!;
    const flags = buffers.flags!;
    const px = tex.image.data as Uint8Array;
    const b = new THREE.Color('#' + baseHex);
    for (let j = r.j0; j <= r.j1; j++) {
      for (let i = r.i0; i <= r.i1; i++) {
        const k = j * nx + i;
        const dark = 1 - Math.exp(-BURN_K * data[k]!);
        const c = flags[k]! & FLAG_GOUGE ? GOUGE : b.clone().lerp(burnt, dark);
        px[k * 4] = Math.round(c.r * 255);
        px[k * 4 + 1] = Math.round(c.g * 255);
        px[k * 4 + 2] = Math.round(c.b * 255);
        px[k * 4 + 3] = 255;
      }
    }
    tex.needsUpdate = true;
  });

  const w = nx * grid.res;
  const d = ny * grid.resY;
  return (
    <group>
      <mesh position={[grid.x0 + w / 2, grid.y0 + d / 2, top + 0.01]} data-testid="burn-map">
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial map={tex} roughness={0.9} />
      </mesh>
      <mesh position={[(stock.min[0] + stock.max[0]) / 2, (stock.min[1] + stock.max[1]) / 2, (top + bottom) / 2]}>
        <boxGeometry args={[stock.max[0] - stock.min[0], stock.max[1] - stock.min[1], Math.max(top - bottom, 0.01)]} />
        <meshStandardMaterial color={base} roughness={0.9} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Rotary cylinder
// ---------------------------------------------------------------------------

function RotaryStock({ grid, color, analysis, profile }: { grid: Grid; color: string; analysis: AnalysisResult | null; profile: MachineProfile }) {
  const { nx, ny } = grid;
  const rotor = useRef<THREE.Group>(null);
  const base = useMemo(() => new THREE.Color(color), [color]);
  const cut = useMemo(() => new THREE.Color(color).lerp(new THREE.Color('#fff7e6'), 0.35), [color]);
  const r0 = buffers.config?.rotaryRadius ?? 25;
  const ySub = profile.rotary.mode === 'y-substitution';

  const geom = useMemo(() => {
    // (ny + 1) columns around so the seam closes; + 2 centre points for the end caps.
    const cols = ny + 1;
    const n = nx * cols + 2;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const idx: number[] = [];
    for (let i = 0; i < nx - 1; i++) {
      for (let j = 0; j < ny; j++) {
        const a = i * cols + j;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        idx.push(a, d, c, a, b, d);
      }
    }
    const ca = nx * cols;
    const cb = ca + 1;
    for (let j = 0; j < ny; j++) {
      idx.push(ca, j + 1, j);
      idx.push(cb, (nx - 1) * cols + j, (nx - 1) * cols + j + 1);
    }
    pos.set([grid.x0, 0, 0], ca * 3);
    pos.set([grid.x0 + nx * grid.res, 0, 0], cb * 3);
    col.set([base.r * 0.8, base.g * 0.8, base.b * 0.8], ca * 3);
    col.set([base.r * 0.8, base.g * 0.8, base.b * 0.8], cb * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(grid.x0 + (nx * grid.res) / 2, 0, 0), nx * grid.res + 2 * r0);
    return g;
  }, [grid, base, r0]);
  useEffect(() => () => geom.dispose(), [geom]);

  usePatches(grid, geom, (r) => {
    const data = buffers.data!;
    const flags = buffers.flags!;
    const cols = ny + 1;
    const P = (geom.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    const C = (geom.getAttribute('color') as THREE.BufferAttribute).array as Float32Array;
    for (let j = r.j0; j <= r.j1; j++) {
      const th = (j + 0.5) * grid.resY;
      const s = Math.sin(th);
      const c = Math.cos(th);
      for (let i = r.i0; i <= r.i1; i++) {
        const k = j * nx + i;
        const rad = data[k]!;
        const f = flags[k]!;
        const colr = f & FLAG_GOUGE ? GOUGE : f & FLAG_BELOW ? BELOW : rad < r0 - 1e-3 ? cut : base;
        const shade = f ? 1 : 1 - 0.35 * Math.min(1, (r0 - rad) / Math.max(r0, 1));
        const write = (v: number) => {
          P.set([grid.x0 + (i + 0.5) * grid.res, -rad * s, rad * c], v * 3);
          C.set([colr.r * shade, colr.g * shade, colr.b * shade], v * 3);
        };
        write(i * cols + j);
        if (j === 0) write(i * cols + ny);
      }
    }
    geom.getAttribute('position').needsUpdate = true;
    geom.getAttribute('color').needsUpdate = true;
    geom.computeVertexNormals();
  });

  useFrame(() => {
    if (!rotor.current) return;
    const pose = currentToolPose(analysis, profile);
    const deg = ySub ? (pose.pos[1] / profile.rotary.yMmPerRevolution) * 360 : pose.pos[3];
    rotor.current.rotation.x = THREE.MathUtils.degToRad(deg);
  });

  return (
    <group ref={rotor}>
      <mesh geometry={geom} frustumCulled={false} data-testid="rotary-mesh">
        <meshStandardMaterial vertexColors roughness={0.85} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------

/** Problem markers from the removal simulation (gouges, flutes, holder, islands). */
const EVENT_COLOR = { 'rapid-gouge': '#ef4444', 'below-stock': '#e879f9', holder: '#fb923c', flute: '#f59e0b', island: '#facc15' } as const;

function EventMarkers() {
  const events = useRemoval((s) => s.events);
  const mode = useRemoval((s) => s.mode);
  if (mode === 'rotary') return null; // event points are in the rotating stock frame
  return (
    <group>
      {events.map((e, i) => (
        <mesh key={i} position={[e.x, e.y, e.z]}>
          <octahedronGeometry args={[1.4]} />
          <meshBasicMaterial color={EVENT_COLOR[e.kind]} />
        </mesh>
      ))}
    </group>
  );
}

export function RemovalView({ analysis, profile, color }: { analysis: AnalysisResult | null; profile: MachineProfile; color: string }) {
  const grid = useRemoval((s) => s.grid);
  const mode = useRemoval((s) => s.mode);
  const status = useRemoval((s) => s.status);
  const cfg = buffers.config;
  if (status !== 'ready' || !grid || !cfg) return null;
  return (
    <group>
      {mode === 'router' && <HeightField grid={grid} color={color} top={cfg.stockMax[2]} bottom={cfg.stockMin[2]} />}
      {mode === 'laser' && buffers.stock && <BurnMap grid={grid} color={color} stock={buffers.stock} />}
      {mode === 'rotary' && <RotaryStock grid={grid} color={color} analysis={analysis} profile={profile} />}
      <EventMarkers />
    </group>
  );
}

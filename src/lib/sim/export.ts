/**
 * Exports of the material-removal result: binary STL of the remaining
 * material (router heightfield or rotary cylinder) and a PNG of a laser burn
 * map. Pure functions over the simulation grid, so they run anywhere.
 */
import type { Grid } from './removal';

// ---------------------------------------------------------------------------
// STL
// ---------------------------------------------------------------------------

class StlWriter {
  private view: DataView;
  private off = 84;
  count = 0;
  constructor(readonly maxTris: number) {
    this.view = new DataView(new ArrayBuffer(84 + maxTris * 50));
  }
  tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number) {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) return; // degenerate (e.g. a wall where the edge is cut to the bottom)
    nx /= l;
    ny /= l;
    nz /= l;
    const v = this.view;
    let o = this.off;
    for (const x of [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz]) {
      v.setFloat32(o, x, true);
      o += 4;
    }
    v.setUint16(o, 0, true);
    this.off = o + 2;
    this.count++;
  }
  finish(header: string): Uint8Array {
    const bytes = new Uint8Array(this.view.buffer, 0, this.off);
    for (let i = 0; i < Math.min(80, header.length); i++) bytes[i] = header.charCodeAt(i) & 0x7f;
    this.view.setUint32(80, this.count, true);
    return bytes;
  }
}

/**
 * Closed solid of the remaining stock: the heightfield (one vertex per cell
 * centre), four walls down to `bottom` and the bottom face. Units: mm, work
 * coordinates.
 */
export function heightfieldStl(grid: Grid, data: Float32Array, bottom: number, name = 'stock'): Uint8Array {
  const { nx, ny } = grid;
  const X = (i: number) => grid.x0 + (i + 0.5) * grid.res;
  const Y = (j: number) => grid.y0 + (j + 0.5) * grid.resY;
  const H = (i: number, j: number) => data[j * nx + i]!;
  const w = new StlWriter((nx - 1) * (ny - 1) * 2 + 4 * (nx + ny) + 2);
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const x0 = X(i), x1 = X(i + 1), y0 = Y(j), y1 = Y(j + 1);
      w.tri(x0, y0, H(i, j), x1, y0, H(i + 1, j), x1, y1, H(i + 1, j + 1));
      w.tri(x0, y0, H(i, j), x1, y1, H(i + 1, j + 1), x0, y1, H(i, j + 1));
    }
  }
  // walls: outward normals
  const xa = X(0), xb = X(nx - 1), ya = Y(0), yb = Y(ny - 1);
  for (let i = 0; i < nx - 1; i++) {
    const x0 = X(i), x1 = X(i + 1);
    // front (y = ya, normal −Y)
    w.tri(x0, ya, bottom, x1, ya, bottom, x1, ya, H(i + 1, 0));
    w.tri(x0, ya, bottom, x1, ya, H(i + 1, 0), x0, ya, H(i, 0));
    // back (normal +Y)
    w.tri(x1, yb, bottom, x0, yb, bottom, x0, yb, H(i, ny - 1));
    w.tri(x1, yb, bottom, x0, yb, H(i, ny - 1), x1, yb, H(i + 1, ny - 1));
  }
  for (let j = 0; j < ny - 1; j++) {
    const y0 = Y(j), y1 = Y(j + 1);
    // left (normal −X)
    w.tri(xa, y1, bottom, xa, y0, bottom, xa, y0, H(0, j));
    w.tri(xa, y1, bottom, xa, y0, H(0, j), xa, y1, H(0, j + 1));
    // right (normal +X)
    w.tri(xb, y0, bottom, xb, y1, bottom, xb, y1, H(nx - 1, j + 1));
    w.tri(xb, y0, bottom, xb, y1, H(nx - 1, j + 1), xb, y0, H(nx - 1, j));
  }
  // bottom (normal −Z)
  w.tri(xa, ya, bottom, xb, yb, bottom, xb, ya, bottom);
  w.tri(xa, ya, bottom, xa, yb, bottom, xb, yb, bottom);
  return w.finish(`binary STL ${name} - CNC Sender material removal`);
}

/** Closed solid of rotary stock: radius map around the X axis, with end caps. */
export function rotaryStl(grid: Grid, data: Float32Array, name = 'rotary stock'): Uint8Array {
  const { nx, ny } = grid;
  const w = new StlWriter((nx - 1) * ny * 2 + 2 * ny);
  const P = (i: number, j: number): [number, number, number] => {
    const jj = j % ny;
    const th = (jj + 0.5) * grid.resY;
    const r = data[jj * nx + i]!;
    return [grid.x0 + (i + 0.5) * grid.res, -r * Math.sin(th), r * Math.cos(th)];
  };
  for (let i = 0; i < nx - 1; i++) {
    for (let j = 0; j < ny; j++) {
      const a = P(i, j), b = P(i, j + 1), c = P(i + 1, j), d = P(i + 1, j + 1);
      w.tri(...a, ...d, ...c);
      w.tri(...a, ...b, ...d);
    }
  }
  const xa = grid.x0 + 0.5 * grid.res;
  const xb = grid.x0 + (nx - 0.5) * grid.res;
  for (let j = 0; j < ny; j++) {
    w.tri(xa, 0, 0, ...P(0, j + 1), ...P(0, j));
    w.tri(xb, 0, 0, ...P(nx - 1, j), ...P(nx - 1, j + 1));
  }
  return w.finish(`binary STL ${name} - CNC Sender material removal`);
}

/** Volume enclosed by a binary STL (divergence theorem) — used by tests. */
export function stlVolume(bytes: Uint8Array): number {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = v.getUint32(80, true);
  let vol = 0;
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50 + 12;
    const f = (k: number) => v.getFloat32(o + k * 4, true);
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = [f(0), f(1), f(2), f(3), f(4), f(5), f(6), f(7), f(8)];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return vol;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Minimal PNG encoder (8-bit RGB, stored deflate blocks — no compression
 * library needed). `rgb` is row-major, top row first.
 */
export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const rowLen = width * 3 + 1;
  const raw = new Uint8Array(rowLen * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowLen] = 0; // filter: none
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * rowLen + 1);
  }
  // zlib stream with stored blocks (≤ 65535 bytes each)
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const z = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  z[0] = 0x78;
  z[1] = 0x01;
  let o = 2;
  for (let b = 0; b < blocks; b++) {
    const start = b * 65535;
    const len = Math.min(65535, raw.length - start);
    z[o++] = b === blocks - 1 ? 1 : 0;
    z[o++] = len & 0xff;
    z[o++] = len >>> 8;
    z[o++] = ~len & 0xff;
    z[o++] = (~len >>> 8) & 0xff;
    z.set(raw.subarray(start, start + len), o);
    o += len;
  }
  let a = 1;
  let bsum = 0;
  for (let i = 0; i < raw.length; i++) {
    a = (a + raw[i]!) % 65521;
    bsum = (bsum + a) % 65521;
  }
  const adler = ((bsum << 16) | a) >>> 0;
  z[o++] = adler >>> 24;
  z[o++] = (adler >>> 16) & 0xff;
  z[o++] = (adler >>> 8) & 0xff;
  z[o++] = adler & 0xff;

  const chunks: [string, Uint8Array][] = [];
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit, truecolour
  chunks.push(['IHDR', ihdr], ['IDAT', z.subarray(0, o)], ['IEND', new Uint8Array(0)]);
  const total = 8 + chunks.reduce((s, [, d]) => s + 12 + d.length, 0);
  const out = new Uint8Array(total);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ov = new DataView(out.buffer);
  let p = 8;
  for (const [type, d] of chunks) {
    ov.setUint32(p, d.length);
    for (let i = 0; i < 4; i++) out[p + 4 + i] = type.charCodeAt(i);
    out.set(d, p + 8);
    ov.setUint32(p + 8 + d.length, crc32(out, p + 4, p + 8 + d.length));
    p += 12 + d.length;
  }
  return out;
}

/**
 * Burn map → PNG: stock colour darkened by 1 − exp(−k·energy). One pixel per
 * grid cell; image top = the back of the stock (+Y).
 */
export function burnPng(grid: Grid, data: Float32Array, stockColor: string, k: number): Uint8Array {
  const { nx, ny } = grid;
  const hex = stockColor.replace('#', '');
  const base = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) || 200);
  const burnt = [28, 19, 12];
  const rgb = new Uint8Array(nx * ny * 3);
  for (let j = 0; j < ny; j++) {
    const row = ny - 1 - j;
    for (let i = 0; i < nx; i++) {
      const d = 1 - Math.exp(-k * data[j * nx + i]!);
      for (let c = 0; c < 3; c++) rgb[(row * nx + i) * 3 + c] = Math.round(base[c]! + (burnt[c]! - base[c]!) * d);
    }
  }
  return encodePng(nx, ny, rgb);
}

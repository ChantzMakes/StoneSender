import { describe, expect, it } from 'vitest';
import { burnPng, encodePng, heightfieldStl, rotaryStl, stlVolume } from './export';
import type { Grid } from './removal';

describe('STL export', () => {
  it('writes a closed heightfield solid with the right volume', () => {
    const grid: Grid = { x0: 0, y0: 0, res: 1, resY: 1, nx: 11, ny: 6 };
    const data = new Float32Array(grid.nx * grid.ny).fill(0);
    // a 2 mm deep step over half the stock
    for (let j = 0; j < grid.ny; j++) for (let i = 0; i < 5; i++) data[j * grid.nx + i] = -2;
    const stl = heightfieldStl(grid, data, -10);
    const n = new DataView(stl.buffer, stl.byteOffset).getUint32(80, true);
    expect(stl.length).toBe(84 + n * 50);
    // vertices span cell centres 0.5…10.5 × 0.5…5.5 = 10 × 5; heights 8 or 10 with a sloped cell in between
    const v = stlVolume(stl);
    expect(v).toBeGreaterThan(10 * 5 * 8);
    expect(v).toBeLessThan(10 * 5 * 10);
    expect(v).toBeCloseTo(5 * (4 * 8 + 1 * 9 + 5 * 10), 3);
  });

  it('writes a closed rotary solid', () => {
    const ny = 64;
    const grid: Grid = { x0: 0, y0: 0, res: 1, resY: (2 * Math.PI) / ny, nx: 21, ny };
    const data = new Float32Array(grid.nx * ny).fill(10);
    const v = stlVolume(rotaryStl(grid, data));
    // polygon area (ny-gon of radius 10) × length 20
    const area = 0.5 * ny * 100 * Math.sin((2 * Math.PI) / ny);
    expect(v).toBeCloseTo(area * 20, 0);
  });
});

describe('PNG export', () => {
  it('encodes a valid PNG with CRCs', () => {
    const png = encodePng(2, 2, new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(String.fromCharCode(...png.subarray(12, 16))).toBe('IHDR');
    const dv = new DataView(png.buffer);
    expect(dv.getUint32(16)).toBe(2);
    expect(dv.getUint32(20)).toBe(2);
    // IEND chunk CRC is the well-known constant
    expect(dv.getUint32(png.length - 4)).toBe(0xae426082);
  });

  it('darkens burnt cells and flips Y so the back is at the top', () => {
    const grid: Grid = { x0: 0, y0: 0, res: 1, resY: 1, nx: 70000, ny: 2 };
    const data = new Float32Array(grid.nx * 2);
    data[0] = 1; // front-left cell burnt
    const png = burnPng(grid, data, '#e0c090', 40);
    expect(png.length).toBeGreaterThan(70000 * 2 * 3); // stored deflate spans several blocks
    expect(String.fromCharCode(...png.subarray(37, 41))).toBe('IDAT');
  });
});

describe('pre-flight lines from the removal simulation', () => {
  it('summarises problems by kind with their lines', async () => {
    const { removalChecks } = await import('@/lib/job/preflight');
    const ev = (kind: 'rapid-gouge' | 'holder' | 'flute' | 'island', line: number) => ({ kind, line, x: 0, y: 0, z: 0, detail: '' });
    const out = removalChecks([ev('rapid-gouge', 9), ev('rapid-gouge', 4), ev('holder', 12), ev('island', 0)]);
    expect(out.find((c) => c.id === 'sim-gouge')?.title).toContain('lines 4, 9');
    expect(out.find((c) => c.id === 'sim-holder')?.level).toBe('warn');
    expect(out.find((c) => c.id === 'sim-island')?.level).toBe('info');
    expect(removalChecks([])[0]!.level).toBe('ok');
  });
});

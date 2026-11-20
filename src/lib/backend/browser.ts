/**
 * Browser fallback used by `npm run dev` without Tauri and by Playwright.
 * Profiles live in localStorage; the "connection" is a tiny scripted demo
 * controller. The real emulator (crates/virtual-grbl) and the streaming
 * engine only run in the desktop app — running jobs is refused here.
 */
import { expectedSettings } from '@/lib/grbl/profileSettings';
import { formatSettingValue } from '@/lib/grbl/settings';
import type { MachineProfile } from '@/lib/profile/schema';
import type { Backend, ConnectRequest, ControllerInfo, JobScan, LinkEvent, MachineStatus, PortInfo } from './types';

const PROFILES_KEY = 'cnc-sender.profiles';
const SETTINGS_KEY = 'cnc-sender.app-settings';
const DESKTOP_ONLY = 'Running jobs needs the desktop app — the browser preview has no streaming engine.';

function readJson<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked — nothing sensible to do in the preview */
  }
}

type Listener = (e: LinkEvent) => void;

class DemoLink {
  listeners = new Set<Listener>();
  timer: ReturnType<typeof setInterval> | null = null;
  jogTimer: ReturnType<typeof setInterval> | null = null;
  jogBeat = 0;
  pos = [0, 0, 0];
  wco = [0, 0, 0];
  state: 'idle' | 'jog' | 'alarm' = 'idle';
  connected = false;
  settings: Record<string, string> = {};

  emit(e: LinkEvent) {
    for (const l of this.listeners) l(e);
  }

  status(): MachineStatus {
    return {
      state: { name: this.state },
      mpos: [...this.pos],
      wpos: this.pos.map((p, i) => p - (this.wco[i] ?? 0)),
      wco: [...this.wco],
      feed: this.state === 'jog' ? 1000 : 0,
      spindle: 0,
      buffer: null,
      line: null,
      overrides: { feed: 100, rapid: 100, spindle: 100 },
      pins: { x: false, y: false, z: false, a: false, probe: false, door: false, hold: false, softReset: false, cycleStart: false, raw: '' },
      accessories: { spindleCw: false, spindleCcw: false, flood: false, mist: false, raw: '' },
    };
  }

  controller(): ControllerInfo {
    return {
      settings: { ...this.settings },
      offsets: { G54: [...this.wco], G55: [0, 0, 0], G56: [0, 0, 0], G57: [0, 0, 0], G58: [0, 0, 0], G59: [0, 0, 0], G28: [0, 0, 0], G30: [0, 0, 0], G92: [0, 0, 0], TLO: [0] },
      parserState: ['G0', 'G54', 'G17', 'G21', 'G90', 'G94', 'M5', 'M9', 'T0', 'F0', 'S0'],
      build: { version: '1.1h', buildDate: null, options: 'V,15,128', plannerBlocks: 15, rxBuffer: 128, grblhal: false },
      probe: null,
      rxBuffer: 128,
      charCounting: true,
    };
  }

  rx(line: string) {
    const ts = Date.now();
    const err = /^error:(\d+)$/.exec(line);
    if (line === 'ok') this.emit({ type: 'rx', line, parsed: { type: 'ok' }, ts });
    else if (err) this.emit({ type: 'rx', line, parsed: { type: 'error', code: Number(err[1]), text: err[1]! }, ts });
    else if (line.startsWith('Grbl')) {
      const info = { kind: 'grbl' as const, version: '1.1h', major: 1, minor: 1, legacy: false, warnings: [], banner: line };
      this.emit({ type: 'rx', line, parsed: { type: 'welcome', info }, ts });
      this.emit({ type: 'firmware', info });
    } else {
      const s = /^\$(\d+)=(.*)$/.exec(line);
      this.emit({ type: 'rx', line, parsed: s ? { type: 'setting', id: Number(s[1]), value: s[2]! } : { type: 'other', text: line }, ts });
    }
  }

  connect(req: ConnectRequest) {
    this.connected = true;
    this.state = 'idle';
    const profile: MachineProfile | null = req.target.kind === 'virtual' ? req.target.profile : null;
    this.settings = { '0': '10', '1': '25', '3': '0', '10': '1', '13': '0' };
    if (profile) for (const [id, v] of expectedSettings(profile)) this.settings[String(id)] = formatSettingValue(id, v);
    const desc = req.target.kind === 'virtual' ? 'Browser preview (simulated)' : req.target.path;
    this.emit({ type: 'state', state: 'connected', description: desc, message: null });
    setTimeout(() => {
      this.rx("Grbl 1.1h ['$' for help]");
      this.emit({ type: 'controller', info: this.controller() });
    }, 100);
    this.timer = setInterval(() => this.emit({ type: 'status', status: this.status(), ts: Date.now() }), 1000 / Math.max(1, req.pollHz));
  }

  disconnect() {
    this.connected = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.jogEnd();
    this.emit({ type: 'state', state: 'disconnected', description: null, message: null });
  }

  send(line: string) {
    if (!this.connected) throw new Error('not connected');
    this.emit({ type: 'tx', line, realtime: false, ts: Date.now() });
    const upper = line.toUpperCase().replace(/\s+/g, '');
    const reply: string[] = [];
    const jog = /^\$J=.*?G91(.*)$/.exec(upper);
    const set = /^\$(\d+)=([\d.]+)$/.exec(upper);
    const zero = /^G10L20P0(.*)$/.exec(upper);
    if (jog) {
      for (const [i, axis] of ['X', 'Y', 'Z'].entries()) {
        const m = new RegExp(`${axis}(-?[\\d.]+)`).exec(jog[1]!);
        if (m) this.pos[i] = (this.pos[i] ?? 0) + Number(m[1]);
      }
    } else if (upper === '$$') {
      for (const [k, v] of Object.entries(this.settings)) reply.push(`$${k}=${v}`);
    } else if (set) {
      this.settings[set[1]!] = formatSettingValue(Number(set[1]), Number(set[2]));
    } else if (zero) {
      for (const [i, axis] of ['X', 'Y', 'Z'].entries()) {
        const m = new RegExp(`${axis}(-?[\\d.]+)`).exec(zero[1]!);
        if (m) this.wco[i] = (this.pos[i] ?? 0) - Number(m[1]);
      }
    } else if (upper.includes('M6') || upper.includes('M7')) {
      reply.push('error:20');
    }
    setTimeout(() => {
      for (const r of reply) this.rx(r);
      if (!reply.some((r) => r.startsWith('error'))) this.rx('ok');
      this.emit({ type: 'controller', info: this.controller() });
    }, 20);
  }

  jogStart(dir: number[], feed: number) {
    this.jogEnd();
    this.state = 'jog';
    this.jogBeat = Date.now();
    const norm = Math.hypot(...dir) || 1;
    this.jogTimer = setInterval(() => {
      if (Date.now() - this.jogBeat > 350) return this.jogEnd();
      for (let i = 0; i < 3; i++) this.pos[i] = (this.pos[i] ?? 0) + ((dir[i] ?? 0) / norm) * (feed / 60) * 0.05;
    }, 50);
  }

  jogEnd() {
    if (this.jogTimer) clearInterval(this.jogTimer);
    this.jogTimer = null;
    if (this.state === 'jog') this.state = 'idle';
  }
}

const demo = new DemoLink();

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

/** Minimal scan so the job panel can show something in the preview. */
function quickScan(text: string): JobScan {
  const lines = text.split(/\r?\n/);
  const sendable = lines.filter((l) => l.replace(/\(.*?\)|;.*$/g, '').trim() !== '');
  const has = (re: RegExp) => sendable.some((l) => re.test(l.toUpperCase()));
  return {
    sourceLines: lines.length,
    lines: sendable.length,
    bytes: sendable.reduce((n, l) => n + l.length + 1, 0),
    issues: [],
    issuesTruncated: 0,
    features: {
      unitsMm: has(/G21/),
      unitsInch: has(/G20/),
      spindleCw: has(/M0?3(?!\d)/),
      spindleCcw: has(/M0?4(?!\d)/),
      maxS: 0,
      sChangesOnMoves: 0,
      toolChanges: [],
      tools: [],
      arcs: has(/G0?[23](?!\d)/),
      probe: has(/G38/),
      coolantMist: has(/M0?7(?!\d)/),
      coolantFlood: has(/M0?8(?!\d)/),
      zWords: 0,
      aWords: 0,
      wcsUsed: [],
      programEnd: has(/M(2|30)(?!\d)/),
      systemCommands: 0,
      dwellAfterSpindle: false,
    },
  };
}

export const browserBackend: Backend = {
  kind: 'browser',
  async listProfiles() {
    return readJson<unknown[]>(PROFILES_KEY, []);
  },
  async saveProfile(p: MachineProfile) {
    const all = readJson<MachineProfile[]>(PROFILES_KEY, []).filter((x) => x.id !== p.id);
    writeJson(PROFILES_KEY, [...all, p]);
  },
  async deleteProfile(id) {
    writeJson(
      PROFILES_KEY,
      readJson<MachineProfile[]>(PROFILES_KEY, []).filter((x) => x.id !== id),
    );
  },
  async loadAppSettings() {
    return readJson<unknown>(SETTINGS_KEY, null);
  },
  async saveAppSettings(s) {
    writeJson(SETTINGS_KEY, s);
  },
  async dataDir() {
    return 'browser localStorage';
  },
  async openTextFile({ filters }) {
    const accept = filters.flatMap((f) => f.extensions.map((e) => `.${e}`)).join(',');
    const file = await pickFile(accept);
    if (!file) return null;
    return { name: file.name, text: await file.text() };
  },
  async saveTextFile({ defaultName, text }) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  },
  async listPorts(): Promise<PortInfo[]> {
    return [];
  },
  async connect(req) {
    demo.connect(req);
  },
  async disconnect() {
    demo.disconnect();
  },
  async sendLine(line) {
    demo.send(line);
  },
  async sendRealtime(byte) {
    if (byte === 0x85) demo.jogEnd();
    if (byte !== 0x3f) demo.emit({ type: 'tx', line: `0x${byte.toString(16)}`, realtime: true, ts: Date.now() });
  },
  async snapshot() {
    return { state: demo.connected ? 'connected' : 'disconnected', description: null, firmware: null, status: null };
  },
  async injectFault() {
    throw new Error('Fault injection needs the desktop app (the browser preview has no emulator).');
  },
  async onLinkEvent(cb) {
    demo.listeners.add(cb);
    return () => demo.listeners.delete(cb);
  },
  async openJob() {
    const file = await pickFile('.nc,.gcode,.gc,.ngc,.tap,.cnc,.txt');
    if (!file) return null;
    const text = await file.text();
    return { job: { name: file.name, path: '', sizeBytes: file.size, scan: quickScan(text) }, text };
  },
  async loadJobPath() {
    throw new Error('Opening files by path needs the desktop app.');
  },
  async loadJobText(name, text) {
    return { name, path: '', sizeBytes: text.length, scan: quickScan(text) };
  },
  async jobStart() {
    throw new Error(DESKTOP_ONLY);
  },
  async jobPause() {
    throw new Error(DESKTOP_ONLY);
  },
  async jobResume() {
    throw new Error(DESKTOP_ONLY);
  },
  async jobStop() {
    throw new Error(DESKTOP_ONLY);
  },
  async jobUnload() {},
  async jogStart(dir, feed) {
    demo.jogStart(dir, feed);
  },
  async jogHeartbeat() {
    demo.jogBeat = Date.now();
  },
  async jogStop() {
    demo.jogEnd();
  },
  async controllerRefresh() {
    demo.emit({ type: 'controller', info: demo.controller() });
  },
};

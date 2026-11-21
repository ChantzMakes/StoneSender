/**
 * Browser fallback used by `npm run dev` without Tauri and by Playwright.
 * Profiles live in localStorage; the "connection" is a tiny scripted demo
 * controller. The real emulator (crates/virtual-grbl) and the streaming
 * engine only run in the desktop app — running jobs is refused here.
 */
import { expectedSettings } from "@/lib/grbl/profileSettings";
import { machineBounds } from "@/lib/profile/geometry";
import { formatSettingValue } from "@/lib/grbl/settings";
import type { MachineProfile } from "@/lib/profile/schema";
import { DemoMachine, type SolidBox } from "./demoMachine";
import type {
  Backend,
  ConnectRequest,
  ControllerInfo,
  JobScan,
  LinkEvent,
  MachineStatus,
  PortInfo,
} from "./types";

const PROFILES_KEY = "cnc-sender.profiles";
const SETTINGS_KEY = "cnc-sender.app-settings";
const DESKTOP_ONLY =
  "Running jobs needs the desktop app — the browser preview has no streaming engine.";

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
  m = new DemoMachine();
  jogging = false;
  connected = false;
  settings: Record<string, string> = {};
  /** Replies are delivered in order, one line at a time, like a real controller. */
  private chain: Promise<void> = Promise.resolve();

  emit(e: LinkEvent) {
    for (const l of this.listeners) l(e);
  }

  status(): MachineStatus {
    const m = this.m;
    return {
      state: { name: m.alarm ? "alarm" : this.jogging ? "jog" : "idle" },
      mpos: [...m.pos],
      wpos: m.workPos,
      wco: m.wco,
      feed: this.jogging ? 1000 : 0,
      spindle: 0,
      buffer: null,
      line: null,
      overrides: { feed: 100, rapid: 100, spindle: 100 },
      pins: {
        x: false,
        y: false,
        z: false,
        a: false,
        probe: m.probePin,
        door: false,
        hold: false,
        softReset: false,
        cycleStart: false,
        raw: m.probePin ? "P" : "",
      },
      accessories: {
        spindleCw: false,
        spindleCcw: false,
        flood: false,
        mist: false,
        raw: "",
      },
    };
  }

  controller(): ControllerInfo {
    const m = this.m;
    const names = ["G54", "G55", "G56", "G57", "G58", "G59"];
    return {
      settings: { ...this.settings },
      offsets: {
        ...Object.fromEntries(m.wcs.map((o, i) => [names[i]!, [...o]])),
        G28: [0, 0, 0],
        G30: [0, 0, 0],
        G92: [0, 0, 0],
        TLO: [0],
      },
      parserState: m.parserState(),
      build: {
        version: "1.1h",
        buildDate: null,
        options: "V,15,128",
        plannerBlocks: 15,
        rxBuffer: 128,
        grblhal: false,
      },
      probe: m.lastProbe
        ? { position: [...m.lastProbe.position], success: m.lastProbe.success }
        : null,
      rxBuffer: 128,
      charCounting: true,
    };
  }

  rx(line: string) {
    const ts = Date.now();
    const err = /^error:(\d+)$/.exec(line);
    const alarm = /^ALARM:(\d+)$/.exec(line);
    const prb = /^\[PRB:([-\d.,]+):([01])\]$/.exec(line);
    if (line === "ok")
      this.emit({ type: "rx", line, parsed: { type: "ok" }, ts });
    else if (err)
      this.emit({
        type: "rx",
        line,
        parsed: { type: "error", code: Number(err[1]), text: err[1]! },
        ts,
      });
    else if (alarm)
      this.emit({
        type: "rx",
        line,
        parsed: { type: "alarm", code: Number(alarm[1]), text: alarm[1]! },
        ts,
      });
    else if (line.startsWith("[GC:"))
      this.emit({
        type: "rx",
        line,
        parsed: { type: "parserState", words: line.slice(4, -1).split(" ") },
        ts,
      });
    else if (prb)
      this.emit({
        type: "rx",
        line,
        parsed: {
          type: "probe",
          position: prb[1]!.split(",").map(Number),
          success: prb[2] === "1",
        },
        ts,
      });
    else if (line.startsWith("Grbl")) {
      const info = {
        kind: "grbl" as const,
        version: "1.1h",
        major: 1,
        minor: 1,
        legacy: false,
        warnings: [],
        banner: line,
      };
      this.emit({ type: "rx", line, parsed: { type: "welcome", info }, ts });
      this.emit({ type: "firmware", info });
    } else {
      const s = /^\$(\d+)=(.*)$/.exec(line);
      this.emit({
        type: "rx",
        line,
        parsed: s
          ? { type: "setting", id: Number(s[1]), value: s[2]! }
          : { type: "other", text: line },
        ts,
      });
    }
  }

  connect(req: ConnectRequest) {
    this.connected = true;
    this.m = new DemoMachine();
    const profile: MachineProfile | null =
      req.target.kind === "virtual" ? req.target.profile : null;
    this.settings = { "0": "10", "1": "25", "3": "0", "10": "1", "13": "0" };
    if (profile) {
      for (const [id, v] of expectedSettings(profile))
        this.settings[String(id)] = formatSettingValue(id, v);
      this.m.solids = demoSolids(profile);
    }
    const desc =
      req.target.kind === "virtual"
        ? "Browser preview (simulated)"
        : req.target.path;
    this.emit({
      type: "state",
      state: "connected",
      description: desc,
      message: null,
    });
    setTimeout(() => {
      this.rx("Grbl 1.1h ['$' for help]");
      this.emit({ type: "controller", info: this.controller() });
    }, 100);
    this.timer = setInterval(
      () =>
        this.emit({ type: "status", status: this.status(), ts: Date.now() }),
      1000 / Math.max(1, req.pollHz),
    );
  }

  disconnect() {
    this.connected = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.jogEnd();
    this.emit({
      type: "state",
      state: "disconnected",
      description: null,
      message: null,
    });
  }

  send(line: string, id?: number) {
    if (!this.connected) throw new Error("not connected");
    this.emit({ type: "tx", line, realtime: false, ts: Date.now() });
    const upper = line.toUpperCase().replace(/\s+/g, "");
    const set = /^\$(\d+)=([\d.]+)$/.exec(upper);
    let reply: string[];
    if (upper === "$$")
      reply = [
        ...Object.entries(this.settings).map(([k, v]) => `$${k}=${v}`),
        "ok",
      ];
    else if (set) {
      this.settings[set[1]!] = formatSettingValue(
        Number(set[1]),
        Number(set[2]),
      );
      reply = ["ok"];
    } else reply = this.m.exec(line);
    this.chain = this.chain.then(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            try {
              for (const r of reply) this.rx(r);
              const last = reply.at(-1) ?? "ok";
              if (id !== undefined) {
                const err = /^error:(\d+)$/.exec(last);
                this.emit({
                  type: "commandAck",
                  id,
                  error: err ? Number(err[1]) : null,
                  message: null,
                  dropped: last.startsWith("ALARM"),
                });
              }
              this.emit({ type: "controller", info: this.controller() });
              this.emit({
                type: "status",
                status: this.status(),
                ts: Date.now(),
              });
            } catch (e) {
              console.error("demo controller reply failed", e);
            } finally {
              // never stall the replies that follow
              resolve();
            }
          }, 20),
        ),
    );
  }

  jogStart(dir: number[], feed: number) {
    this.jogEnd();
    this.jogging = true;
    this.jogBeat = Date.now();
    const norm = Math.hypot(...dir) || 1;
    this.jogTimer = setInterval(() => {
      if (Date.now() - this.jogBeat > 350) return this.jogEnd();
      for (let i = 0; i < 3; i++)
        this.m.pos[i] =
          (this.m.pos[i] ?? 0) + ((dir[i] ?? 0) / norm) * (feed / 60) * 0.05;
    }, 50);
  }

  jogEnd() {
    if (this.jogTimer) clearInterval(this.jogTimer);
    this.jogTimer = null;
    this.jogging = false;
  }
}

/**
 * Things the preview's probe can touch, placed from the profile: a block of
 * stock (top 40 % down the Z travel), an XYZ touch plate on its front-left
 * corner and the fixed tool setter.
 */
export function demoSolids(p: MachineProfile): SolidBox[] {
  const b = machineBounds(p);
  const top = b.max.z - (b.max.z - b.min.z) * 0.4;
  const x0 = b.min.x + (b.max.x - b.min.x) * 0.25;
  const y0 = b.min.y + (b.max.y - b.min.y) * 0.25;
  const plate = p.probe.plateThickness || 10;
  const solids: SolidBox[] = [
    { min: [x0, y0, b.min.z], max: [b.max.x, b.max.y, top] },
    // corner plate: 50 × 50 mm, its walls overhang the stock edges by the plate offsets
    {
      min: [x0 - p.probe.xyOffset.x, y0 - p.probe.xyOffset.y, top],
      max: [x0 + 50, y0 + 50, top + plate],
    },
  ];
  if (p.probe.toolSetter.enabled) {
    const s = p.probe.toolSetter.position;
    solids.push({
      min: [s.x - 5, s.y - 5, b.min.z],
      max: [s.x + 5, s.y + 5, Math.max(b.min.z + 1, s.z - 25)],
    });
  }
  return solids;
}

const demo = new DemoLink();

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

/** Minimal scan so the job panel can show something in the preview. */
/**
 * Rough stand-in for the Rust scan (the desktop app runs the real one). One
 * pass over the lines; features are matched on the whole text (comments
 * included), which is good enough for the preview and fast on huge files.
 */
function quickScan(text: string): JobScan {
  let sourceLines = 0;
  let sendable = 0;
  let bytes = 0;
  let pos = 0;
  while (pos < text.length) {
    let nl = text.indexOf("\n", pos);
    if (nl < 0) nl = text.length;
    sourceLines++;
    let l = text.slice(pos, nl);
    if (l.includes("(") || l.includes(";")) l = l.replace(/\(.*?\)|;.*$/g, "");
    const t = l.trim();
    if (t !== "") {
      sendable++;
      bytes += l.length + 1;
    }
    pos = nl + 1;
  }
  const has = (re: RegExp) => re.test(text);
  return {
    sourceLines,
    lines: sendable,
    bytes,
    issues: [],
    issuesTruncated: 0,
    features: {
      unitsMm: has(/G21/i),
      unitsInch: has(/G20/i),
      spindleCw: has(/M0?3(?!\d)/i),
      spindleCcw: has(/M0?4(?!\d)/i),
      maxS: 0,
      sChangesOnMoves: 0,
      toolChanges: [],
      tools: [],
      arcs: has(/G0?[23](?!\d)/i),
      probe: has(/G38/i),
      coolantMist: has(/M0?7(?!\d)/i),
      coolantFlood: has(/M0?8(?!\d)/i),
      zWords: 0,
      aWords: 0,
      wcsUsed: [],
      programEnd: has(/M(2|30)(?!\d)/i),
      systemCommands: 0,
      dwellAfterSpindle: false,
    },
  };
}

export const browserBackend: Backend = {
  kind: "browser",
  async listProfiles() {
    return readJson<unknown[]>(PROFILES_KEY, []);
  },
  async saveProfile(p: MachineProfile) {
    const all = readJson<MachineProfile[]>(PROFILES_KEY, []).filter(
      (x) => x.id !== p.id,
    );
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
    return "browser localStorage";
  },
  async openTextFile({ filters }) {
    const accept = filters
      .flatMap((f) => f.extensions.map((e) => `.${e}`))
      .join(",");
    const file = await pickFile(accept);
    if (!file) return null;
    return { name: file.name, text: await file.text() };
  },
  async saveTextFile({ defaultName, text }) {
    const url = URL.createObjectURL(
      new Blob([text], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = defaultName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  },
  async saveBinaryFile({ defaultName, bytes, mime }) {
    const url = URL.createObjectURL(
      new Blob([bytes as BlobPart], { type: mime }),
    );
    const a = document.createElement("a");
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
  async sendTracked(line, id) {
    demo.send(line, id);
  },
  async sendRealtime(byte) {
    if (byte === 0x85) demo.jogEnd();
    if (byte === 0x18) demo.m.alarm = null;
    if (byte !== 0x3f)
      demo.emit({
        type: "tx",
        line: `0x${byte.toString(16)}`,
        realtime: true,
        ts: Date.now(),
      });
  },
  async snapshot() {
    return {
      state: demo.connected ? "connected" : "disconnected",
      description: null,
      firmware: null,
      status: null,
    };
  },
  async injectFault() {
    throw new Error(
      "Fault injection needs the desktop app (the browser preview has no emulator).",
    );
  },
  async onLinkEvent(cb) {
    demo.listeners.add(cb);
    return () => demo.listeners.delete(cb);
  },
  async openJob() {
    const file = await pickFile(".nc,.gcode,.gc,.ngc,.tap,.cnc,.txt");
    if (!file) return null;
    const text = await file.text();
    return {
      job: {
        name: file.name,
        path: "",
        sizeBytes: file.size,
        scan: quickScan(text),
      },
      text,
    };
  },
  async loadJobPath() {
    throw new Error("Opening files by path needs the desktop app.");
  },
  async loadJobText(name, text) {
    return { name, path: "", sizeBytes: text.length, scan: quickScan(text) };
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
  async jobToolChangeDone() {
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
    demo.emit({ type: "controller", info: demo.controller() });
  },
  simulateProbeTouch(on) {
    demo.m.pinForced = on;
    demo.emit({ type: "status", status: demo.status(), ts: Date.now() });
  },
};

# AGENTS.md — working notes for future sessions

G-code sender, visualizer and machine simulator for GRBL (Tauri 2 + React/TS + Rust).
The spec is delivered in phases; **stop after each phase for the owner's confirmation.**

| Phase | Scope | Status |
|---|---|---|
| 1 | Scaffold, module interfaces, Machine Profiles (schema/storage/presets/wizard/import-export), virtual GRBL, serial layer, console, DRO, connect/disconnect | **done** |
| 2 | Character-counting streamer, real-time commands UI, jogging, homing, WCS, overrides, firmware detection, error/alarm tables, `$$` editor + profile diff/sync | **done** |
| 3 | Full G-code interpreter, planner/time estimator, job stats, Monaco editor, drag-and-drop / recent files / job history, travel check in pre-flight | **done** |
| 4 | 3D toolpath viewer, live tool tracking, scrubber/playback | next |
| 5–8 | See the spec (machine sim, material removal, advanced, polish/distribution) | — |

## Commands

Windows note: tools were installed with winget; in a fresh PowerShell the PATH may need
`$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`.

| What | Command |
|---|---|
| Install JS deps | `npm install` |
| Desktop app (dev) | `npm run app` (= `tauri dev`; starts Vite on :1420) |
| Browser-only UI preview | `npm run dev` → http://localhost:1420 (browser backend, no Rust) |
| Typecheck | `npm run typecheck` |
| TS unit tests | `npm test` (Vitest) |
| E2E tests | `npm run test:e2e` (Playwright, browser backend; first time: `npx playwright install chromium`) |
| Rust tests | `cargo test --workspace` |
| Rust lint | `cargo clippy --workspace --all-targets -- -D warnings` |
| Production build | `npm run tauri build` |
| Regenerate icons | `npm run icons` (from `app-icon.svg`) |
| Stress G-code | `node scripts/gen-stress.mjs 5000000` |
| Emulator timing fixtures | `node scripts/gen-timing-fixtures.mjs` (re-run after changing the emulator motion model or the samples) |

All of the above pass as of the end of Phase 3 (Rust: 78 tests incl. 19 link/streaming integration tests against
the emulator; Vitest: 81 incl. 9 planner-vs-emulator timing checks; Playwright: 15; clippy clean with `-D warnings`).

## Layout

```
crates/
  grbl-core/     profile serde mirror + validation + profile→$$ mapping; GRBL line parser;
                 status parser + WCO-caching tracker; firmware + $I build info; transport traits;
                 gcode_prep.rs (strip comments, scan for unsupported words before a job)
  virtual-grbl/  GRBL 1.1 emulator (deterministic core `machine.rs` + threaded port wrapper)
  grbl-link/     serial transport, `sender.rs` (pure streaming engine: char counting /
                 send-response, job state machine, jog chunk generator — heavily unit tested),
                 `link.rs` (threads, ack routing, job stop sequence, controller info, reconnect).
                 tests/virtual_link.rs + tests/streaming.rs run against the emulator.
src-tauri/       thin Tauri shell: IPC commands, profile storage (app-data dir), event bridge
presets/         built-in profile presets (JSON) — loaded by BOTH TS and Rust tests
src/
  core/interfaces.ts   module boundary types (incl. future phases)
  lib/profile/         schema (Zod, source of truth), presets, migrate, units, geometry,
                       fields (editor metadata), share (import/export/review)
  lib/backend/         IPC contract types + Tauri impl + browser fallback impl
  lib/grbl/            error/alarm tables, $$ metadata, profile↔$$ diff/sync, override bytes,
                       command builders (zero, go-to, park, WCS — modal-units aware)
  lib/job/preflight.ts pre-flight checks (spec §8)
  lib/gcode/           G-code engine: interpreter.ts (modal interpreter, GRBL error codes, arcs,
                       offsets, checkpoints for start-from-line), toolpath.ts (columnar typed-array
                       storage), planner.ts (GRBL planner model → time), stats.ts, analyze.ts,
                       worker.ts + client.ts (Web Worker), docs.ts (G/M hover docs),
                       __fixtures__/emulator-times.json (from scripts/gen-timing-fixtures.mjs)
  store/               Zustand: app settings, profiles, link (+controller, job), console, ui
  features/            wizard, profiles, connection, dro, console, workarea, safety, layout,
                       jog, control (machine buttons, overrides), wcs, job (panel, stats, history,
                       drop), settings ($ editor), editor (Monaco, lazy-loaded)
  store/analysis.ts    re-runs the worker analysis when job text / profile / motion settings change
  components/ui/       shadcn-style primitives on Radix
e2e/             Playwright specs
samples/         G-code samples + shareable sample profiles
docs/USER_GUIDE.md
```

## Architecture rules

- **Nothing machine-specific is hardcoded.** Read it from the active `MachineProfile`.
- **Units:** everything stored in mm, mm/min, mm/s² (A axis: degrees). `profile.units` is display-only;
  convert with `lib/profile/units.ts`.
- **Profile schema:** `src/lib/profile/schema.ts` (Zod) is the source of truth. `crates/grbl-core/src/profile.rs`
  mirrors it (serde, `deny_unknown_fields`). Every preset in `presets/` is parsed by both sides in tests —
  that is the parity check. Changing the shape = bump `SCHEMA_VERSION`, add a migration in `migrate.ts`,
  update Rust, presets and `fields.ts` (a test fails if a schema leaf has no field metadata).
- **Migration happens in the frontend** on load/import; the Rust backend only accepts the current version
  on save (and validates ranges). Storage returns raw JSON so old files can be migrated.
- **Timing-critical logic lives in Rust** (link layer, future streamer). The UI only sends intents.
- **IPC contract:** `src/lib/backend/types.ts` mirrors serde output of `grbl_link::LinkEvent` etc.
  `grbl-link` has a test (`event_json_matches_frontend_contract`) that pins the JSON shape.
- Browser fallback (`lib/backend/browser.ts`) exists so the UI runs in plain Vite and Playwright.
  It is a stub: localStorage profiles and a scripted demo controller.

## Safety decisions (owner may want to review)

1. **Automatic sends:** without a click the app only sends `?` status polls and, after the controller's welcome
   banner (or 2.5 s without one), the read-only queries `$I`, `$$`, `$G`, `$#`. No soft reset on connect.
2. **Queue flushing:** queued and in-flight lines are discarded and a running job is aborted on soft reset, any
   `ALARM`, a welcome banner (controller reset) and connection loss. **Nothing is ever re-sent after a
   reconnect.** A soft reset is written *and* the engine flushed under the engine lock, so no queued line can
   reach the controller after the reset byte (a race found by a test in Phase 2).
3. **STOP button** = `!` immediately, then `Ctrl-X` once status shows Hold:0/Idle/Alarm, or after 800 ms at
   the latest. With a job running this goes through the Rust job engine (`stop_job`), otherwise through the
   UI; pressing STOP again while stopping resets immediately. Rationale: reset after the hold completes
   preserves position; the timeout bounds how long the spindle can keep running if status reports stop.
4. **STOP shortcut** is `Esc`, active only while the machine is moving (Run/Jog/Home/Hold) so Esc still
   closes dialogs when idle. Customisable shortcuts are Phase 8.
5. Switching the active profile is **disabled while connected**; deleting the connected profile is disabled.
6. Imported profiles are always shown in a review dialog with warnings; import never touches the controller.
7. Wizard: choosing machine type "laser" turns laser mode on; router/rotary turn it off.
8. Console lines containing `?`, `!`, `~` or bytes ≥ 0x80 are rejected — GRBL would execute them as real-time
   commands mid-line (e.g. a `?` inside a comment).
9. Steps/mm are read-only in the profile editor (mirror of `$100–$103`); change them in the `$$` editor or
   copy them from the controller in its Compare tab.
10. **Streaming:** character counting uses RX buffer − 1 bytes (GRBL keeps one ring slot empty), taken from
    `$I` `[OPT:]` when reported, else the profile. `$` commands other than `$J=` are always sent alone
    (EEPROM writes block interrupts). Job lines are comment/whitespace-stripped before sending.
11. **Job errors:** an `error:N` on a job line pauses the job and sends a feed hold. The user chooses Continue
    (skip that line, `~`) or Stop. In check mode errors are collected and the run continues.
12. **Jobs are refused** unless the machine is Idle, nothing is queued, no jog is active, and the word scan
    found no lines the firmware rejects. Interactive commands are refused while a job runs; while paused only
    `$$ $# $G $I $N` are allowed. Jogging is refused during jobs and unless Idle/Jog.
13. **M6 tool changes** are blocked at pre-flight (unless the profile says "ignore M6") until guided tool
    changes land in Phase 7 — running past an M6 on GRBL 1.1 would error, and silently skipping it would cut
    with the wrong tool.
14. **Continuous jog** streams ~0.1 s `$J=` chunks (≥ stopping distance / 2), at most 3 unacknowledged.
    On release, or if UI heartbeats stop for 350 ms, no new chunks are made; once every sent chunk is
    acknowledged (in the planner, not the RX buffer) a jog-cancel (0x85) is sent, so no stale chunk can run
    after the cancel. Window blur / tab hide also stops jogging.
15. **Pre-flight** (`lib/job/preflight.ts`) blocks on: not idle, rejected lines, M6 (see 13), controller in
    laser mode with a router profile. Warns on: missing units, no spindle/laser on, S above max, laser-looking
    job on a router (and vice versa), work zero equal to machine zero, probing moves. Run mode needs an
    explicit "I have checked…" tick. Bounds/collision checks are listed as "not yet checked" until Phase 3–5.
16. **Settings writes** (`$$` editor, Profile → controller, backup restore) always show a list where every
    change must be ticked individually; unticked rows are skipped. Controller → profile also confirms.
17. Zero/go-to/park commands read G20/G21 from `$G` and send values in the current modal units; they never
    change modal units. Go-to and park only ever *raise* Z (to `safety.safeZMachine`) before moving XY;
    "To Z0" asks first.
18. **Phase 3 pre-flight additions:** blocks while the analysis is still running; blocks a *run* (not a
    check) when the interpreter finds lines the controller will reject; **blocks when the job leaves the
    machine travel from the current work zero if homing is enabled**, warns instead when homing is disabled
    (machine coordinates are then only relative to power-on). Reports cut size, deepest cut and feeds above
    the machine maximum.
19. Loading another file (open, drop, recent, edited text) is refused while a job is active; the editor is
    read-only during a job.

## G-code engine conventions (Phase 3)

- The interpreter is the TS reference for GRBL semantics; it mirrors `gcode.c` validation and arc maths
  (`mc_arc`). Errors carry GRBL error codes. A rejected line changes nothing (state and segments roll back).
- **Analysis runs with zero work offsets**, so the toolpath's "machine" coordinates are relative to the work
  zero. Pre-flight adds the live WCO from the status report to check against the envelope; jobs that use G53,
  G28/G30, G10, G92, G43.1 or switch WCS get an "approximate" note.
- **Toolpath storage** is columnar typed arrays (`toolpath.ts`); an arc is one segment plus a centre/angle
  record (renderers and the planner tessellate). Positions are Float32.
- **Planner model** = GRBL's: per-axis rate/accel limits along the move, junction deviation, `mc_arc` chords,
  look-ahead limited to the planner size (15 GRBL / 35 grblHAL / `$I` OPT), full stop at spindle and coolant
  changes (not S in laser mode), dwells, probes and M0. Cross-checked against the Rust emulator on all
  samples: 0.1–2.7 % apart (test threshold 4 %).
- Remaining time during a job = planned total − planned time at the last acknowledged line.
- The Rust `gcode_prep` scan (firmware-aware: M6/M7/line length) and the TS interpreter (semantics: missing
  feed, arc geometry…) both feed the editor markers and pre-flight.

## Profile / GRBL conventions

- Machine bounds follow GRBL 1.1 `limits_go_home`: `negative-space` (stock) → every axis spans
  `[-travel, 0]`; `positive-space` (HOMING_FORCE_SET_ORIGIN builds) → axes homing toward min span
  `[0, travel]`, others `[-travel, 0]`.
- `$23` (homing dir invert mask) is derived from the home corner **assuming `$3` does not invert axes**
  (+X right, +Y back, +Z up). In the Phase 2 diff treat `$23` as advisory when `$3 ≠ 0`.
- `$30` maps to `laser.maxPower` for laser profiles, otherwise `spindle.maxRpm`. `$32` is on for laser
  profiles and for router+laser when `laser.laserMode` is set.
- Presets are *typical* values gathered from community `$$` dumps, not vendor-official. Each preset's notes say
  so; the `$$` diff on connect (Phase 2) is the real check. The stock Onefinity controller is not GRBL — the
  Onefinity preset is for GRBL/grblHAL retrofits.

## Virtual GRBL fidelity notes

Modelled: welcome banner per flavour (1.1h / 0.9j / grblHAL 1.1f), 128-byte RX buffer with overflow counting
(1024 for grblHAL), 15-block planner (35 grblHAL) with GRBL-style junction deviation + backward-pass entry
speeds and trapezoidal motion, `ok` delayed while the planner is full, sync semantics for M3/M5/M8/G4/G38,
feed hold (Hold:1 → Hold:0), cycle start, soft reset (ALARM:3 if moving, position kept if held), jog + jog
cancel, soft limits (error:15 for jogs, critical ALARM:2 for G-code), homing (`$H`, $23 mask, pull-off; final
position per GRBL formula), probe G38.2–.5 against configurable boxes (ALARM:4/5, `[PRB:]`), check mode, all
override bytes, status report counters for WCO/Ov/A like GRBL, `$$ $# $G $I $N $X $H $C $SLP $RST`, settings
writes with GRBL's validation errors, startup blocks, G10 L2/L20, G28/G30(.1), G92/G92.1, G43.1/G49, G53,
arcs (IJK and R, all planes, arc tolerance segmentation), G20/G21, G90/G91, G93. GRBL 1.1 rejects M6 and M7
(error:20) like stock firmware; grblHAL accepts them. GRBL 0.9 flavour uses its comma status format and
text errors. Faults: disconnect, alarm, error-on-next-line, drop next ok, stall, forced probe pin.

Not modelled (yet): hard-limit switches (only via fault injection), safety door, real homing switch search
(homing moves straight to the computed home), probe overshoot, laser-mode motion behaviour beyond not syncing
spindle changes, parking, G-code line numbers in `Ln:`, EEPROM write delays, serial baud timing.
Known simplification: after a probe-fail alarm (ALARM:5) the emulator still sends `[PRB:…:0]` and `ok` —
matches my reading of GRBL 1.1 source; verify against hardware.

## Known gaps after Phase 3

- Performance: a 1M-line file analyses in ~2.8 s in the worker (≈14 s for 5M). The file text is held three
  times (Rust job source, TS store, worker) and Monaco is skipped above 25 MB; the 5M-line pass is Phase 8.
- Analysis assumes the tool starts at the work zero (the first rapid's length is approximate).
- G93 arcs use the chord length for the feed conversion (minor timing error).
- Pre-flight cannot check plunges below the stock or rapids through it until the simulator (Phase 5).
- Spin-up dwell after M3 is advised, not inserted (job rewriting comes with start-from-line / tool changes in
  Phase 7).
- "Use edited version" re-scans and re-analyses but keeps no undo history across loads.
- Monaco has only been seen in the browser preview; the desktop window (CSP: worker-src blob/self,
  style-src unsafe-inline) is launch-tested but not clicked through.
- Jog panel: XYZ only (no A axis jog, no diagonals); gamepad is Phase 7. Saved positions (G28/G30 buttons)
  were left out — G28's intermediate-point semantics make a safe one-click version non-trivial.
- grblHAL extras beyond buffer size / M6 / M7 detection (e.g. its extended settings metadata) are not
  surfaced; unknown `$` settings show with a generic description.
- The `$$` metadata covers GRBL 1.1 settings; 0.9's `$$` works but its different meanings for $10/$13 are not
  explained.
- The desktop window itself is only smoke-tested (launches); UI flows are covered by Playwright against the
  browser backend, and the Rust link/streamer by integration tests against the emulator.
- No ESLint config yet (TS strict + `noUnused*` only).
- App name "CNC Sender" and identifier `dev.cncsender.app` are placeholders.
- npm 11 blocks dependency install scripts by default; esbuild's postinstall is skipped and things still work.

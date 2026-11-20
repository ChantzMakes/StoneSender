# AGENTS.md — working notes for future sessions

G-code sender, visualizer and machine simulator for GRBL (Tauri 2 + React/TS + Rust).
The spec is delivered in phases; **stop after each phase for the owner's confirmation.**

| Phase | Scope | Status |
|---|---|---|
| 1 | Scaffold, module interfaces, Machine Profiles (schema/storage/presets/wizard/import-export), virtual GRBL, serial layer, console, DRO, connect/disconnect | **done** |
| 2 | Character-counting streamer, real-time commands UI, jogging, homing, WCS, overrides, firmware detection, error/alarm tables, `$$` editor + profile diff/sync | **done** |
| 3 | Full G-code interpreter, planner/time estimator, job stats, Monaco editor, drag-and-drop / recent files / job history, travel check in pre-flight | **done** |
| 4 | 3D toolpath viewer, live tool tracking, scrubber/playback, camera views, rulers, measuring | **done** |
| 5 | Parametric machine model (router/laser/combo/rotary, gantry/table kinematics), accel-aware playback, travel/below-stock/rapid-through-stock checks in the view and pre-flight | **done** |
| 6 | Material removal: stock, tool library, heightmap removal, laser burn, rotary sim, STL/PNG export | **done** |
| 7a | Start-from-line, guided tool changes, probing wizards, height-map auto-leveling | **done** (awaiting review) |
| 7b | Laser framing, macros (with sharing), generators + G-code transforms, gamepad | next |
| 8 | Polish / distribution | — |

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

All of the above pass as of the end of Phase 7a (Rust: 85 tests incl. 19 link/streaming and 5 Phase 7 integration
tests against the emulator; Vitest: 130 incl. 9 planner-vs-emulator timing checks, removal/export, recovery,
probing routines and leveling; Playwright: 29, run with 4 workers because headless Chromium renders WebGL in
software — long flows use `test.slow()`; clippy clean with `-D warnings`).

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
  lib/sim/             setup.ts (stock setup, stock box by origin mode, assumed work offset when
                       offline), checks.ts (travel / below-stock / rapid-through-stock collision checks),
                       tools.ts (tool library schema, shapes, T-number resolution), removal.ts (material-
                       removal engine), sim.worker.ts + client.ts (worker, keyframes, patches),
                       export.ts (binary STL + dependency-free PNG encoder)
  lib/gcode/           G-code engine: interpreter.ts (modal interpreter, GRBL error codes, arcs,
                       offsets, checkpoints for start-from-line), toolpath.ts (columnar typed-array
                       storage), planner.ts (GRBL planner model → time), stats.ts, analyze.ts,
                       render.ts (3D line buffers, playback sampling, snapping, ruler steps),
                       worker.ts + client.ts (Web Worker), docs.ts (G/M hover docs),
                       __fixtures__/emulator-times.json (from scripts/gen-timing-fixtures.mjs)
  store/               Zustand: app settings, profiles, link (+controller, job), console, ui
  features/            wizard, profiles, connection, dro, console, workarea, safety, layout,
                       jog, control (machine buttons, overrides), wcs, job (panel, stats, history,
                       drop), settings ($$ editor), editor (Monaco, lazy-loaded),
                       viewer (three.js / react-three-fiber, lazy-loaded: Scene.tsx, Viewer3D.tsx,
                       MachineModel.tsx parametric machine, RemovalView.tsx removal meshes, RemovalPanel.tsx,
                       StockDialog.tsx, ToolLibraryDialog.tsx, useSimSetup.ts)
  store/sim.ts         playback time/speed, colour mode, view toggles, camera requests, measuring
  store/analysis.ts    re-runs the worker analysis when job text / profile / motion settings change
  store/removal.ts     removal sim state; grid buffers at module level; useRemovalSync (inputs + playback)
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
13. **M6 tool changes** (Phase 7a): M6 is never sent (removed in `gcode_prep`). A run stops *before* the M6
    line once every earlier line is acknowledged (phase `tool-change`), the UI guides the change, then
    `tool_change_done` continues with the rest of that line. "Ignore M6" skips them (`ToolChangeMode::Skip`).
    Pre-flight blocks only "tool setter" without a configured setter.
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
20. **Probing (owner decision):** every probing move requires a **touch test** first — the user touches the
    plate to the bit (or presses the tool setter) and the app must see the probe pin (`Pn:P`) on and then
    off. The test is required again before each run. G38.2 is used (alarm if nothing is touched within
    the profile's max distance); fast touch, back off, slow touch; the machine returns to the exact trigger
    point before `G10 L20` is written, so overshoot never enters the result. After a touch the routine backs
    off before probing another direction (otherwise GRBL raises ALARM:4).
21. **Tool length after a change (owner decision): adjust work Z** with `G10 L20` (persists across resets),
    not G43.1. Touch plate: Z0 = plate surface − thickness on the surface Z was zeroed on. Tool setter:
    measure the old bit before the change and the new bit after; work Z is set so the setter contact has
    the same work Z for both bits.
22. **Tool-change sequence:** M5, M9, raise to `safety.safeZMachine`, go to `toolChange.position` (machine),
    `G4 P0` (waits for motion); user confirms the new bit is fitted; optional re-measure; then raise to safe
    Z, restore coolant and spindle **as the job had them after the M6 line** (interpreter state) with the
    profile's spin-up dwell, `G4 P0`, continue. Jogging is allowed during the tool change; settings writes
    are not.
23. **Start from line:** recovery lines (`lib/job/recovery.ts`) are sent **one at a time** before the job; a
    rejected one fails the start and nothing after it is sent. Order: G21 G90 plane feed-mode, WCS, safe Z
    (machine), T, coolant, spindle + spin-up (routers), rapid XY(A), routers: rapid to start Z + clearance
    then feed down at the job's last plunge feed (capped at Z max rate); lasers: no plunge, laser state
    restored after positioning; finally the job's units / distance mode / feed / G0-G1. **Blocked** when the
    skipped part uses G92, G10, G43.1, G28.1, G30.1 or probing, or the start line continues a modal arc.
24. **Routines restore modes:** probing and tool-change routines switch to G21 for their own numbers and
    restore the controller's G20/G21 and G90/G91 (read with `$G`) at the end — decision 17 still holds for
    the user's modal state. After an alarm the restore is skipped (a reset restores defaults).
25. **Auto-leveling** rewrites the loaded file as `<name>-leveled.nc` (the original stays on disk): Z of every
    move + bilinear surface height; moves split to ≤ half the grid spacing; G17 arcs become lines. Refused for
    G91 moves, arcs in G18/G19 and G92. Z0 must be set on the surface before probing the map.

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

## 3D viewer conventions (Phase 4)

- Scene is **Z-up** (`THREE.Object3D.DEFAULT_UP`), units mm, origin = work zero (same as the analysis).
- The whole toolpath is **one `LineSegments` draw call** with a custom shader. Per-vertex attributes: display
  kind, feed, S, planned time. Colour mode, rapids on/off and "completed vs remaining" are **uniforms**, so
  scrubbing/live progress never rebuilds geometry. Buffers are built in the worker (`render.ts`) and
  transferred.
- Arcs are tessellated for display at 0.02 mm chord error (max 128 pieces). Above 2M line segments, tiny
  consecutive segments are merged for display (LOD) — the info overlay says so.
- `frameloop="demand"`: frames render on camera moves, store changes, or while playing/live. Per-frame values
  (time, tool positions) are read from stores in `useFrame`, not via React state.
- Live job: the "done" threshold is the planned time at the last acknowledged line; the red marker is the live
  `WPos`. Preview: the scrubber time, with a blue ghost marker sampled from the toolpath (`sampleAt`).
- The envelope box is drawn only when connected (it needs the live WCO to place the machine travel around
  the work zero). Laser profiles default to colouring by power; travel moves with S0 are drawn as rapids.
- The viewer and the editor unmount when their tab is hidden; state that must survive lives in stores, and
  "reset on new job/profile" uses module-level "last seen" keys (a remount once wiped the playback position).
- Editor ↔ viewer: the scrubbed line is highlighted in the editor; moving the cursor in the editor seeks the
  playback to that line (`features/viewer/seek.ts`, kept free of three.js so the editor chunk stays small).

## Machine simulation conventions (Phase 5)

- The machine model is generated entirely from the profile: travel (machineBounds), frame size (auto or
  `geometry.frame.size`), gantry style, machine type, laser focus height, rotary mode/diameter, tool setup.
  Proportions (rail width, spindle size…) scale with the envelope.
- **Placement:** scene frame = work coordinates; a machine point m is drawn at m − wco. When connected wco is
  the live WCO; offline it is `assumedWco` (stock lying on the bed near the front-left of the travel) and the
  view says so.
- **Kinematics:** moving gantry → gantry group follows Y, X carriage follows X, Z group follows Z. Moving
  table → gantry fixed at mid-travel and `TableGroup` (bed, stock, toolpath, markers, travel box, measuring)
  slides in Y so the tool stays under the spindle. Rotary (A ∥ X, through work Y0 Z0 — Z0 on the stock
  centreline): chuck/jaws/stock rotate with A, or with Y/yMmPerRevolution in Y-substitution mode.
- **Tool pose** (`currentToolPose`): playback position when previewing, else the live WPos, else parked at
  the clearance height. With the machine shown, the red live cone appears only while previewing.
- **Playback follows the planner's speed profile:** the planner records entry/exit/cruise speed and
  acceleration per toolpath segment (`toolpath.motion`); `sampleAt` maps time → distance along the
  trapezoid (`pathFraction`), scaled to the segment's planned duration.
- **Checks** (`lib/sim/checks.ts`) sample arcs every 10°. Rapids through stock use a slab test against the
  stock box widened by the tool radius and lowered 0.05 mm from the top; **straight-up retracts are exempt**
  (they leave through their own slot — without material removal we can't tell cut from uncut). Lasers skip
  stock checks; rotary skips them until the cylindrical sim. All three are **warnings** in pre-flight (the
  travel check keeps its Phase 3 block-when-homing-enabled rule and now names the first offending line).

## Material removal conventions (Phase 6)

- **Engine** (`lib/sim/removal.ts`): one grid per job. Router = Z heightmap over the stock (cell = top of the
  remaining material); laser = accumulated energy (S/Smax × dwell, s/mm), drawn as 1 − exp(−40·e);
  rotary = remaining radius over X × angle (A ∥ X, axis through work Y0 Z0). Tools are stamped at ≤ half a
  cell along each move (arcs via `pointOnSegment`). Grid ≤ 1M cells (resolution coarsened to fit);
  automatic resolution targets 0.6M cells (router/rotary) / 1M (laser), clamped 0.1–1 mm (laser ≤ 0.5).
  **Laser grids cover only the burned area** (job cut bounds + 1 mm, clipped to the stock) so raster
  spacing resolves; the rest of the sheet is a plain box.
- **Time-driven:** `advanceTo(t)` applies everything up to planned time t, including part of a move
  (acceleration-aware via the planner's motion profile). The worker runs the whole job once on `init`
  (problems, islands, stats, up to 40 keyframes within a 160 MB budget), then answers `advance(t)` with
  the changed rectangle only; going backwards restores the nearest keyframe. The client is latest-wins
  (no queue of stale scrubs); the store throttles to ~60 ms and follows the live job's acknowledged line.
- **Rendering:** geometry is built once per grid; patches update only the dirty rows of the vertex
  buffers (`addUpdateRange`). The subscription is keyed on the geometry object (an HMR remount once left a
  fresh geometry never filled). The plain stock box / rotary stock cylinder hide while removal is shown.
- **Problems:** rapid that removes material (gouge; the very first rapid is skipped — its start is the
  assumed work zero, which on a rotary is the axis), cut below the stock bottom, flute (material in a ring
  just outside the cutter rises more than the flute length above the tip), holder (material within the
  holder radius above tip + stick-out), islands (4-connected uncut components not touching the grid edge,
  ≤ 4 × the largest cutter area, found at the end of the job). Max 200 events, one per kind per line.
  In pre-flight they are **warnings** (islands: info); the removal gouge check replaces the Phase 5
  rapid-through-stock warning when the simulation has run, since it knows what is already cut.
- **Tools:** library in app settings (`settings.tools`, Zod `ToolSchema`), default 7 tools. A job's T n
  uses: explicit assignment (Stock & tools dialog, per session) → library tool numbered n → default tool →
  first tool (`resolveTool`). The Phase 5 `ToolSetup` (diameter/stick-out for checks and the machine
  model) is now derived from the library tool for the job's first T (`useSimTool`); the separate bit
  fields were removed.
- **Exports:** STL = closed solid (heightfield top + walls + bottom, or rotary surface + end caps), binary,
  mm, work coordinates; PNG = 8-bit RGB with stored deflate blocks (no compression dependency).
  Desktop saves through the Tauri command `binary_file_write` (raw IPC body, percent-encoded path header,
  `.stl`/`.png` only, atomic write); the browser backend downloads a blob.
- drei `<Html>` labels use `zIndexRange={[20, 0]}` and viewer overlays `z-30`, so dialogs (z-40) cover them.
- With the machine model hidden, moving-table machines no longer slide the job in Y.

## Phase 7a conventions

- **Tracked commands:** `Link::send_tracked(line, id)` → `LinkEvent::CommandAck { id, error, message, dropped }`;
  dropped on reset / alarm / disconnect (flush). TS: `lib/machine/commander.ts` (`sendAndWait`,
  `probeAndWait` — reads the `[PRB:]` rx line that arrives before the `ok`; `readParserState`), wired from
  the link store. Alarms and disconnects reject everything pending.
- **Routines** (`lib/machine/routines.ts`) are plain async functions over `MachineIO`; `liveIO` adapts the
  real link, unit tests use `DemoMachine`. Corner probing starts with the bit over the plate's top within
  ~10 mm of its corner and moves off by "clearance + bit radius"; outside-centre probing needs an
  approximate width and drop depth.
- **Browser preview controller** = `lib/backend/demoMachine.ts` (instant moves, G0/G1/G38.x, G10 L2/L20,
  G53, G54–59, G20/21, G90/91, `$G`, `$X`, probe pin, alarms) with solids placed from the profile: stock top
  40 % down the Z travel from 25 % into X/Y, a corner plate on its front-left corner, the tool setter. It
  models the bit as a point. "Simulate the touch" in the touch test exists only in the preview.
- Job engine: recovery prelude lines are `Origin::JobControl`, sent send-response; `JobProgress` has
  `toolChange` and `preludeLines`. `job_start(mode, options { fromLine, prelude, toolChange })`.

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

## Known gaps after Phase 7a

- The guided tool change and start-from-line run only in the desktop app (the browser preview has no
  streaming engine); their engine behaviour is covered by Rust integration tests against the emulator,
  the UI flow for tool changes is not covered by e2e tests.
- The browser preview's quick scan doesn't detect M6, so the pre-flight tool-change line only appears in
  the desktop app.
- Probing results in the preview come from a point-probe model; real bits touch with their edge (the
  corner routine accounts for the radius). Outside-centre and tool-setter flows were only unit-tested.
- Start from line skips nothing inside a line (it starts at a whole line) and can't start in the middle of
  a modal arc; jobs using G91 get a warning, not a block.
- Height map: one Z touch per point at the slow feed after a fast find; no interpolation outside the
  probed area (edge values are used); the map is kept for the session only (no save/load yet).
- Tool-setter reference from the Probe dialog is kept for the session only; it's invalid once work Z is
  changed some other way.

## Known gaps after Phase 6

- Heightmap model: no undercuts (fine for 3-axis routers), resolution-limited (details < 1–2 cells are
  approximate), and side walls are vertical between cell centres. Lasers have no kerf/char model beyond
  energy darkening; laser spot fixed at 0.2 mm.
- Rotary: the cylinder model assumes the tool points straight down at the axis; removal events aren't
  drawn as markers on the rotating stock (they are listed); islands are not searched on rotary.
- Stock setup and tool assignments are per session (not saved with the job); the library itself persists.
- Holder check treats the holder as a cylinder of the collet-nut diameter; spindle body / gantry vs
  clamps are not checked. Flute/holder checks fire only when the tool is moving into material.
- Removal sim runs only while the 3D view has been opened (the sync hook lives in the viewer); pre-flight
  shows its results when available.
- Large jobs: the init pass runs the whole job (a 1M-line file takes seconds); keyframe memory is capped at
  160 MB. Performance pass is Phase 8.
- PNG export is uncompressed (stored deflate): a 1M-cell burn map is ~3 MB.

## Known gaps after Phase 5

- Stock/tool setup is per session (resets to the profile defaults on profile change) and not yet saved with
  the job; the tool library is Phase 6.
- Rotary jobs are still drawn flat (the toolpath isn't wrapped onto the cylinder) and skip stock checks;
  the rotary model assumes A ∥ X.
- Rapid-through-stock can't distinguish already-cut material (Phase 6 material removal); retracts are exempt,
  which can hide a rapid that plunges straight down and back up.
- No collision checks for the machine body (gantry/spindle vs stock or clamps), and no tool-holder clearance
  (Phase 6).
- The machine is a schematic made of boxes and cylinders, not a CAD model of each brand.

## Known gaps after Phase 4

- Viewer: no machine model yet (Phase 5); rotary jobs are drawn flat (A ignored) until the rotary simulator;
  WebGL lines are 1 px (no thick lines); rulers are labels along the job edges, not a full ruler overlay; the
  measuring tool picks on the work Z=0 plane and snaps to segment endpoints within 3 mm.
- Playback interpolates linearly in time within each segment (the planner's acceleration profile isn't
  replayed inside a segment); overall timing matches the estimate.
- A 1M-line job: ~3.2 s analysis + 0.3 s render buffers, 2M vertices / ~64 MB GPU memory. Tested visually
  with small jobs; large-job frame rate depends on the GPU (Phase 8 perf pass).

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

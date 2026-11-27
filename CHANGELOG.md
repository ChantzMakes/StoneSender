# Changelog

What changed in each StoneSender release. The section for a version is also shown in the app when it
offers that update (Preferences → About & updates).

## [0.1.1] - 2026-11-27

### Added

- **Status window.** A new button in the top bar opens a separate window with just the machine state
  and the job: a big progress bar, time left, time elapsed and the line number, plus the position. Put
  it on a second screen or across the shop; the pin button keeps it on top of other windows. It only
  shows information — stop the machine from the main window (or your hardware E-stop). It warns and
  greys out if it stops getting updates, and closes with the main window.
- **Custom jog distance.** Type any distance in the new **Custom** box under the jog step buttons (for
  example 37.5); each click of an arrow then moves exactly that far.

### Changed

- **New look.** Calm dark workshop theme with a spindle-orange accent (light and high-contrast themes
  updated to match), new logo and app icon, and clearer type: Inter for text, JetBrains Mono for
  numbers and G-code. The fonts are built into the app, so it looks the same on every computer.
- Position readout: larger numbers in their own wells, axis letters in their own colours, and the
  machine state shown as a dot plus a word (Idle, Running, Hold, Alarm).
- 3D view: finished parts of the path and the live tool marker are now orange; rapid moves are grey.
- The on-screen stop button now reads **Stop**. It is still a software stop, not an E-stop.
- A jog step longer than that axis's travel is no longer sent (the console says why) — for the step
  buttons, the custom distance and the gamepad.

### Fixed

- A **Check** (dry run) that finished cleanly could be reported as "Job aborted … the controller
  reset". The check now completes as soon as the controller confirms the end of check mode.

## [0.1.0] - 2026-11-25

First release: machine profiles and setup wizard, connection to GRBL / grblHAL controllers (and a
built-in virtual machine), job streaming with pause / resume / stop and pre-flight checks, jogging,
homing, zeroing and work offsets, overrides, a `$$` settings editor, G-code editor, 3D toolpath view
with a model of your machine and material-removal simulation, start from a line, guided tool changes,
probing and auto-leveling, laser framing, macros, generators and transforms, gamepad jogging, themes,
layouts and shortcuts, in-app help, and automatic updates.

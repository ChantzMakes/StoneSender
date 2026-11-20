# CNC Sender — User Guide

This guide is for people who want to *use* the app with their machine. No programming needed.

> **Beta.** You can set up machines, connect, jog, zero, run and check jobs. The 3D preview and accurate time
> estimates are coming. Try new files on air (bit raised) or scrap first.

## ⚠️ Safety first

- The app never moves your machine unless you click something.
- The red **STOP** button (or **Esc** while the machine is moving) pauses and resets the controller.
  It is **not** an emergency stop. Keep a hardware E-stop or power switch within reach.
- If the USB cable is unplugged or the connection drops, the app stops sending and shows a red banner. The
  controller has probably reset: check the machine, then home it (or set zero again) before continuing.

## 1. Installing

Installers for Windows, macOS and Linux will be provided in a later update. Until then, someone with a
development setup has to build it (see the README).

## 2. The setup wizard

The first time you open the app, the wizard asks about your machine. It takes about two minutes.

1. **Starting point** — pick your machine if it's listed (3018, Shapeoko, X-Carve, LongMill, Onefinity) or a
   generic one. Presets are only a starting point.
2. **Machine type** — router, laser, router + laser, or a 4-axis rotary. This changes what the app shows you.
3. **Work area** — how far the tool can travel in X, Y and Z (not the outside size of the machine). You can
   also choose millimetres or inches here.
4. **Homing** — if your machine has limit switches, turn on homing and **click the corner your machine goes
   to when it homes**, as seen standing in front of it.
5. **Controller** — usually leave everything as it is (115200 baud, auto-detect).
6. **Spindle / laser** — speed range of your spindle, or the maximum power value of your laser.
7. **Probe & tool changes** — optional. Tell it about your touch plate if you have one.
8. **Review & save** — give the profile a name. Any warnings are shown here.

Nothing is sent to your machine during the wizard.

You can create more profiles later (one per machine) from the profile menu in the top-left corner, and edit
any setting under **Manage profiles…**. Every setting has a short explanation underneath it.

## 3. Connecting

1. Plug in the machine and turn it on.
2. In the top bar, pick its port (USB ports that look like GRBL boards are marked ★). Click ↻ if it doesn't
   show up.
3. Click **Connect**. The console at the bottom shows the controller's startup message, and the position
   display on the left starts updating.

**No machine handy?** Choose **Virtual machine (simulated)**. It behaves like a real GRBL controller built
from your profile — handy for learning the app. You can even pretend to be an old GRBL 0.9 board to see the
warning the app gives.

If the app says your controller runs **GRBL 0.9**, many features won't work. Flashing GRBL 1.1 is
recommended (search for instructions for your board).

If the app shows a yellow bar saying **controller settings differ from your profile**, click *Review
differences*. For each row decide which side is right: copy the controller's values into the profile, or
write the profile's values to the controller (you tick every change before anything is written).

If the controller is **locked (ALARM)**, a red bar explains why and offers *Home* or *Unlock*. Only unlock
if you know where the machine is.

## 4. Moving the machine and setting zero

- **Jog panel** (right side): click an arrow to move one step (pick the step size underneath); **press and
  hold** to move continuously until you let go. The keyboard works too: arrow keys for X/Y, Page Up / Page
  Down for Z.
- **Home** finds the limit switches (if your machine has them).
- **Set work zero:** jog the bit to the corner/top of your stock, then click **X0**, **Y0**, **Z0** or **All**.
- **To XY0** lifts the bit to a safe height and goes back to your work zero. **Park** moves out of the way.
- **Work offsets…** shows and edits G54–G59 if you use more than one zero.
- **Overrides** change feed and spindle (or laser power) speed live while a job runs.

## 5. Running a job

1. Click **Open G-code file…** in the Job panel (or drop a file on the window, or pick one under
   *Recent*). The app checks every line and shows the **estimated time**, the size of the cut, the deepest
   cut and the feeds used. The **G-code** tab (next to *Work area*) shows the file with problems
   underlined — hover any code to see what it does. You can edit there and click *Use edited version*.
2. Click **Check** for a dry run: the controller reads the whole file without moving and reports any line
   it would reject.
3. Click **Run**. A pre-flight list appears (red items must be fixed first) — including whether the job
   fits inside your machine's travel from where you set zero. Tick "I have checked…" and start. The time
   left shown while running comes from the same estimate.
4. **Pause** / **Resume** whenever you like. If the controller rejects a line mid-job, the machine pauses and
   the app shows the line and what's wrong: *Continue* skips it, *Stop* ends the job.
5. **Stop** (or the red STOP) slows the machine to a halt, then resets the controller so the position is
   kept.

The **3D view** tab shows the toolpath: orange = rapid moves, blue = cutting, green = arcs, pink =
plunges. Drag to rotate, right-drag to pan, scroll to zoom; the buttons top-right switch to Top / Front /
Side / 3D views, fit the job, follow the tool, hide rapids, or colour by feed, depth or power. Press ▶ under
the view to play the job (up to 100× speed) or drag the slider; the matching line is highlighted in the
G-code tab, and clicking a line there jumps the playback to it. The ruler button measures between two
points. While a job runs, finished parts of the path turn grey and the red marker shows where the machine
really is.

The 3D view also shows a model of **your machine**, built from your profile — it moves along with the
playback (or with the real machine while connected). Set your **stock size and where your zero is on it**
with the settings icon (*Stock & tools*); the view then warns, in a box at the top right, if the job leaves the
machine's travel, cuts below the bottom of the stock, or makes rapid moves through it. The same warnings
appear in the pre-flight list. The green dot marks the home position; the travel box turns orange when soft
limits are on.

### Material simulation

The 3D view cuts the stock away as the job plays (layers icon to switch it off). Routers show the
remaining material, lasers show how dark each spot burns (more power or a slower feed = darker), rotary
jobs show the round stock turning with A. Drag the slider back and forth to watch it; the flag icon jumps
to the **finished result**. The panel at the top left lists anything the simulation found:

- **Rapid move cuts material** (red) — a G0 move goes through stock that hasn't been cut yet.
- **Cuts below the stock** (pink).
- **Collet / holder hits the material** — the cut is deeper than the bit sticks out of the collet.
- **Cut deeper than the flute length** — the smooth shank would rub on the walls.
- **Small island left** (yellow) — a sliver of material left inside a pocket, often a stepover that is too big.

These also appear in the pre-flight list. **Export STL** (routers, rotary) saves the simulated part as a
3D mesh; **Export PNG** (lasers) saves the burn preview as an image.

Open the settings icon (**Stock & tools**) to set the stock size, which tool each T number in the job
uses, and the simulation resolution. **Tool library…** lets you add your own bits: shape (flat, ball,
V-bit, engraving bit with a flat tip, drill), diameter, flute length, stick-out from the collet and collet
nut diameter — the last three drive the holder and flute checks. A job's T1 uses the library tool numbered
1 unless you pick another. The simulation is a guide, not a guarantee: it uses a grid (0.1–1 mm), so very
small details are approximate.

The clock icon in the Job panel shows the history of jobs you've run.

**Tool changes (M6):** the job stops before each tool change, after everything before it has finished.
A yellow panel in the Job section walks you through it: the spindle stops and the machine moves to your
tool-change position, you swap the bit, and — depending on your profile — the app re-measures it with
the touch plate or the fixed tool setter so Z zero stays right. *Continue the job* raises Z, restarts the
spindle (with its spin-up pause) and carries on. You can jog during the change. Set *Ignore M6* in the
profile if you never change bits mid-job.

**Start from a line:** *Start from a line…* in the Job panel restarts a job part-way, e.g. after you
stopped it. It suggests the line where the last run stopped. *Show how* lists exactly what is sent first:
raise to the safe height, spindle on and wait, move over the start point, feed down to it, then the job's
own settings. Some files can't be restarted part-way (if the skipped part sets offsets or probes) — the
app says why. Make sure the right bit is in the spindle.

### Probing

*Probe…* (Machine panel) opens the probing wizards. Each one shows a little animation of what will happen.
**Before every probe you must touch the plate to the bit** (or press the tool setter): the app checks it
sees the touch, so an unplugged clip can't drive the bit into the plate. Keep a hand near STOP the first
time.

- **Z plate** — plate on the stock, bit a few mm above it: sets Z zero on the stock.
- **XYZ corner** — corner plate on the front-left corner, bit over the plate's top near its corner: sets
  X, Y and Z zero at the corner. Enter your bit diameter.
- **Centre** — inside a hole or around a round/square boss: sets X0 Y0 in the middle and shows the size.
- **Tool setter** — measure the bit before you change it by hand, then the new one: Z zero moves by the
  length difference.
- **Surface map** — for uneven stock or PCBs. Set Z zero on the surface, probe a grid over the job, then
  *Apply to the loaded job*: a copy named `…-leveled.nc` follows the surface. Check it in the 3D view.

## 6. Controller settings ($$)

**Settings** (top bar) shows every controller setting with an explanation. Change values, then *Write* — you
confirm each change. *Back up* saves all settings to a file; *Restore* loads one and shows what would change
before writing. Do a backup before experimenting.

## 7. The console

Type GRBL commands at the bottom, for example `$$` to list the controller's settings or `$X` to clear an
alarm. Use ↑/↓ to repeat earlier commands. The switches above the console hide status chatter and "ok"
replies. Error and alarm numbers are explained in plain words.

## 8. Sharing profiles

1. Open **Manage profiles…** from the profile menu.
2. Select a profile and click **Export**. You get a `.cncprofile.json` file — send it to a friend.
3. Your friend clicks **Import from file…** and picks the file. The app shows everything in the profile and
   any warnings **before** adding it. Importing never changes the controller's settings.

Even with a shared profile, every machine is a little different: always check the work area, home corner and
spindle settings match **your** machine.

## 9. Where things are saved

Profiles and settings are stored on your computer:

- Windows: `%APPDATA%\dev.cncsender.app`
- macOS: `~/Library/Application Support/dev.cncsender.app`
- Linux: `~/.local/share/dev.cncsender.app`

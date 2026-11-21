# Releasing StoneSender

Installers for Windows, macOS and Linux are built by GitHub Actions
(`.github/workflows/release.yml`) when you push a version tag. They land in a **draft** release on
<https://github.com/ChantzMakes/StoneSender/releases>; nothing reaches users until you publish it.
Installed copies of StoneSender check `releases/latest/download/latest.json` (latest *published*
release) and offer the update in the app.

## One-time setup

### 1. The update-signing key (required)

Every update is signed; the app refuses downloads whose signature doesn't match the public key built
into it. **Keep the private key safe and backed up — if it is lost, existing installs can never
auto-update again** (users would have to reinstall by hand).

```powershell
npx tauri signer generate -w "$HOME\.tauri\stonesender.key"
```

It asks for a password (recommended). Then:

1. Paste the contents of `stonesender.key.pub` into `src-tauri/tauri.conf.json` →
   `plugins.updater.pubkey` (replacing `UPDATER-PUBLIC-KEY-NOT-SET…`) and commit.
2. In GitHub: **Settings → Secrets and variables → Actions → New repository secret**:
   - `TAURI_SIGNING_PRIVATE_KEY` — the contents of `stonesender.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — its password (skip if none)

The release workflow stops with a clear error if either is missing.

### 2. Code-signing certificates (optional, recommended)

Without them the installers work but the operating system warns users:

| Platform | Without a certificate | With one |
|---|---|---|
| Windows | SmartScreen: "Windows protected your PC" → *More info → Run anyway* | No warning once the certificate has reputation (EV certificates immediately) |
| macOS | Ad-hoc signed: first open needs right-click → *Open* (or System Settings → Privacy & Security → *Open anyway*) | Opens normally (Developer ID + notarization) |
| Linux | No signing needed | — |

**Windows** — buy an OV/EV code-signing certificate (or use Azure Trusted Signing; needs a
`signCommand` instead). Export it as a `.pfx` and add secrets:
`WINDOWS_CERTIFICATE` (the .pfx as base64: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx"))`)
and `WINDOWS_CERTIFICATE_PASSWORD`. Note: many CAs now ship certificates on hardware tokens only; those
can't be exported and need a cloud signing service instead.

**macOS** — needs an Apple Developer account ($99/year). Create a *Developer ID Application*
certificate, export it as `.p12`, and add: `APPLE_CERTIFICATE` (base64 of the .p12),
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` (e.g. `Developer ID Application: Your Name (TEAMID)`),
`APPLE_ID`, `APPLE_PASSWORD` (an app-specific password) and `APPLE_TEAM_ID`.

The workflow uses each set only when its secrets exist.

## Each release

1. Make sure CI is green on `main`.
2. Bump the version (package.json is the only source; the app and installers read it):
   ```powershell
   npm version 0.2.0 --no-git-tag-version
   ```
   Also bump `version` in the root `Cargo.toml` (`[workspace.package]`) to keep them in step, commit.
3. Tag and push:
   ```powershell
   git tag v0.2.0
   git push origin main v0.2.0
   ```
   The workflow refuses a tag that doesn't match package.json.
4. Wait for the three builds (~20–30 min). Open the draft release, write the notes (they are shown
   in the app's update dialog — Markdown lists, **bold** and `code` work), try an installer.
5. **Publish** the draft. From then on installed copies offer the update.

To pull a bad release: mark it as a pre-release or delete it; `latest` then points at the previous
release again. Users who already updated must install the older version by hand.

## What gets built

| Platform | Files | Auto-update |
|---|---|---|
| Windows x64 | `_x64-setup.exe` (NSIS, per-user, no admin needed), `.msi` | yes (via the NSIS installer) |
| macOS (universal: Intel + Apple silicon) | `.dmg`, `.app.tar.gz` | yes |
| Linux x64 | `.AppImage`, `.deb`, `.rpm` | AppImage only; `.deb`/`.rpm` users update through the new package |

## Test a release build locally (Windows)

```powershell
npm run tauri build                    # installers in target\release\bundle, no updater files
```

`src-tauri/tauri.release.conf.json` (used by CI) adds the signed updater files; to try it locally set
`TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD` first and add `--config src-tauri/tauri.release.conf.json`.

## Renaming

The product name `StoneSender` and identifier `com.chantzmakes.stonesender` are baked into installed
copies: changing the identifier makes a new app (separate data folder, no auto-update from the old
one). Don't change it after the first public release.

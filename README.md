# Contractor's Stambha

Construction project management for contractors, as a native desktop app: BOQ,
daily site reports, attendance, payroll, billing, job costing, WIP and a
double-entry ledger — with Bikram Sambat dates, PAN/VAT documents and
Nepali-numbering amounts built in.

Built with React + TypeScript and packaged with Tauri 2, so one codebase
produces native installers for **macOS, Windows and Linux**.

## Features on every platform

| Feature | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Accounts, sign-in, recovery key | yes | yes | yes |
| Permanent storage (local data + live mirror on disk) | yes | yes | yes |
| Backups to Documents (or a chosen folder) and auto-backup | yes | yes | yes |
| Restore from a backup folder or a `.zip` | yes | yes | yes |
| File Vault (real files on disk: open, reveal, export, restore) | yes | yes | yes |
| Print and print to PDF | yes | yes | yes |
| Native menu (File, Edit, Window, Help) with Cmd/Ctrl shortcuts | yes | yes | yes |
| Desktop and in-app icon | yes | yes | yes |

App data lives under each OS's own folders:
`~/Library/Application Support/com.contractoros.app` (macOS),
`%APPDATA%\\com.contractoros.app` (Windows),
`~/.local/share/com.contractoros.app` (Linux).

The bundle identifier is unchanged from earlier builds on purpose: it is what
finds your existing books on disk, so renaming the app never opens an empty
database. Backups default to `Documents/Stambha`; a `Documents/ContractorOS`
folder from an earlier build is adopted automatically the first time the app
runs, and every old backup, mirror and vault copy still restores.

## Run it locally

Requirements: Node 20+, Rust (stable), and on Linux the Tauri build libraries:
`libwebkit2gtk-4.1-dev`, `build-essential`, `curl`, `wget`, `file`,
`libxdo-dev`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`
and `patchelf` (installed with your system's package manager).

Then:

```bash
npm ci
npm run app:dev     # desktop app with hot reload
npm test            # unit tests
npm run typecheck
```

## Build an installer

```bash
npm run app:build
```

Tauri writes the installers to `src-tauri/target/<target>/release/bundle/`:

- **macOS**: `dmg/Stambha_1.0.0_universal.dmg` and `macos/Stambha.app`
- **Windows**: `msi/Stambha_1.0.0_x64_en-US.msi` and `nsis/Stambha_1.0.0_x64-setup.exe`
- **Linux**: `deb/`, `rpm/` and `appimage/Stambha_1.0.0_amd64.AppImage`

A cross-platform installer cannot be built from one machine: macOS needs macOS,
Windows needs Windows and Linux needs Linux. That is what the workflow below is
for.

## Build all three from GitHub

`.github/workflows/build.yml` builds macOS (universal), Windows (x64) and Linux
(x64) on GitHub's runners whenever you push to `main`, open a pull request, or
run the workflow by hand (Actions, then *Build desktop installers*, then
*Run workflow*). Each job attaches its installers to the run under **Artifacts**.

## Installing unsigned builds

The installers are not code-signed yet, so the OS will warn once:

- **macOS**: right-click the app, choose **Open**, then *Open* (or allow it in
  System Settings, Privacy and Security).
- **Windows**: SmartScreen, **More info**, **Run anyway**.
- **Linux**: make the `.AppImage` executable (`chmod +x`) before running it.

Signing and notarisation can be added later with your own Apple Developer ID and
a Windows code-signing certificate; nothing in the code needs to change.

## Supported Bikram Sambat range

B.S. **1975/01/01 – 2100/12/30** (A.D. **1918-04-13 – 2044-04-12**). That is the
widest verified calendar table that exists: month lengths are gazetted by the
Nepal Panchanga Nirnayak Samiti only a year or two ahead, so no converter can
correctly answer for 2050 (B.S. 2107). Dates outside the range are refused with
a message rather than converted wrongly, and **B.S. 2087 and later is marked
provisional** in period labels because those years may still be corrected.

## Licensing

Contractor's Stambha is proprietary software: see `LICENSE`. Third-party components keep
their own licences and are listed, with the required Apache-2.0 attribution, in
`THIRD-PARTY-NOTICES.md`. The same notices are bundled inside every installer
and can be opened from **Help → Third-party licences**.

## Project layout

```
src/                 React app (pages, services, components)
src-tauri/src/       Rust shell: menus, printing, backups, file vault
src-tauri/icons/     Generated app icons (.icns, .ico, PNGs)
.github/workflows/   Cross-platform installer build
```

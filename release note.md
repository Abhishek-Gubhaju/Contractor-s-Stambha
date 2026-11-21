# Release notes — Contractor's Stambha 1.0.0

**Release date:** 21 November 2026
**Identifier:** `com.contractoros.app`
**Platforms:** macOS 11+ (universal), Windows 10/11 (x64), Linux (x64)

Contractor's Stambha is a desktop app for construction businesses: BOQ, daily
site reports, worker attendance, payroll, billing, job costing, WIP and a
double-entry ledger — all offline, all on your own machine.

---

## Highlights in 1.0.0

### Runs on macOS, Windows and Linux

The desktop shell, native menus, printing and file dialogs now have real
implementations on all three platforms. Backups, printing and folder reveal
behave the same everywhere; nothing is macOS-only.

### Renamed to Contractor's Stambha

The product is now **Contractor's Stambha** (short mark **Stambha**), with
`Stambha` as the on-disk backup folder. Existing data keeps working:

- Backups written by earlier builds (in `Documents/Sthamba` or
  `Documents/ContractorOS`) are adopted automatically on first launch.
- Manifests written by earlier builds are still read and re-rooted.
- Storage keys and the local database are unchanged, so no data is orphaned.

### Bikram Sambat range extended to A.D. 2044

| | From | To |
| --- | --- | --- |
| B.S. | 1975/01/01 | 2100/12/30 |
| A.D. | 1918-04-13 | 2044-04-12 |

That is the widest verified calendar table available — ten years further than
the previous release. Month lengths in Bikram Sambat are gazetted by the Nepal
Panchanga Nirnayak Samiti only a year or two ahead, so **dates beyond A.D. 2044
are refused with a clear message rather than converted incorrectly**. A wrong
day on a tax invoice is worse than an honest refusal.

- **B.S. 2087 and later is labelled “provisional”** in period and date labels,
  because those years may still be corrected when the official panchang is
  published.
- Dates outside the supported range no longer blank a page or abort an export;
  they show as unavailable or with an explanatory message.

### One-day calendar error fixed

The previous calendar table recorded B.S. 2062 Baisakh as 30 days. It has
**31 days** (14 May 2005 = 2062/01/31), per the official Nepali patro. Dates in
that 62-day window were reported one day early; they are now correct.

### Licensing

- The app remains proprietary; third-party components are used only under
  permissive licences (MIT / ISC / Apache-2.0). No GPL or AGPL code is bundled.
- `LICENSE` and `THIRD-PARTY-NOTICES.txt` now ship **inside the installer** and
  can be opened from **Help → Third-party licences**, as the MIT and Apache-2.0
  attribution clauses require.
- The Bikram Sambat tables come from `@inicrea/bikram-sambat-core` (MIT,
  © 2026 Inicrea Technologies), generated from the Yorion Engine
  (MIT OR Apache-2.0, © 2024 bs_calendar_core contributors). Both attributions
  are reproduced in the notices.

### Personal data removed

Example names, addresses, sample companies, letterhead details and contact
numbers shipped by earlier builds have been replaced with neutral placeholders.

---

## Installing

The builds are **not code-signed yet**, so each OS warns once:

- **macOS** — right-click the app, choose **Open**, then *Open* (or allow it in
  System Settings → Privacy and Security).
- **Windows** — SmartScreen: **More info**, then **Run anyway**.
- **Linux** — make the `.AppImage` executable (`chmod +x`) before running it.

Signing and notarisation can be added later with an Apple Developer ID and a
Windows code-signing certificate; no code changes are required.

## Artifacts

| Platform | Files |
| --- | --- |
| macOS | `Contractor's Stambha.app`, `Contractor's Stambha_1.0.0_universal.dmg` |
| Windows | NSIS `.exe` and `.msi` installers |
| Linux | `.AppImage`, `.deb` and `.rpm` |

Installer filenames contain an apostrophe; quote the path in scripts.

## Known limitations

- Windows and Linux installers are produced by CI on their native runners; only
  the macOS build has been produced and inspected on a developer machine.
- The Windows installer's behaviour with an apostrophe in the product name has
  not been verified on a Windows machine. If it causes trouble, the fallback is
  to ship as `Stambha`.
- A.D. dates after 2044-04-12 are intentionally unsupported (see above).
- B.S. years from 2087 are provisional.
- Builds are unsigned, so first launch shows the OS warning described above.

## Verification for this release

- 669 frontend tests across 72 files, 19 Rust tests — all passing.
- Typecheck clean; `npm audit` reports 0 vulnerabilities.
- macOS app and DMG built and their bundled licence resources inspected.
- Full calendar comparison against the previous engine over 33,238 days; the
  only differences were the B.S. 2062 errata corrected above.

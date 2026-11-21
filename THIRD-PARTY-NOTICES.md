# Third-party notices

Contractor's Stambha is proprietary software (see `LICENSE`). It includes the third-party
components below, each used under its own licence. Nothing here grants rights
to the application's own code.

## Runtime and bundled libraries

| Component | Version | Licence | Used for |
| --- | --- | --- | --- |
| Tauri (`tauri`, `tauri-build`, `tauri-plugin-dialog`) | 2.x | MIT OR Apache-2.0 | Desktop shell, native file dialogs, printing, filesystem access |
| `@tauri-apps/api` | 2.x | MIT OR Apache-2.0 | JavaScript bridge to the desktop shell |
| React, React DOM | 18.x | MIT | User interface |
| lucide-react | 0.294.x | ISC | Icons |
| JSZip | 3.10.x | MIT (dual MIT / GPL-3.0-or-later, used under MIT) | Backup `.zip` archives |
| SheetJS Community Edition (`xlsx`) | 0.20.3 | Apache-2.0 | Excel import and export |
| `@inicrea/bikram-sambat-core` | 0.1.3 | MIT | Bikram Sambat (B.S.) calendar tables and conversion, B.S. 1975–2100 |
| serde, serde_json | 1.x | MIT OR Apache-2.0 | Rust data serialisation |

No GPL-licensed code is bundled: the B.S. calendar library is MIT, so the
application stays proprietary. The calendar table is consumed as a package and
never copied into this repository.

## Bikram Sambat calendar attribution

The B.S. calendar tables in `@inicrea/bikram-sambat-core` are generated from the
Yorion Engine, and both are used under the MIT licence:

- `@inicrea/bikram-sambat-core` — Copyright (c) 2026 Inicrea Technologies
- Yorion Engine (<https://github.com/Yorion-io/yorion_engine>) —
  Copyright (c) 2024 bs_calendar_core contributors

Both MIT licence texts are reproduced in full in `THIRD-PARTY-NOTICES.txt`, which
ships inside every installer (**Help → Third-party licences**). That file — not
this Markdown one — is what satisfies the "include this notice in all copies"
clause for the libraries the installer carries.

## Apache-2.0 attribution

This product includes software developed by the SheetJS project
(<https://sheetjs.com>), licensed under the Apache License, Version 2.0.
A copy of that licence is available at
<https://www.apache.org/licenses/LICENSE-2.0>. Tauri's Apache-2.0 components
carry the same attribution requirement.

## Development-only tools (not redistributed)

Vite, TypeScript, Tailwind CSS, Vitest, Testing Library, jsdom and the Tauri CLI
are build and test tools. They are not included in the installers.

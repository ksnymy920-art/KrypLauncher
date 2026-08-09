# OmniLauncher — Open-Source Minecraft Launcher (Electron)

A solo-developer, open-source alternative Minecraft launcher built with **Electron + Express**, using a lightweight HTML/CSS interface instead of a heavier UI framework like React.

## Features

- **Accounts**: Microsoft sign-in via the standard device-code OAuth flow, plus offline (cracked) accounts and **ely.by** sign-in for players without an original Microsoft account.
- **Loaders**: Forge, Fabric, **NeoForge**, and **Quilt** loader support with automatic Java detection/download.
- **Mods tab**:
  - Search mods from **Modrinth** and **CurseForge** separately or combined ("All sources" merges both and deduplicates cross-platform duplicates, preferring the Modrinth copy).
  - Search by **any Minecraft version** ("All versions") even before installing a version, with automatic version-compatibility filtering when one is selected.
  - Install mods, **resource packs**, **shaders**, and **maps** directly into the game folder.
  - Automatic dependency installation and missing-mod repair.
  - **Modpack import** from CurseForge and Modrinth (`.zip` and `.mrpack`), including mods, shaders, resource packs, and worlds — each with its icon (remote metadata or a local preview extracted from the pack, e.g. `preview.png`/`pack.png`).
  - Independent show/hide toggles for "Modpack add-ons" vs "Manually installed" content, and section-aware empty-state messages.
- **Skins**: thousands of skins from The Skindex, with official Microsoft upload, local install via CustomSkinLoader, and one-click **ely.by** upload.
- **Data tab**: screenshot viewer and full per-instance **backups** (create, restore, delete).
- **Java**: multiple Java version management.
- **Auto-updater**: checks and pulls new releases from GitHub.
- **Shared data dir**: since v1.0.3 all data lives in a single folder (Electron `userData`, else `%APPDATA%\OmniLauncher`), with automatic migration of the legacy portable `data` folder.

## Download

Grab the latest portable build from the [Releases](https://github.com/ksnymy920-art/OmniLauncher/releases) page — download `OmniLauncher.exe` and run it. No install needed.

## Building

```bash
npm install
npm run build:app     # produces portable OmniLauncher.exe in dist/
```

## Notes

- Source is browsable directly in this repository.
- Virus-total report for reference: https://www.virustotal.com/gui/file/55473f9ce7351e23662f386b78e2a2e11a72e5a289667163c7194084a390e2cb

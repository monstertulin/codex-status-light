# Status Light Shell

This package contains the native desktop shell for Codex Status Light.

- `macOS`: menu bar app
- `Windows`: system tray app
- `Tauri 2`: native shell, tray integration, and detail panel

The shell reads local Codex runtime data directly and maps it to the tray light plus the detail panel UI.

## Package layout

- `web/`: panel UI shown by the desktop shell
- `src-tauri/`: native tray app, polling loop, packaging config
- `scripts/`: local helpers for preview and debug scenarios

## Runtime inputs

The shell expects local Codex data under the current user's `.codex` directory:

- `~/.codex/log/codex-tui.log`
- `~/.codex/logs_2.sqlite`
- `~/.codex/state_5.sqlite`

On Windows the same files are read from `%USERPROFILE%\\.codex\\...`.

If none of those files exist yet, the shell stays neutral. It will not pretend the machine is green and healthy without evidence.

## Local development

Install dependencies:

```bash
npm install
```

Preview the browser dashboard:

```bash
npm run serve
```

Run the native shell:

```bash
npm run tauri:dev
```

The native shell reads Codex signals directly and also writes a debug snapshot to `~/.codex/status-light/current-status.json` unless `CODEX_STATUS_LIGHT_SNAPSHOT` is set.

## Debug scenarios

Use a forced scenario when you want to inspect a lamp state without waiting for real Codex activity:

```bash
npm run debug -- approval
```

Useful scenarios:

- `green`
- `thinking`
- `tools`
- `replying`
- `approval`
- `retry`
- `error`
- `stalled`
- `auth`
- `rate-limit`
- `neutral`

## Lamp semantics

- `Green`: Codex is idle or has fully settled after the last turn
- `Yellow`: Codex is actively working
- `Yellow flashing`: Codex is waiting for approval
- `Red error`: Codex failed, was interrupted, or needs explicit attention
- `Red stalled`: Codex started work but fresh output stopped for too long
- `Neutral`: local runtime data is missing or not yet usable

## Build installers

Build a macOS app bundle and DMG on macOS:

```bash
npm run build:mac
```

Build Windows installers on Windows:

```bash
npm run build:win
```

Generic build:

```bash
npm run build
```

Typical outputs:

- `src-tauri/target/release/bundle/macos/`
- `src-tauri/target/release/bundle/dmg/`
- `src-tauri/target/release/bundle/msi/`
- `src-tauri/target/release/bundle/nsis/`

## Release notes

- unsigned `macOS` builds may require `Right click -> Open` on first launch
- unsigned `Windows` builds may trigger SmartScreen
- public distribution becomes much smoother once code signing and notarization are added

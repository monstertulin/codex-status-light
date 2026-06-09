# Codex Status Light

Codex Status Light is a native `macOS` menu bar app and `Windows` system tray app that turns your local Codex runtime into a simple red / yellow / green signal.

It is built for one job: let you glance at the tray and immediately know whether Codex is idle, busy, waiting on you, or stuck.

## What it does

- shows a live tray light on `macOS` and `Windows`
- reads local Codex runtime signals directly from your machine
- distinguishes active work, approval waits, errors, and stalls
- opens a small detail panel when you want the exact reason behind the current light

## Download

Download the latest installer or app bundle from [GitHub Releases](https://github.com/monstertulin/codex-status-light/releases).

- `macOS`: download the `.dmg`
- `Windows`: download the `.msi` or `NSIS .exe`

Unsigned internal builds may trigger the usual platform warnings:

- `macOS`: use `Right click -> Open` the first time, or allow it from `System Settings -> Privacy & Security`
- `Windows`: SmartScreen may show `More info -> Run anyway`

## Requirements

This app only works meaningfully on a machine where Codex has already run at least once.

It reads local runtime files from the user's `.codex` directory:

- `~/.codex/log/codex-tui.log`
- `~/.codex/logs_2.sqlite`
- `~/.codex/state_5.sqlite`

On Windows, the same files are expected under `%USERPROFILE%\\.codex\\...`.

If those files do not exist yet, the app stays in a neutral unavailable state instead of showing a fake green idle state.

## Light meanings

- `Green`: Codex is idle, settled, or has cleanly finished the last turn
- `Yellow`: Codex is actively thinking, streaming, or running tools
- `Yellow flashing`: Codex is waiting for user approval
- `Red`: Codex hit an error, was interrupted, or appears stalled
- `Neutral`: no reliable local Codex runtime signal is available yet

More detailed rules live in [docs/status-signal-model.md](docs/status-signal-model.md).

## How to use

1. Launch the app.
2. Keep it running in the menu bar or system tray.
3. Click the tray light to open the detail panel.
4. Use `Open Snapshot` to inspect the latest status JSON if you want to debug.
5. Use `Open Codex Log` to jump straight to the current Codex log file.

The native app reads Codex signals directly. It does not require the browser preview to stay open.

## Build from source

Install the app dependencies:

```bash
npm --prefix apps/status-light-shell install
```

Run tests for the shared status engine:

```bash
npm test
```

Run the native tray app in development:

```bash
npm run shell:dev
```

Run a forced status scenario to verify the lamps:

```bash
npm run shell:debug -- approval
```

Build local bundles:

```bash
npm run shell:build:mac
```

```bash
npm run shell:build:win
```

## Repository layout

- `apps/status-light-shell`: native Tauri tray app
- `packages/status-engine`: status parsing and signal mapping
- `plugins/codex-status-light`: optional Codex-side helper scaffold
- `docs`: design notes and signal model

## For maintainers

GitHub Actions is configured to:

- run tests on push and pull request
- build `macOS` and `Windows` release assets
- publish release artifacts from tags or manual workflow runs

The release workflow lives in `.github/workflows/release.yml`.

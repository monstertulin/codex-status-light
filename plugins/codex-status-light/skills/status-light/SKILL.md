---
name: status-light
description: Use this skill when working on the Codex status light, its tray-app architecture, or the red-yellow-green signal mapping.
---

# Status Light

Use this skill when the task is about the local Codex status light.

## What this plugin owns

- the Codex-side workflow and documentation
- the red-yellow-green signal model
- the shared status-engine package
- the tray-app rollout plan for `macOS` and `Windows`

## Working rules

1. Treat the tray app as the visible product surface.
2. Treat the Codex plugin as the control plane, not the live indicator itself.
3. Prefer updating `packages/status-engine` before adding logic to any future renderer.
4. When signal rules change, update both:
   - `docs/status-signal-model.md`
   - `packages/status-engine/test/status-engine.test.mjs`

## Useful starting points

- `/Users/chentulin/Documents/指示灯/docs/tauri-cross-platform-plan.md`
- `/Users/chentulin/Documents/指示灯/docs/status-signal-model.md`
- `/Users/chentulin/Documents/指示灯/packages/status-engine/src/index.mjs`

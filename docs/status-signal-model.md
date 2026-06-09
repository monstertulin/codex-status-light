# Status Signal Model

## Signal priority

The status light should prefer the most stable local signals first.

1. `config.toml` notification behavior such as `turn-ended`
2. `log/codex-tui.log`
3. `logs_2.sqlite`
4. `state_5.sqlite`

The first version should avoid treating the SQLite files as the only source of truth. They are useful, but they look more like internal implementation details than a public contract.

## Color mapping

| Semantic event | Typical local signal | Light |
| --- | --- | --- |
| turn completed | `response.completed`, `turn-ended` | green |
| turn started | `submission_dispatch`, `session_task.turn` | yellow |
| tool streaming | `response.function_call_arguments.delta`, `response.output_item.done` for function work | yellow |
| interrupt | `interrupt received` | red |
| turn error | `Turn error` | red |
| stale running state | no fresh running signal past timeout | red |

## Cross-platform paths

### macOS

- Codex home: `~/.codex`
- log file: `~/.codex/log/codex-tui.log`
- state DB: `~/.codex/state_5.sqlite`
- logs DB: `~/.codex/logs_2.sqlite`

### Windows

- Codex home: `%USERPROFILE%\\.codex`
- log file: `%USERPROFILE%\\.codex\\log\\codex-tui.log`
- state DB: `%USERPROFILE%\\.codex\\state_5.sqlite`
- logs DB: `%USERPROFILE%\\.codex\\logs_2.sqlite`

## Guard rails

- never assume a single exact log format forever
- keep rule matching token-based and easy to update
- separate signal parsing from UI rendering
- treat timeout as a renderer-safe fallback, not as the primary status source


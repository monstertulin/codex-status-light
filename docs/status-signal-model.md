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
| turn completed | `response.completed`, `turn-ended`, `app-server event: item/completed` | green |
| turn started | `submission_dispatch`, `session_task.turn`, `codex.user_prompt` | yellow |
| thinking | `response.in_progress`, `run_sampling_request`, `stream_request` | yellow |
| tool streaming | `response.function_call_arguments.delta`, `response.custom_tool_call_input.delta`, `response.output_item.done` for function work | yellow |
| reply streaming | `response.output_text.delta`, `app-server event: item/agentMessage/delta` | yellow |
| approval required | unresolved ToolCall that is waiting on user approval, including `sandbox_permissions=require_escalated` and `ToolCall: mcp__...` | yellow |
| interrupt | `interrupt received` | red |
| turn error | `Turn error` | red |
| stale running state | no fresh running signal past timeout | red |

## Global mode selection

- `workspace` mode tracks the thread that best matches the current working directory.
- `global` mode does not trust `threads.updated_at_ms` alone.
- In `global` mode, threads are ranked by the timestamp of the most recent recognizable runtime event from `logs_2.sqlite`.
- If any active thread has a fresh real event inside the global activity window, the overall light should stay yellow.
- The light only returns to green when no tracked thread has a fresh recognizable event left.
- A thread that has just completed should briefly keep green priority over older stale-red threads, so "刚完成" 不会立刻被历史卡住态盖掉。
- After a turn enters the short completion hold, trailing same-turn `thinking` / `replying` / `tool_running` style events should not break that completion hold; only a real new `turn_started` should bring the light back into active yellow.
- If several running threads are active at almost the same time, the visible detail can prefer the thread whose `cwd` best matches the current workspace, so the tray stays global while the reason text stays closer to the project you are looking at.
- Fresh approval waits stay yellow and take precedence over normal running threads.
- In `global` mode, any fresh approval wait should also take precedence over red attention threads, because the most actionable state is "需要你批准"。
- Approval waits include both shell/escalation approvals and MCP tool approvals from the desktop client.

## Cross-platform paths

### macOS

- Codex home: `~/.codex`
- log file: `~/.codex/log/codex-tui.log`
- state DB candidates: `~/.codex/state_5.sqlite`, `~/.codex/sqlite/state_5.sqlite`
- logs DB candidates: `~/.codex/logs_2.sqlite`, `~/.codex/sqlite/logs_2.sqlite`
- when both locations exist, prefer the file with the newer modification time

### Windows

- Codex home: `%USERPROFILE%\\.codex`
- log file: `%USERPROFILE%\\.codex\\log\\codex-tui.log`
- state DB candidates: `%USERPROFILE%\\.codex\\state_5.sqlite`, `%USERPROFILE%\\.codex\\sqlite\\state_5.sqlite`
- logs DB candidates: `%USERPROFILE%\\.codex\\logs_2.sqlite`, `%USERPROFILE%\\.codex\\sqlite\\logs_2.sqlite`
- when both locations exist, prefer the file with the newer modification time

## Guard rails

- never assume a single exact log format forever
- keep rule matching token-based and easy to update
- separate signal parsing from UI rendering
- treat timeout as a renderer-safe fallback, not as the primary status source

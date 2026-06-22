import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_COMPLETION_HOLD_MS,
  deriveStatusFromSignals,
  deriveStatusFromSqliteFiles,
  LIGHT_STATES
} from "../src/index.mjs";

test("deriveStatusFromSqliteFiles holds yellow briefly after a completed turn", async () => {
  const runner = async (_command, args) => {
    const sqlitePath = args[1];
    const sql = args[2];

    if (sqlitePath === "state.sqlite") {
      return { stdout: '[{"id":"thread-1","cwd":"/workspace"}]' };
    }

    if (sqlitePath === "logs.sqlite") {
      return {
        stdout: JSON.stringify([
          {
            ts: 1780627077,
            ts_nanos: 798_006_000,
            thread_id: "thread-1",
            feedback_log_body:
              'event.name="codex.sse_event" event.kind=response.completed event.timestamp=2026-06-05T02:37:54.042Z conversation.id=thread-1'
          },
          {
            ts: 1780627074,
            ts_nanos: 45_303_000,
            thread_id: "thread-1",
            feedback_log_body:
              'session_loop{thread_id=thread-1}:submission_dispatch{otel.name="op.dispatch.user_input"}:turn{otel.name="session_task.turn"}: codex_core::tasks: new'
          }
        ])
      };
    }

    throw new Error(`unexpected sqlite path: ${sqlitePath}`);
  };

  const cooling = await deriveStatusFromSqliteFiles("logs.sqlite", "state.sqlite", {
    cwd: "/workspace",
    now: Date.parse("2026-06-05T02:37:55.000Z"),
    execFileAsync: runner
  });

  const settled = await deriveStatusFromSqliteFiles("logs.sqlite", "state.sqlite", {
    cwd: "/workspace",
    now: cooling.lastEventAt + DEFAULT_COMPLETION_HOLD_MS + 1,
    execFileAsync: runner
  });

  assert.equal(cooling.state, LIGHT_STATES.RUNNING);
  assert.equal(cooling.threadId, "thread-1");
  assert.equal(cooling.lastEventKind, "cooldown");
  assert.equal(settled.state, LIGHT_STATES.IDLE);
  assert.equal(settled.lastEventKind, "turn_completed");
});

test("deriveStatusFromSqliteFiles keeps completion cooldown when trailing reply deltas arrive", async () => {
  const runner = async (_command, args) => {
    const sqlitePath = args[1];
    const sql = args[2];

    if (sqlitePath === "state.sqlite") {
      return { stdout: '[{"id":"thread-1","cwd":"/workspace"}]' };
    }

    if (sqlitePath === "logs.sqlite") {
      return {
        stdout: JSON.stringify([
          {
            ts: 1780627077,
            ts_nanos: 798_006_000,
            thread_id: "thread-1",
            feedback_log_body:
              'event.name="codex.sse_event" event.kind=response.completed event.timestamp=2026-06-05T02:37:54.042Z conversation.id=thread-1'
          },
          {
            ts: 1780627077,
            ts_nanos: 900_000_000,
            thread_id: "thread-1",
            feedback_log_body:
              'event.name="codex.sse_event" event.kind=response.output_text.delta event.timestamp=2026-06-05T02:37:54.900Z conversation.id=thread-1'
          }
        ])
      };
    }

    throw new Error(`unexpected sqlite path: ${sqlitePath}`);
  };

  const cooling = await deriveStatusFromSqliteFiles("logs.sqlite", "state.sqlite", {
    cwd: "/workspace",
    now: Date.parse("2026-06-05T02:37:55.000Z"),
    execFileAsync: runner
  });

  assert.equal(cooling.state, LIGHT_STATES.RUNNING);
  assert.equal(cooling.lastEventKind, "cooldown");
  assert.equal(cooling.reason, "Codex 刚完成任务，黄灯会短暂停留");
});

test("deriveStatusFromSqliteFiles falls back to the latest global thread", async () => {
  const runner = async (_command, args) => {
    const sqlitePath = args[1];
    const sql = args[2];

    if (sqlitePath === "state.sqlite") {
      return {
        stdout: JSON.stringify([
          { id: "thread-1", cwd: "/other-workspace" },
          { id: "thread-2", cwd: "/workspace" }
        ])
      };
    }

    if (sqlitePath === "logs.sqlite") {
      if (sql.includes("thread_id = 'thread-1'")) {
        return {
          stdout: JSON.stringify([
            {
              ts: 1780627074,
              ts_nanos: 45_303_000,
              thread_id: "thread-1",
              feedback_log_body:
                'session_loop{thread_id=thread-1}:submission_dispatch{otel.name="op.dispatch.user_input"}:turn{otel.name="session_task.turn"}: codex_core::tasks: new'
            }
          ])
        };
      }

      return {
        stdout: JSON.stringify([
          {
            ts: 1780627060,
            ts_nanos: 45_303_000,
            thread_id: "thread-2",
            feedback_log_body:
              'session_loop{thread_id=thread-2}:submission_dispatch{otel.name="op.dispatch.user_input"}:turn{otel.name="session_task.turn"}: codex_core::tasks: new'
          }
        ])
      };
    }

    throw new Error(`unexpected sqlite path: ${sqlitePath}`);
  };

  const status = await deriveStatusFromSqliteFiles("logs.sqlite", "state.sqlite", {
    cwd: "/workspace",
    now: Date.parse("2026-06-05T02:37:55.000Z"),
    execFileAsync: runner
  });

  assert.equal(status.state, LIGHT_STATES.RUNNING);
  assert.equal(status.threadId, "thread-1");
  assert.equal(status.lastEventKind, "turn_started");
});

test("deriveStatusFromSqliteFiles keeps yellow when any global thread has a fresh real event", async () => {
  const runner = async (_command, args) => {
    const sqlitePath = args[1];
    const sql = args[2];

    if (sqlitePath === "state.sqlite") {
      return {
        stdout: JSON.stringify([
          { id: "thread-green", cwd: "/workspace-a" },
          { id: "thread-yellow", cwd: "/workspace-b" }
        ])
      };
    }

    if (sqlitePath === "logs.sqlite") {
      if (sql.includes("thread_id = 'thread-green'")) {
        return {
          stdout: JSON.stringify([
            {
              ts: 1780627000,
              ts_nanos: 0,
              thread_id: "thread-green",
              feedback_log_body:
                'event.name="codex.sse_event" event.kind=response.completed event.timestamp=2026-06-05T02:36:40.000Z conversation.id=thread-green'
            }
          ])
        };
      }

      return {
        stdout: JSON.stringify([
          {
            ts: 1780627077,
            ts_nanos: 0,
            thread_id: "thread-yellow",
            feedback_log_body:
              'event.name="codex.sse_event" event.kind=response.output_text.delta event.timestamp=2026-06-05T02:37:57.000Z conversation.id=thread-yellow'
          }
        ])
      };
    }

    throw new Error(`unexpected sqlite path: ${sqlitePath}`);
  };

  const status = await deriveStatusFromSqliteFiles("logs.sqlite", "state.sqlite", {
    now: Date.parse("2026-06-05T02:37:58.000Z"),
    execFileAsync: runner
  });

  assert.equal(status.state, LIGHT_STATES.RUNNING);
  assert.equal(status.threadId, "thread-yellow");
  assert.equal(status.lastEventKind, "replying");
});

test("deriveStatusFromSqliteFiles prefers recent completion over old stalled attention in global mode", async () => {
  const runner = async (_command, args) => {
    const sqlitePath = args[1];
    const sql = args[2];

    if (sqlitePath === "state.sqlite") {
      return {
        stdout: JSON.stringify([
          { id: "thread-stalled", cwd: "/other" },
          { id: "thread-completed", cwd: "/workspace" }
        ])
      };
    }

    if (sqlitePath === "logs.sqlite") {
      if (sql.includes("thread_id = 'thread-stalled'")) {
        return {
          stdout: JSON.stringify([
            {
              ts: 10,
              ts_nanos: 0,
              thread_id: "thread-stalled",
              feedback_log_body:
                '2026-06-05T01:00:10.000Z INFO codex_core::session: Turn error: Unauthorized conversation.id=thread-stalled'
            }
          ])
        };
      }

      if (sql.includes("thread_id = 'thread-completed'")) {
        return {
          stdout: JSON.stringify([
            {
              ts: 59,
              ts_nanos: 0,
              thread_id: "thread-completed",
              feedback_log_body:
                'event.name="codex.sse_event" event.kind=response.completed event.timestamp=2026-06-05T01:00:59.000Z conversation.id=thread-completed'
            }
          ])
        };
      }
    }

    throw new Error(`unexpected sqlite request: ${sqlitePath} ${sql}`);
  };

  const status = await deriveStatusFromSqliteFiles("logs.sqlite", "state.sqlite", {
    cwd: "/workspace",
    scope: "global",
    now: 62_001,
    execFileAsync: runner
  });

  assert.equal(status.state, LIGHT_STATES.IDLE);
  assert.equal(status.threadId, "thread-completed");
  assert.equal(status.lastEventKind, "turn_completed");
});

test("deriveStatusFromSqliteFiles returns green when no actionable threads remain", async () => {
  const runner = async (_command, args) => {
    const sqlitePath = args[1];
    const sql = args[2];

    if (sqlitePath === "state.sqlite") {
      return {
        stdout: JSON.stringify([
          { id: "thread-stalled", cwd: "/other" },
          { id: "thread-completed", cwd: "/workspace" }
        ])
      };
    }

    if (sqlitePath === "logs.sqlite") {
      if (sql.includes("thread_id = 'thread-stalled'")) {
        return {
          stdout: JSON.stringify([
            {
              ts: 10,
              ts_nanos: 0,
              thread_id: "thread-stalled",
              feedback_log_body:
                '2026-06-05T01:00:10.000Z INFO codex_core::session: Turn error: Unauthorized conversation.id=thread-stalled'
            }
          ])
        };
      }

      if (sql.includes("thread_id = 'thread-completed'")) {
        return {
          stdout: JSON.stringify([
            {
              ts: 20,
              ts_nanos: 0,
              thread_id: "thread-completed",
              feedback_log_body:
                'event.name="codex.sse_event" event.kind=response.completed event.timestamp=2026-06-05T01:00:20.000Z conversation.id=thread-completed'
            }
          ])
        };
      }
    }

    throw new Error(`unexpected sqlite request: ${sqlitePath} ${sql}`);
  };

  const status = await deriveStatusFromSqliteFiles("logs.sqlite", "state.sqlite", {
    now: 60_000,
    execFileAsync: runner
  });

  assert.equal(status.state, LIGHT_STATES.IDLE);
  assert.equal(status.color, "green");
  assert.equal(status.reason, "最近没有发现 Codex 活动");
  assert.equal(status.lastEventKind, "startup");
});

test("deriveStatusFromSqliteFiles prefers the current workspace thread when global activity is nearly simultaneous", async () => {
  const runner = async (_command, args) => {
    const sqlitePath = args[1];
    const sql = args[2];

    if (sqlitePath === "state.sqlite") {
      return {
        stdout: JSON.stringify([
          { id: "thread-other", cwd: "/other-project" },
          { id: "thread-workspace", cwd: "/workspace" }
        ])
      };
    }

    if (sqlitePath === "logs.sqlite") {
      if (sql.includes("thread_id = 'thread-other'")) {
        return {
          stdout: JSON.stringify([
            {
              ts: 1780627079,
              ts_nanos: 0,
              thread_id: "thread-other",
              feedback_log_body:
                'event.name="codex.sse_event" event.kind=response.output_text.delta event.timestamp=2026-06-05T02:37:59.000Z conversation.id=thread-other'
            }
          ])
        };
      }

      return {
        stdout: JSON.stringify([
          {
            ts: 1780627076,
            ts_nanos: 0,
            thread_id: "thread-workspace",
            feedback_log_body:
              'event.name="codex.sse_event" event.kind=response.output_text.delta event.timestamp=2026-06-05T02:37:56.000Z conversation.id=thread-workspace'
          }
        ])
      };
    }

    throw new Error(`unexpected sqlite path: ${sqlitePath}`);
  };

  const status = await deriveStatusFromSqliteFiles("logs.sqlite", "state.sqlite", {
    cwd: "/workspace",
    now: Date.parse("2026-06-05T02:38:00.000Z"),
    execFileAsync: runner
  });

  assert.equal(status.state, LIGHT_STATES.RUNNING);
  assert.equal(status.threadId, "thread-workspace");
  assert.equal(status.lastEventKind, "replying");
});

test("deriveStatusFromSqliteFiles prioritizes unresolved approval requests", async () => {
  const runner = async (_command, args) => {
    const sqlitePath = args[1];
    const sql = args[2];

    if (sqlitePath === "state.sqlite") {
      return { stdout: '[{"id":"thread-approval","cwd":"/workspace"}]' };
    }

    if (sqlitePath === "logs.sqlite") {
      if (sql.includes('%"sandbox_permissions":"require_escalated"%')) {
        return {
          stdout: JSON.stringify([
            {
              ts: 1780627078,
              ts_nanos: 0,
              thread_id: "thread-approval",
              feedback_log_body:
                'session_loop{thread_id=thread-approval}:handle_output_item_done:handle_tool_call:handle_tool_call_with_source:dispatch_tool_call_with_code_mode_result{tool_name="exec_command" call_id="call_123" aborted=false}:handle_output_item_done: ToolCall: exec_command {"sandbox_permissions":"require_escalated","justification":"Do you want to allow ..."}'
            }
          ])
        };
      }

      return {
        stdout: JSON.stringify([
          {
            ts: 1780627079,
            ts_nanos: 0,
            thread_id: "thread-approval",
            feedback_log_body:
              'event.name="codex.sse_event" event.kind=response.output_text.delta event.timestamp=2026-06-05T02:37:59.000Z conversation.id=thread-approval'
          }
        ])
      };
    }

    throw new Error(`unexpected sqlite path: ${sqlitePath}`);
  };

  const status = await deriveStatusFromSqliteFiles("logs.sqlite", "state.sqlite", {
    cwd: "/workspace",
    now: Date.parse("2026-06-05T02:38:00.000Z"),
    execFileAsync: runner
  });

  assert.equal(status.state, LIGHT_STATES.RUNNING);
  assert.equal(status.threadId, "thread-approval");
  assert.equal(status.lastEventKind, "approval_required");
  assert.equal(status.reason, "等待你的授权");
});

test("deriveStatusFromSqliteFiles prioritizes approval over attention in global mode", async () => {
  const runner = async (_command, args) => {
    const sqlitePath = args[1];
    const sql = args[2];

    if (sqlitePath === "state.sqlite") {
      return {
        stdout: JSON.stringify([
          { id: "thread-attention", cwd: "/other" },
          { id: "thread-approval", cwd: "/workspace" }
        ])
      };
    }

    if (sqlitePath === "logs.sqlite") {
      if (sql.includes("thread_id = 'thread-attention'")) {
        return {
          stdout: JSON.stringify([
            {
              ts: 1780627079,
              ts_nanos: 0,
              thread_id: "thread-attention",
              feedback_log_body:
                '2026-06-05T02:37:59.000Z INFO codex_core::session: Turn error: Unauthorized conversation.id=thread-attention'
            }
          ])
        };
      }

      if (sql.includes('%"sandbox_permissions":"require_escalated"%')) {
        return {
          stdout: JSON.stringify([
            {
              ts: 1780627078,
              ts_nanos: 0,
              thread_id: "thread-approval",
              feedback_log_body:
                'session_loop{thread_id=thread-approval}:handle_output_item_done:handle_tool_call:handle_tool_call_with_source:dispatch_tool_call_with_code_mode_result{tool_name="exec_command" call_id="call_123" aborted=false}:handle_output_item_done: ToolCall: exec_command {"sandbox_permissions":"require_escalated","justification":"Do you want to allow ..."}'
            }
          ])
        };
      }

      return {
        stdout: JSON.stringify([
          {
            ts: 1780627077,
            ts_nanos: 0,
            thread_id: "thread-approval",
            feedback_log_body:
              'event.name="codex.sse_event" event.kind=response.output_text.delta event.timestamp=2026-06-05T02:37:57.000Z conversation.id=thread-approval'
          }
        ])
      };
    }

    throw new Error(`unexpected sqlite path: ${sqlitePath}`);
  };

  const status = await deriveStatusFromSqliteFiles("logs.sqlite", "state.sqlite", {
    cwd: "/workspace",
    now: Date.parse("2026-06-05T02:38:00.000Z"),
    execFileAsync: runner
  });

  assert.equal(status.state, LIGHT_STATES.RUNNING);
  assert.equal(status.threadId, "thread-approval");
  assert.equal(status.lastEventKind, "approval_required");
  assert.equal(status.reason, "等待你的授权");
});

test("deriveStatusFromSqliteFiles treats unresolved mcp tool approval as approval required", async () => {
  const runner = async (_command, args) => {
    const sqlitePath = args[1];
    const sql = args[2];

    if (sqlitePath === "state.sqlite") {
      return { stdout: '[{"id":"thread-mcp-approval","cwd":"/workspace"}]' };
    }

    if (sqlitePath === "logs.sqlite") {
      if (sql.includes("handle_output_item_done: ToolCall: mcp__")) {
        return {
          stdout: JSON.stringify([
            {
              ts: 1781661539,
              ts_nanos: 458_829_000,
              thread_id: "thread-mcp-approval",
              feedback_log_body:
                'session_loop{thread_id=thread-mcp-approval}:handle_output_item_done: ToolCall: mcp__codegraphcodegraph_explore {"projectPath":"/workspace","query":"foo", "maxFiles":8} thread_id=thread-mcp-approval'
            }
          ])
        };
      }

      return {
        stdout: JSON.stringify([
          {
            ts: 1781661538,
            ts_nanos: 443_335_000,
            thread_id: "thread-mcp-approval",
            feedback_log_body:
              'event.name="codex.sse_event" event.kind=response.in_progress event.timestamp=2026-06-17T01:58:58.000Z conversation.id=thread-mcp-approval'
          }
        ])
      };
    }

    throw new Error(`unexpected sqlite path: ${sqlitePath}`);
  };

  const status = await deriveStatusFromSqliteFiles("logs.sqlite", "state.sqlite", {
    cwd: "/workspace",
    now: Date.parse("2026-06-17T01:59:00.000Z"),
    execFileAsync: runner
  });

  assert.equal(status.state, LIGHT_STATES.RUNNING);
  assert.equal(status.threadId, "thread-mcp-approval");
  assert.equal(status.lastEventKind, "approval_required");
  assert.equal(status.reason, "等待你的授权");
});

test("deriveStatusFromSqliteFiles clears mcp approval after tool result arrives", async () => {
  const runner = async (_command, args) => {
    const sqlitePath = args[1];
    const sql = args[2];

    if (sqlitePath === "state.sqlite") {
      return { stdout: '[{"id":"thread-mcp-resolved","cwd":"/workspace"}]' };
    }

    if (sqlitePath === "logs.sqlite") {
      if (sql.includes("handle_output_item_done: ToolCall: mcp__")) {
        return {
          stdout: JSON.stringify([
            {
              ts: 1781661680,
              ts_nanos: 944_570_000,
              thread_id: "thread-mcp-resolved",
              feedback_log_body:
                'dispatch_tool_call_with_terminal_outcome: event.name="codex.tool_result" tool_name=mcp__codegraphcodegraph_explore call_id=call_taCWh9BB6fXrU3jidFSev8vL duration_ms=141470 success=false conversation.id=thread-mcp-resolved'
            },
            {
              ts: 1781661539,
              ts_nanos: 458_829_000,
              thread_id: "thread-mcp-resolved",
              feedback_log_body:
                'session_loop{thread_id=thread-mcp-resolved}:handle_output_item_done: ToolCall: mcp__codegraphcodegraph_explore {"projectPath":"/workspace","query":"foo", "maxFiles":8} thread_id=thread-mcp-resolved'
            }
          ])
        };
      }

      return {
        stdout: JSON.stringify([
          {
            ts: 1781661680,
            ts_nanos: 944_570_000,
            thread_id: "thread-mcp-resolved",
            feedback_log_body:
              'event.name="codex.sse_event" event.kind=response.in_progress event.timestamp=2026-06-17T02:01:20.944Z conversation.id=thread-mcp-resolved'
          }
        ])
      };
    }

    throw new Error(`unexpected sqlite path: ${sqlitePath}`);
  };

  const status = await deriveStatusFromSqliteFiles("logs.sqlite", "state.sqlite", {
    cwd: "/workspace",
    now: Date.parse("2026-06-17T02:01:21.000Z"),
    execFileAsync: runner
  });

  assert.equal(status.state, LIGHT_STATES.RUNNING);
  assert.equal(status.threadId, "thread-mcp-resolved");
  assert.equal(status.lastEventKind, "thinking");
});

test("deriveStatusFromSqliteFiles ignores prompt context that only mentions approval strings", async () => {
  const runner = async (_command, args) => {
    const sqlitePath = args[1];
    const sql = args[2];

    if (sqlitePath === "state.sqlite") {
      return { stdout: '[{"id":"thread-prompt-noise","cwd":"/workspace"}]' };
    }

    if (sqlitePath === "logs.sqlite") {
      if (sql.includes('%"sandbox_permissions":"require_escalated"%')) {
        return {
          stdout: JSON.stringify([
            {
              ts: 1780627078,
              ts_nanos: 0,
              thread_id: "thread-prompt-noise",
              feedback_log_body:
                'stream_request:model_client.stream_responses_api: POST to https://api.example.test/responses: {"instructions":"developer text mentioning handle_output_item_done: ToolCall: exec_command {\\\\\\"sandbox_permissions\\\\\\":\\\\\\"require_escalated\\\\\\",\\\\\\"justification\\\\\\":\\\\\\"Do you want to allow ...\\\\\\"}"}'
            }
          ])
        };
      }

      return {
        stdout: JSON.stringify([
          {
            ts: 1780627079,
            ts_nanos: 0,
            thread_id: "thread-prompt-noise",
            feedback_log_body:
              'event.name="codex.sse_event" event.kind=response.output_text.delta event.timestamp=2026-06-05T02:37:59.000Z conversation.id=thread-prompt-noise'
          }
        ])
      };
    }

    throw new Error(`unexpected sqlite path: ${sqlitePath}`);
  };

  const status = await deriveStatusFromSqliteFiles("logs.sqlite", "state.sqlite", {
    cwd: "/workspace",
    now: Date.parse("2026-06-05T02:38:00.000Z"),
    execFileAsync: runner
  });

  assert.equal(status.state, LIGHT_STATES.RUNNING);
  assert.equal(status.threadId, "thread-prompt-noise");
  assert.equal(status.lastEventKind, "replying");
});

test("deriveStatusFromSqliteFiles picks response events that only carry conversation ids", async () => {
  const runner = async (_command, args) => {
    const sqlitePath = args[1];
    const sql = args[2];

    if (sqlitePath === "state.sqlite") {
      return { stdout: '[{"id":"thread-3"}]' };
    }

    if (sqlitePath === "logs.sqlite") {
      assert.match(sql, /conversation\.id=thread-3/);
      return {
        stdout: JSON.stringify([
          {
            ts: 1780627077,
            ts_nanos: 798_006_000,
            thread_id: null,
            feedback_log_body:
              'event.name="codex.sse_event" event.kind=response.output_text.delta event.timestamp=2026-06-05T02:37:54.042Z conversation.id=thread-3'
          }
        ])
      };
    }

    throw new Error(`unexpected sqlite path: ${sqlitePath}`);
  };

  const status = await deriveStatusFromSqliteFiles("logs.sqlite", "state.sqlite", {
    cwd: "/workspace",
    now: Date.parse("2026-06-05T02:37:55.000Z"),
    execFileAsync: runner
  });

  assert.equal(status.state, LIGHT_STATES.RUNNING);
  assert.equal(status.threadId, "thread-3");
  assert.equal(status.lastEventKind, "replying");
});

test("deriveStatusFromSignals falls back to the log file when sqlite is unavailable", async () => {
  const status = await deriveStatusFromSignals({
    cwd: "/workspace",
    logsSqlite: "/tmp/missing-logs.sqlite",
    stateSqlite: "/tmp/missing-state.sqlite",
    logFile: "/tmp/does-not-exist-codex-status-light.log"
  });

  assert.equal(status.state, LIGHT_STATES.IDLE);
});

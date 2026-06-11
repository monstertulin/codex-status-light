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

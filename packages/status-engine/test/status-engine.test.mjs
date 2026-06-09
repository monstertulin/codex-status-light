import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyLogLine,
  createInitialStatus,
  DEFAULT_COMPLETION_HOLD_MS,
  DEFAULT_ERROR_HOLD_MS,
  DEFAULT_INTERRUPT_HOLD_MS,
  DEFAULT_RUNNING_STALE_MS,
  deriveStatus,
  LIGHT_COLORS,
  LIGHT_STATES,
  reduceLogLine,
  resolveCodexHome,
  resolveSignalFiles
} from "../src/index.mjs";

test("resolveCodexHome uses the user home on macOS", () => {
  const codexHome = resolveCodexHome({
    platform: "darwin",
    homeDir: "/Users/demo"
  });

  assert.equal(codexHome, "/Users/demo/.codex");
});

test("resolveCodexHome uses the user home on Windows", () => {
  const codexHome = resolveCodexHome({
    platform: "win32",
    homeDir: "C:\\Users\\demo"
  });

  assert.equal(codexHome, "C:\\Users\\demo\\.codex");
});

test("resolveSignalFiles points to the expected local files", () => {
  const files = resolveSignalFiles({
    codexHome: "/Users/demo/.codex"
  });

  assert.equal(files.logFile, "/Users/demo/.codex/log/codex-tui.log");
  assert.equal(files.logsSqlite, "/Users/demo/.codex/logs_2.sqlite");
});

test("resolveSignalFiles uses Windows separators when asked", () => {
  const files = resolveSignalFiles({
    platform: "win32",
    codexHome: "C:\\Users\\demo\\.codex"
  });

  assert.equal(files.logFile, "C:\\Users\\demo\\.codex\\log\\codex-tui.log");
  assert.equal(files.stateSqlite, "C:\\Users\\demo\\.codex\\state_5.sqlite");
});

test("classifyLogLine detects a running event", () => {
  const line =
    "2026-06-05T01:00:00Z INFO session_loop{thread_id=abc-123}:submission_dispatch{otel.name=\"op.dispatch.user_input\"}:turn{otel.name=\"session_task.turn\"}: codex_core::tasks: new";
  const event = classifyLogLine(line);

  assert.equal(event.kind, "turn_started");
  assert.equal(event.threadId, "abc-123");
});

test("running transitions the light to yellow", () => {
  const initial = createInitialStatus(1_000);
  const next = reduceLogLine(
    initial,
    "2026-06-05T01:00:00Z INFO session_loop{thread_id=abc-123}:submission_dispatch{otel.name=\"op.dispatch.user_input\"}:turn{otel.name=\"session_task.turn\"}: codex_core::tasks: new"
  );

  assert.equal(next.state, LIGHT_STATES.RUNNING);
  assert.equal(next.color, LIGHT_COLORS[LIGHT_STATES.RUNNING]);
  assert.equal(next.reason, "Codex started a new turn");
});

test("response.in_progress keeps the light yellow", () => {
  const running = reduceLogLine(
    createInitialStatus(1_000),
    'event.name="codex.sse_event" event.kind=response.in_progress event.timestamp=2026-06-05T02:37:49.364Z conversation.id=abc-123'
  );

  assert.equal(running.state, LIGHT_STATES.RUNNING);
  assert.equal(running.threadId, "abc-123");
  assert.equal(running.lastEventKind, "thinking");
  assert.equal(running.reason, "Codex is thinking");
});

test("function call activity is labeled as tool work", () => {
  const running = reduceLogLine(
    createInitialStatus(1_000),
    '2026-06-05T01:00:03Z TRACE codex_api::sse::responses|SSE event: {"type":"response.output_item.added","item":{"type":"function_call","status":"in_progress"}}'
  );

  assert.equal(running.state, LIGHT_STATES.RUNNING);
  assert.equal(running.lastEventKind, "tool_running");
  assert.equal(running.reason, "Codex is running tools");
});

test("completion holds the light yellow briefly", () => {
  const running = reduceLogLine(
    createInitialStatus(1_000),
    "2026-06-05T01:00:00Z INFO session_loop{thread_id=abc-123}:submission_dispatch{otel.name=\"op.dispatch.user_input\"}:turn{otel.name=\"session_task.turn\"}: codex_core::tasks: new"
  );
  const done = reduceLogLine(
    running,
    "2026-06-05T01:00:05Z TRACE codex_api::sse::responses|SSE event: {\"type\":\"response.completed\"}"
  );

  assert.equal(done.state, LIGHT_STATES.RUNNING);
  assert.equal(done.color, LIGHT_COLORS[LIGHT_STATES.RUNNING]);
  assert.equal(done.lastEventKind, "cooldown");
  assert.equal(done.reason, "Codex just finished; holding yellow briefly");
});

test("completion hold expires back to green", () => {
  const cooling = reduceLogLine(
    createInitialStatus(1_000),
    "2026-06-05T01:00:05Z TRACE codex_api::sse::responses|SSE event: {\"type\":\"response.completed\"}"
  );
  const settled = deriveStatus(cooling, {
    now: cooling.lastEventAt + DEFAULT_COMPLETION_HOLD_MS + 1,
    completionHoldMs: DEFAULT_COMPLETION_HOLD_MS
  });

  assert.equal(settled.state, LIGHT_STATES.IDLE);
  assert.equal(settled.lastEventKind, "turn_completed");
  assert.equal(settled.reason, "turn completed");
});

test("interrupt transitions the light to red", () => {
  const interrupted = reduceLogLine(
    createInitialStatus(1_000),
    "2026-06-05T01:00:03Z INFO codex_core::session: interrupt received: abort current task, if any"
  );

  assert.equal(interrupted.state, LIGHT_STATES.ATTENTION);
  assert.equal(interrupted.color, LIGHT_COLORS[LIGHT_STATES.ATTENTION]);
});

test("interrupt attention clears after a short hold", () => {
  const interrupted = reduceLogLine(
    createInitialStatus(1_000),
    "2026-06-05T01:00:03Z INFO codex_core::session: interrupt received: abort current task, if any"
  );
  const cleared = deriveStatus(interrupted, {
    now: interrupted.lastEventAt + DEFAULT_INTERRUPT_HOLD_MS + 1,
    interruptHoldMs: DEFAULT_INTERRUPT_HOLD_MS
  });

  assert.equal(cleared.state, LIGHT_STATES.IDLE);
  assert.equal(cleared.lastEventKind, "attention_cleared");
  assert.equal(cleared.reason, "waiting for the next turn");
});

test("authentication failures transition the light to red", () => {
  const failed = reduceLogLine(
    createInitialStatus(1_000),
    '2026-06-05T01:00:03Z INFO codex_core::session::turn: Turn error: unexpected status 401 Unauthorized: {"error":"Unauthorized - Invalid API Key"}'
  );

  assert.equal(failed.state, LIGHT_STATES.ATTENTION);
  assert.equal(failed.lastEventKind, "auth_error");
  assert.equal(failed.reason, "Codex authentication failed");
});

test("turn errors stay red for a longer hold before clearing", () => {
  const failed = reduceLogLine(
    createInitialStatus(1_000),
    '2026-06-05T01:00:03Z INFO codex_core::session::turn: Turn error: unexpected status 429 Too Many Requests'
  );
  const stillAttention = deriveStatus(failed, {
    now: failed.lastEventAt + DEFAULT_ERROR_HOLD_MS - 1,
    errorHoldMs: DEFAULT_ERROR_HOLD_MS
  });
  const cleared = deriveStatus(failed, {
    now: failed.lastEventAt + DEFAULT_ERROR_HOLD_MS + 1,
    errorHoldMs: DEFAULT_ERROR_HOLD_MS
  });

  assert.equal(stillAttention.state, LIGHT_STATES.ATTENTION);
  assert.equal(cleared.state, LIGHT_STATES.IDLE);
  assert.equal(cleared.lastEventKind, "attention_cleared");
});

test("stale running activity transitions the light to red", () => {
  const running = reduceLogLine(
    createInitialStatus(1_000),
    "2026-06-05T01:00:00Z INFO session_loop{thread_id=abc-123}:submission_dispatch{otel.name=\"op.dispatch.user_input\"}:turn{otel.name=\"session_task.turn\"}: codex_core::tasks: new"
  );
  const stale = deriveStatus(running, {
    now: running.lastEventAt + DEFAULT_RUNNING_STALE_MS + 1_000,
    runningStaleMs: DEFAULT_RUNNING_STALE_MS
  });

  assert.equal(stale.state, LIGHT_STATES.ATTENTION);
  assert.equal(stale.lastEventKind, "stalled");
  assert.equal(stale.lastEventAt, running.lastEventAt);
});

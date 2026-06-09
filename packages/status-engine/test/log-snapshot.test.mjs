import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_COMPLETION_HOLD_MS,
  deriveStatusFromLogFile,
  deriveStatusFromLogText,
  LIGHT_STATES,
  readSnapshotFile,
  writeSnapshotFile
} from "../src/index.mjs";

test("deriveStatusFromLogText holds yellow briefly after completion", () => {
  const logText = [
    "2026-06-05T01:00:00Z INFO session_loop{thread_id=abc-123}:submission_dispatch{otel.name=\"op.dispatch.user_input\"}:turn{otel.name=\"session_task.turn\"}: codex_core::tasks: new",
    "2026-06-05T01:00:05Z TRACE codex_api::sse::responses|SSE event: {\"type\":\"response.completed\"}"
  ].join("\n");

  const cooling = deriveStatusFromLogText(logText, {
    initialNow: Date.parse("2026-06-05T01:00:00Z"),
    now: Date.parse("2026-06-05T01:00:06Z")
  });

  const settled = deriveStatusFromLogText(logText, {
    initialNow: Date.parse("2026-06-05T01:00:00Z"),
    now: Date.parse("2026-06-05T01:00:09Z")
  });

  assert.equal(cooling.state, LIGHT_STATES.RUNNING);
  assert.equal(cooling.lastEventKind, "cooldown");
  assert.equal(settled.state, LIGHT_STATES.IDLE);
  assert.equal(settled.lastEventKind, "turn_completed");
  assert.equal(DEFAULT_COMPLETION_HOLD_MS, 3_000);
});

test("deriveStatusFromLogFile returns idle when the log file is missing", async () => {
  const status = await deriveStatusFromLogFile("/tmp/does-not-exist-codex-status-light.log");
  assert.equal(status.state, LIGHT_STATES.IDLE);
});

test("writeSnapshotFile and readSnapshotFile round-trip the payload", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-status-light-"));
  const outputPath = path.join(tmpDir, "snapshot.json");
  const snapshot = {
    state: "running",
    color: "yellow",
    reason: "Codex is actively working",
    lastEventKind: "running",
    lastEventAt: 123,
    threadId: "abc-123"
  };

  await writeSnapshotFile(outputPath, snapshot);
  const restored = await readSnapshotFile(outputPath);

  assert.deepEqual(restored, snapshot);
});

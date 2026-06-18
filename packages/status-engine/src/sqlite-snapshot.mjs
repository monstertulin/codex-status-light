import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveSignalFiles } from "./codex-paths.mjs";
import { classifyLogText, extractThreadId } from "./log-events.mjs";
import {
  createInitialStatus,
  deriveStatus,
  reduceEvent
} from "./status-machine.mjs";
import { LIGHT_STATES } from "./status-contract.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_SQLITE_EVENT_LIMIT = 120;
const DEFAULT_SQLITE_APPROVAL_LIMIT = 80;
const DEFAULT_THREAD_CANDIDATE_SCAN_LIMIT = 64;
const DEFAULT_GLOBAL_THREAD_WINDOW_MS = 600_000;
const GLOBAL_WORKSPACE_PREFERENCE_GRACE_MS = 8_000;
const APPROVAL_PENDING_FALLBACK_MS = 60_000;
const DOMINANT_COMPLETED_FRESH_MS = 10_000;
const DOMINANT_RUNNING_FRESH_MS = 20_000;
const DOMINANT_ATTENTION_FRESH_MS = 15_000;
const SIGNAL_BODY_FILTERS = [
  "%Turn error%",
  "%interrupt received%",
  "%turn-ended%",
  "%retrying sampling request%",
  "%codex.user_prompt%",
  "%session_task.turn%",
  "%run_sampling_request%",
  "%stream_request%",
  "%app-server event: item/agentMessage/delta%",
  "%app-server event: item/completed%",
  "%response.completed%",
  "%response.in_progress%",
  "%response.output_item.added%",
  "%response.custom_tool_call_input.delta%",
  "%response.output_text.delta%",
  "%response.function_call_arguments.delta%",
  "%response.output_item.done%"
];

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function eventTimeMs(row) {
  return row.ts * 1000 + Math.floor((row.ts_nanos ?? 0) / 1_000_000);
}

function normalizeScope(scope) {
  const value = String(scope ?? process.env.CODEX_STATUS_LIGHT_SCOPE ?? "global")
    .trim()
    .toLowerCase();

  return value === "workspace" || value === "cwd" || value === "project"
    ? "workspace"
    : "global";
}

function globalThreadWindowMs(options = {}) {
  const value =
    options.globalThreadWindowMs ??
    Number.parseInt(process.env.CODEX_STATUS_LIGHT_GLOBAL_WINDOW_MS ?? "", 10);

  if (!Number.isFinite(value)) {
    return DEFAULT_GLOBAL_THREAD_WINDOW_MS;
  }

  return Math.max(value, DEFAULT_GLOBAL_THREAD_WINDOW_MS);
}

function freshnessPriority(ageMs) {
  if (ageMs <= 5_000) {
    return 4;
  }

  if (ageMs <= 15_000) {
    return 3;
  }

  if (ageMs <= 60_000) {
    return 2;
  }

  return 1;
}

function snapshotPriority(snapshot, now) {
  const ageMs = Math.max(0, now - (snapshot.lastEventAt ?? 0));
  let statePriority = 0;

  if (
    snapshot.state === LIGHT_STATES.ATTENTION &&
    snapshot.lastEventKind !== "stalled"
  ) {
    statePriority = 6;
  } else if (
    snapshot.state === LIGHT_STATES.ATTENTION &&
    ageMs <= DOMINANT_ATTENTION_FRESH_MS
  ) {
    statePriority = 5;
  } else if (
    snapshot.state === LIGHT_STATES.RUNNING &&
    snapshot.lastEventKind === "approval_required"
  ) {
    statePriority = 4;
  } else if (
    snapshot.state === LIGHT_STATES.RUNNING &&
    ageMs <= DOMINANT_RUNNING_FRESH_MS
  ) {
    statePriority = 3;
  } else if (
    snapshot.state === LIGHT_STATES.IDLE &&
    snapshot.lastEventKind === "turn_completed" &&
    ageMs <= DOMINANT_COMPLETED_FRESH_MS
  ) {
    statePriority = 2;
  } else if (snapshot.state === LIGHT_STATES.ATTENTION) {
    statePriority = 2;
  } else if (snapshot.state === LIGHT_STATES.RUNNING) {
    statePriority = 1;
  }

  return [statePriority, freshnessPriority(ageMs), snapshot.lastEventAt ?? 0];
}

function comparePriority(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }

  return 0;
}

async function querySqliteJson(sqlitePath, sql, options = {}) {
  const runner = options.execFileAsync ?? execFileAsync;
  const { stdout } = await runner("sqlite3", ["-json", sqlitePath, sql], {
    maxBuffer: 8 * 1024 * 1024
  });

  const text = stdout.trim();
  return text ? JSON.parse(text) : [];
}

function classifySqliteRow(row) {
  const body = row.feedback_log_body ?? "";
  const event = classifyLogText(body);

  if (!event) {
    return null;
  }

  return {
    ...event,
    at: eventTimeMs(row),
    threadId: row.thread_id ?? event.threadId ?? extractThreadId(body) ?? null,
    raw: body
  };
}

function extractMarkerValue(text, marker) {
  const startIndex = text.indexOf(marker);
  if (startIndex === -1) {
    return null;
  }

  const suffix = text.slice(startIndex + marker.length);
  const match = suffix.match(/^[A-Za-z0-9_-]+/u);
  return match?.[0] ?? null;
}

function extractCallId(text) {
  return (
    extractMarkerValue(text, 'call_id="') ??
    extractMarkerValue(text, "call_id=") ??
    extractMarkerValue(text, '"call_id":"')
  );
}

function extractToolName(text) {
  return (
    extractMarkerValue(text, 'tool_name="') ??
    extractMarkerValue(text, "tool_name=") ??
    extractMarkerValue(text, "ToolCall: ")
  );
}

async function selectRecentThreadCandidates(stateSqlitePath, options = {}) {
  const queryOptions = options.queryOptions ?? options;
  const sql = [
    "select id, cwd",
    "from threads",
    "where archived = 0",
    "order by coalesce(updated_at_ms, updated_at * 1000) desc, updated_at desc",
    `limit ${options.threadCandidateLimit ?? DEFAULT_THREAD_CANDIDATE_SCAN_LIMIT}`
  ].join(" ");

  return querySqliteJson(stateSqlitePath, sql, queryOptions);
}

function pathMatchScore(target, candidate) {
  if (!target || !candidate) {
    return null;
  }

  const normalize = (value) => String(value).replace(/\\/g, "/");
  const targetPath = normalize(target);
  const candidatePath = normalize(candidate);
  const depth = candidatePath.split("/").filter(Boolean).length;

  if (targetPath === candidatePath) {
    return [3, depth];
  }

  if (targetPath.startsWith(`${candidatePath}/`) || targetPath === candidatePath) {
    return [2, depth];
  }

  if (candidatePath.startsWith(`${targetPath}/`) || candidatePath === targetPath) {
    return [1, depth];
  }

  return null;
}

async function selectActiveThreadId(stateSqlitePath, options = {}) {
  const candidates = await selectRecentThreadCandidates(stateSqlitePath, options);

  if (candidates.length === 0) {
    return null;
  }

  if (options.cwd) {
    let bestMatch = null;

    for (const candidate of candidates) {
      const score = pathMatchScore(options.cwd, candidate.cwd);
      if (!score) {
        continue;
      }

      if (
        !bestMatch ||
        score[0] > bestMatch.score[0] ||
        (score[0] === bestMatch.score[0] && score[1] > bestMatch.score[1])
      ) {
        bestMatch = {
          id: candidate.id,
          score
        };
      }
    }

    if (bestMatch) {
      return bestMatch.id;
    }
  }

  return candidates[0]?.id ?? null;
}

async function selectThreadEvents(logsSqlitePath, threadId, options = {}) {
  const queryOptions = options.queryOptions ?? options;
  const limit = options.limit ?? DEFAULT_SQLITE_EVENT_LIMIT;
  const bodyFilterSql = SIGNAL_BODY_FILTERS.map(
    (pattern) => `feedback_log_body like ${sqlLiteral(pattern)}`
  ).join(" or ");
  const threadBodyFilters = [
    `thread_id = ${sqlLiteral(threadId)}`,
    `feedback_log_body like ${sqlLiteral(`%conversation.id=${threadId}%`)}`,
    `feedback_log_body like ${sqlLiteral(`%thread_id=${threadId}%`)}`
  ].join(" or ");
  const sql = [
    "select ts, ts_nanos, thread_id, substr(feedback_log_body, 1, 1600) as feedback_log_body",
    "from logs",
    `where (${threadBodyFilters})`,
    "and feedback_log_body is not null",
    `and (${bodyFilterSql})`,
    "order by ts desc, ts_nanos desc, id desc",
    `limit ${limit}`
  ].join(" ");

  const rows = await querySqliteJson(logsSqlitePath, sql, queryOptions);
  return rows.reverse();
}

async function selectApprovalRows(logsSqlitePath, threadId, options = {}) {
  const queryOptions = options.queryOptions ?? options;
  const conversationPattern = `%conversation.id=${threadId}%`;
  const threadPattern = `%thread_id=${threadId}%`;
  const sql = [
    "select ts, ts_nanos, thread_id, substr(feedback_log_body, 1, 12000) as feedback_log_body",
    "from logs",
    `where (thread_id = ${sqlLiteral(threadId)}`,
    `or feedback_log_body like ${sqlLiteral(conversationPattern)}`,
    `or feedback_log_body like ${sqlLiteral(threadPattern)})`,
    "and feedback_log_body is not null",
    "and (",
    "(feedback_log_body like '%handle_output_item_done: ToolCall:%'",
    `and feedback_log_body like ${sqlLiteral('%"sandbox_permissions":"require_escalated"%')}`,
    `and feedback_log_body like ${sqlLiteral('%"justification":"%')})`,
    "or feedback_log_body like '%handle_output_item_done: ToolCall: mcp__%'",
    "or feedback_log_body like '%event.name=\"codex.tool_decision\"%'",
    "or feedback_log_body like '%event.name=\"codex.tool_result\"%'",
    ")",
    "order by ts desc, ts_nanos desc, id desc",
    `limit ${options.approvalLimit ?? DEFAULT_SQLITE_APPROVAL_LIMIT}`
  ].join(" ");

  return querySqliteJson(logsSqlitePath, sql, queryOptions);
}

function isApprovalRequest(text) {
  const toolCallIndex = text.indexOf("handle_output_item_done: ToolCall:");
  if (toolCallIndex === -1) {
    return false;
  }

  if (text.includes("handle_output_item_done: ToolCall: mcp__")) {
    return true;
  }

  const permissionIndex = text.indexOf(
    '"sandbox_permissions":"require_escalated"',
    toolCallIndex
  );
  if (permissionIndex === -1 || permissionIndex - toolCallIndex > 512) {
    return false;
  }

  return text.indexOf('"justification":"', permissionIndex) !== -1;
}

function isApprovalResolution(text) {
  return (
    text.includes('event.name="codex.tool_decision"') ||
    text.includes('event.name="codex.tool_result"')
  );
}

function pendingApprovalFromRows(rows, now) {
  const resolvedCallIds = new Set();
  const resolvedToolNames = new Set();
  let sawResolutionAfter = false;

  for (const row of rows) {
    const body = row.feedback_log_body ?? "";

    if (isApprovalResolution(body)) {
      sawResolutionAfter = true;
      const callId = extractCallId(body);
      const toolName = extractToolName(body);
      if (callId) {
        resolvedCallIds.add(callId);
      }
      if (toolName) {
        resolvedToolNames.add(toolName);
      }
      continue;
    }

    if (!isApprovalRequest(body)) {
      continue;
    }

    const event = {
      kind: "approval_required",
      at: eventTimeMs(row),
      threadId: row.thread_id ?? extractThreadId(body) ?? null
    };
    const callId = extractCallId(body);
    if (callId) {
      if (!resolvedCallIds.has(callId)) {
        return event;
      }
      continue;
    }

    const toolName = extractToolName(body);
    if (toolName) {
      if (resolvedToolNames.has(toolName)) {
        continue;
      }
    } else if (sawResolutionAfter) {
      continue;
    }

    if (now - event.at <= APPROVAL_PENDING_FALLBACK_MS) {
      return event;
    }
  }

  return null;
}

async function selectThreadStatus(logsSqlitePath, threadId, options = {}) {
  const now = options.now ?? Date.now();
  const runningStaleMs = options.runningStaleMs;
  const approvalRows = await selectApprovalRows(logsSqlitePath, threadId, options);
  const approvalEvent = pendingApprovalFromRows(approvalRows, now);

  if (approvalEvent) {
    return {
      latestRealEventAt: Math.max(
        approvalEvent.at,
        ...approvalRows.map((row) => eventTimeMs(row))
      ),
      snapshot: reduceEvent(createInitialStatus(now), approvalEvent, {
        runningStaleMs
      }),
      cwd: null,
      workspaceMatch: null
    };
  }

  const rows = await selectThreadEvents(logsSqlitePath, threadId, options);
  let status = createInitialStatus(options.initialNow ?? now);
  let latestRealEventAt = null;

  for (const row of rows) {
    const event = classifySqliteRow(row);
    if (!event) {
      continue;
    }

    latestRealEventAt = event.at;
    status = reduceEvent(status, event, { runningStaleMs });
  }

  return {
    latestRealEventAt,
    snapshot: deriveStatus(status, { now, runningStaleMs }),
    cwd: null,
    workspaceMatch: null
  };
}

function pickDominantSnapshot(snapshots, now) {
  let dominant = null;

  for (const snapshot of snapshots) {
    if (
      !dominant ||
      comparePriority(
        snapshotPriority(snapshot, now),
        snapshotPriority(dominant, now)
      ) > 0
    ) {
      dominant = snapshot;
    }
  }

  return dominant ?? createInitialStatus(now);
}

function workspaceRunningPreferredSnapshot(evaluations, options = {}) {
  if (!options.cwd || evaluations.length === 0) {
    return null;
  }

  const latestGlobalEventAt = Math.max(
    ...evaluations
      .map((evaluation) => evaluation.latestRealEventAt)
      .filter((value) => Number.isFinite(value))
  );

  if (!Number.isFinite(latestGlobalEventAt)) {
    return null;
  }

  const cutoff = latestGlobalEventAt - GLOBAL_WORKSPACE_PREFERENCE_GRACE_MS;
  let preferred = null;

  for (const evaluation of evaluations) {
    if (
      evaluation.snapshot.state !== LIGHT_STATES.RUNNING ||
      evaluation.snapshot.lastEventKind === "approval_required" ||
      !Number.isFinite(evaluation.latestRealEventAt) ||
      evaluation.latestRealEventAt < cutoff
    ) {
      continue;
    }

    const workspaceMatch =
      evaluation.workspaceMatch ??
      pathMatchScore(options.cwd, evaluation.cwd);
    if (!workspaceMatch) {
      continue;
    }

    const candidate = {
      ...evaluation,
      workspaceMatch
    };

    if (
      !preferred ||
      comparePriority(candidate.workspaceMatch, preferred.workspaceMatch) > 0 ||
      (comparePriority(candidate.workspaceMatch, preferred.workspaceMatch) === 0 &&
        candidate.latestRealEventAt > preferred.latestRealEventAt) ||
      (comparePriority(candidate.workspaceMatch, preferred.workspaceMatch) === 0 &&
        candidate.latestRealEventAt === preferred.latestRealEventAt &&
        comparePriority(
          snapshotPriority(candidate.snapshot, options.now ?? Date.now()),
          snapshotPriority(preferred.snapshot, options.now ?? Date.now())
        ) > 0)
    ) {
      preferred = candidate;
    }
  }

  return preferred?.snapshot ?? null;
}

function pickDominantEvaluation(evaluations, options = {}) {
  if (evaluations.length === 0) {
    return createInitialStatus(options.now ?? Date.now());
  }

  const now = options.now ?? Date.now();
  const dominant = pickDominantSnapshot(
    evaluations.map((item) => item.snapshot),
    now
  );

  if (
    dominant.state === LIGHT_STATES.RUNNING &&
    dominant.lastEventKind !== "approval_required"
  ) {
    const preferred = workspaceRunningPreferredSnapshot(evaluations, {
      cwd: options.cwd,
      now
    });
    if (preferred) {
      return preferred;
    }
  }

  return dominant;
}

export function defaultLogsSqlitePath(options = {}) {
  return resolveSignalFiles(options).logsSqlite;
}

export function defaultStateSqlitePath(options = {}) {
  return resolveSignalFiles(options).stateSqlite;
}

export async function deriveStatusFromSqliteFiles(logsSqlitePath, stateSqlitePath, options = {}) {
  const now = options.now ?? Date.now();
  const runningStaleMs = options.runningStaleMs;
  const initialNow = options.initialNow ?? now;
  const scope = normalizeScope(options.scope);

  if (options.threadId) {
    return (await selectThreadStatus(logsSqlitePath, options.threadId, options)).snapshot;
  }

  if (scope === "workspace") {
    const threadId = await selectActiveThreadId(stateSqlitePath, options);
    if (!threadId) {
      return createInitialStatus(initialNow);
    }

    return (await selectThreadStatus(logsSqlitePath, threadId, options)).snapshot;
  }

  const cutoff = now - globalThreadWindowMs(options);
  const candidates = await selectRecentThreadCandidates(stateSqlitePath, options);
  const evaluations = [];

  for (const candidate of candidates) {
    const evaluation = await selectThreadStatus(
      logsSqlitePath,
      candidate.id,
      options
    );
    if (evaluation.latestRealEventAt === null || evaluation.latestRealEventAt < cutoff) {
      continue;
    }

    evaluations.push({
      ...evaluation,
      cwd: candidate.cwd ?? null,
      workspaceMatch: pathMatchScore(options.cwd, candidate.cwd)
    });
  }

  evaluations.sort((left, right) => {
    if (left.latestRealEventAt !== right.latestRealEventAt) {
      return right.latestRealEventAt - left.latestRealEventAt;
    }

    return comparePriority(
      snapshotPriority(right.snapshot, now),
      snapshotPriority(left.snapshot, now)
    );
  });

  if (evaluations.length === 0) {
    return createInitialStatus(initialNow);
  }

  return pickDominantEvaluation(evaluations, options);
}

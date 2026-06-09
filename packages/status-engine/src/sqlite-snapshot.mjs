import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveSignalFiles } from "./codex-paths.mjs";
import { classifyLogText } from "./log-events.mjs";
import { createInitialStatus, deriveStatus, reduceEvent } from "./status-machine.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_SQLITE_EVENT_LIMIT = 120;
const SIGNAL_BODY_FILTERS = [
  "%Turn error%",
  "%interrupt received%",
  "%turn-ended%",
  "%retrying sampling request%",
  "%session_task.turn%",
  "%response.completed%",
  "%response.in_progress%",
  "%response.output_item.added%",
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
    threadId: row.thread_id ?? event.threadId ?? null,
    raw: body
  };
}

async function selectActiveThreadId(stateSqlitePath, options = {}) {
  const queryOptions = options.queryOptions ?? options;
  const cwd = options.cwd;
  const where = ["archived = 0"];

  if (cwd) {
    where.push(`cwd = ${sqlLiteral(cwd)}`);
  }

  const sql = [
    "select id",
    "from threads",
    `where ${where.join(" and ")}`,
    "order by updated_at_ms desc",
    "limit 1"
  ].join(" ");

  const rows = await querySqliteJson(stateSqlitePath, sql, queryOptions);
  return rows[0]?.id ?? null;
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

  let threadId = options.threadId ?? null;

  if (!threadId) {
    threadId = await selectActiveThreadId(stateSqlitePath, options);
  }

  if (!threadId && options.cwd) {
    threadId = await selectActiveThreadId(stateSqlitePath, {
      ...options,
      cwd: undefined
    });
  }

  if (!threadId) {
    return createInitialStatus(initialNow);
  }

  const rows = await selectThreadEvents(logsSqlitePath, threadId, options);
  let status = createInitialStatus(initialNow);

  for (const row of rows) {
    const event = classifySqliteRow(row);
    if (!event) {
      continue;
    }

    status = reduceEvent(status, event, { runningStaleMs });
  }

  return deriveStatus(status, { now, runningStaleMs });
}

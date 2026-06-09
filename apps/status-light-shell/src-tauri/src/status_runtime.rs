use chrono::DateTime;
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    env, fs, io,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const STATE_IDLE: &str = "idle";
const STATE_RUNNING: &str = "running";
const STATE_ATTENTION: &str = "attention";

const COLOR_GREEN: &str = "green";
const COLOR_YELLOW: &str = "yellow";
const COLOR_RED: &str = "red";
const COLOR_NEUTRAL: &str = "neutral";

const EVENT_STARTUP: &str = "startup";
const EVENT_UNAVAILABLE: &str = "unavailable";
const EVENT_COOLDOWN: &str = "cooldown";
const EVENT_TURN_COMPLETED: &str = "turn_completed";
const EVENT_TURN_STARTED: &str = "turn_started";
const EVENT_THINKING: &str = "thinking";
const EVENT_TOOL_RUNNING: &str = "tool_running";
const EVENT_REPLYING: &str = "replying";
const EVENT_NETWORK_RETRY: &str = "network_retry";
const EVENT_APPROVAL_REQUIRED: &str = "approval_required";
const EVENT_INTERRUPT: &str = "interrupt";
const EVENT_AUTH_ERROR: &str = "auth_error";
const EVENT_RATE_LIMITED: &str = "rate_limited";
const EVENT_TURN_ERROR: &str = "turn_error";
const EVENT_ATTENTION_CLEARED: &str = "attention_cleared";
const EVENT_STALLED: &str = "stalled";
const EVENT_RUNNING: &str = "running";

const DEFAULT_RUNNING_STALE_MS: u64 = 180_000;
const DEFAULT_COMPLETION_HOLD_MS: u64 = 3_000;
const DEFAULT_INTERRUPT_HOLD_MS: u64 = 4_000;
const DEFAULT_ERROR_HOLD_MS: u64 = 10_000;
const DEFAULT_SQLITE_EVENT_LIMIT: usize = 120;
const DEFAULT_SQLITE_APPROVAL_LIMIT: usize = 80;
const DEFAULT_GLOBAL_THREAD_LIMIT: usize = 8;
const DEFAULT_GLOBAL_THREAD_WINDOW_MS: u64 = 600_000;
const APPROVAL_PENDING_FALLBACK_MS: u64 = 60_000;
const RETRY_STALE_MS: u64 = 45_000;
const ACTIVE_PHASE_STALE_MS: u64 = 120_000;
const DOMINANT_RUNNING_FRESH_MS: u64 = 20_000;
const DOMINANT_ATTENTION_FRESH_MS: u64 = 15_000;

const SIGNAL_BODY_FILTERS: [&str; 10] = [
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
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StatusSnapshot {
    pub state: String,
    pub color: String,
    pub reason: String,
    #[serde(rename = "lastEventKind")]
    pub last_event_kind: String,
    #[serde(rename = "lastEventAt")]
    pub last_event_at: u64,
    #[serde(rename = "threadId")]
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone)]
struct StatusEvent {
    kind: &'static str,
    at: u64,
    thread_id: Option<String>,
}

#[derive(Debug)]
struct LogRow {
    ts: i64,
    ts_nanos: i64,
    thread_id: Option<String>,
    feedback_log_body: String,
}

#[derive(Debug)]
struct ThreadCandidate {
    id: String,
    cwd: PathBuf,
    updated_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ThreadScope {
    Global,
    Workspace,
}

pub fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_millis() as u64
}

pub fn codex_home_path() -> PathBuf {
    if let Some(path) = env::var_os("CODEX_HOME") {
        return PathBuf::from(path);
    }

    if let Some(path) = env::var_os("HOME") {
        return PathBuf::from(path).join(".codex");
    }

    if let Some(path) = env::var_os("USERPROFILE") {
        return PathBuf::from(path).join(".codex");
    }

    PathBuf::from(".codex")
}

pub fn codex_log_path() -> PathBuf {
    codex_home_path().join("log").join("codex-tui.log")
}

fn codex_logs_sqlite_path() -> PathBuf {
    codex_home_path().join("logs_2.sqlite")
}

fn codex_state_sqlite_path() -> PathBuf {
    codex_home_path().join("state_5.sqlite")
}

pub fn snapshot_path() -> PathBuf {
    if let Some(path) = env::var_os("CODEX_STATUS_LIGHT_SNAPSHOT") {
        return PathBuf::from(path);
    }

    codex_home_path()
        .join("status-light")
        .join("current-status.json")
}

fn unavailable_snapshot(reason: impl Into<String>, at: u64) -> StatusSnapshot {
    StatusSnapshot {
        state: "unknown".into(),
        color: COLOR_NEUTRAL.into(),
        reason: reason.into(),
        last_event_kind: EVENT_UNAVAILABLE.into(),
        last_event_at: at,
        thread_id: None,
    }
}

impl StatusSnapshot {
    pub fn unavailable(reason: impl Into<String>) -> Self {
        unavailable_snapshot(reason, current_time_ms())
    }

    pub fn missing(reason: impl Into<String>) -> Self {
        Self::unavailable(reason)
    }
}

fn snapshot_for(
    state: &str,
    reason: impl Into<String>,
    last_event_kind: &str,
    last_event_at: u64,
    thread_id: Option<String>,
) -> StatusSnapshot {
    let color = match state {
        STATE_IDLE => COLOR_GREEN,
        STATE_RUNNING => COLOR_YELLOW,
        STATE_ATTENTION => COLOR_RED,
        _ => COLOR_NEUTRAL,
    };

    StatusSnapshot {
        state: state.into(),
        color: color.into(),
        reason: reason.into(),
        last_event_kind: last_event_kind.into(),
        last_event_at,
        thread_id,
    }
}

fn create_initial_status(now: u64) -> StatusSnapshot {
    snapshot_for(
        STATE_IDLE,
        "waiting for Codex activity",
        EVENT_STARTUP,
        now,
        None,
    )
}

fn create_no_recent_activity_status(now: u64) -> StatusSnapshot {
    snapshot_for(
        STATE_IDLE,
        "No recent Codex activity was found",
        EVENT_STARTUP,
        now,
        None,
    )
}

fn no_local_codex_data_snapshot(now: u64) -> StatusSnapshot {
    unavailable_snapshot("No local Codex runtime data was found on this machine", now)
}

fn no_local_threads_snapshot(now: u64) -> StatusSnapshot {
    unavailable_snapshot(
        "Codex has not created any local threads on this machine yet",
        now,
    )
}

fn debug_scenario_snapshot_named(name: &str, now: u64) -> Option<StatusSnapshot> {
    let scenario = name.trim().to_ascii_lowercase();
    let thread_id = Some(format!("debug-{scenario}"));

    match scenario.as_str() {
        "green" | "idle" | "ready" => Some(snapshot_for(
            STATE_IDLE,
            "Debug scenario: Codex is idle and ready",
            EVENT_TURN_COMPLETED,
            now,
            thread_id,
        )),
        "yellow" | "working" | "thinking" => Some(snapshot_for(
            STATE_RUNNING,
            "Debug scenario: Codex is thinking",
            EVENT_THINKING,
            now,
            thread_id,
        )),
        "tools" | "tool" => Some(snapshot_for(
            STATE_RUNNING,
            "Debug scenario: Codex is running tools",
            EVENT_TOOL_RUNNING,
            now,
            thread_id,
        )),
        "replying" | "reply" => Some(snapshot_for(
            STATE_RUNNING,
            "Debug scenario: Codex is writing the reply",
            EVENT_REPLYING,
            now,
            thread_id,
        )),
        "approval" | "approve" => Some(snapshot_for(
            STATE_RUNNING,
            "Debug scenario: waiting for your approval",
            EVENT_APPROVAL_REQUIRED,
            now,
            thread_id,
        )),
        "retry" | "network" => Some(snapshot_for(
            STATE_RUNNING,
            "Debug scenario: Codex is retrying the model request",
            EVENT_NETWORK_RETRY,
            now,
            thread_id,
        )),
        "red" | "error" | "attention" => Some(snapshot_for(
            STATE_ATTENTION,
            "Debug scenario: Codex hit a turn error",
            EVENT_TURN_ERROR,
            now,
            thread_id,
        )),
        "stalled" => Some(snapshot_for(
            STATE_ATTENTION,
            "Debug scenario: Codex appears stalled",
            EVENT_STALLED,
            now,
            thread_id,
        )),
        "auth" => Some(snapshot_for(
            STATE_ATTENTION,
            "Debug scenario: Codex authentication failed",
            EVENT_AUTH_ERROR,
            now,
            thread_id,
        )),
        "rate-limit" | "ratelimit" | "limit" => Some(snapshot_for(
            STATE_ATTENTION,
            "Debug scenario: Codex hit a rate limit",
            EVENT_RATE_LIMITED,
            now,
            thread_id,
        )),
        "interrupt" => Some(snapshot_for(
            STATE_ATTENTION,
            "Debug scenario: turn was interrupted",
            EVENT_INTERRUPT,
            now,
            thread_id,
        )),
        "neutral" | "unavailable" => Some(unavailable_snapshot(
            "Debug scenario: runtime signal unavailable",
            now,
        )),
        _ => None,
    }
}

fn debug_scenario_snapshot(now: u64) -> Option<StatusSnapshot> {
    env::var("CODEX_STATUS_LIGHT_DEBUG_SCENARIO")
        .ok()
        .and_then(|value| {
            debug_scenario_snapshot_named(&value, now).or_else(|| {
                Some(unavailable_snapshot(
                    format!(
                        "Unknown debug scenario: {value}. Try green, yellow, approval, red, stalled, or neutral"
                    ),
                    now,
                ))
            })
        })
}

fn running_reason(kind: &str) -> &'static str {
    match kind {
        EVENT_TURN_STARTED => "Codex started a new turn",
        EVENT_THINKING => "Codex is thinking",
        EVENT_TOOL_RUNNING => "Codex is running tools",
        EVENT_REPLYING => "Codex is writing the reply",
        EVENT_NETWORK_RETRY => "Codex is retrying the model request",
        EVENT_APPROVAL_REQUIRED => "waiting for your approval",
        _ => "Codex is actively working",
    }
}

fn attention_reason(kind: &str) -> &'static str {
    match kind {
        EVENT_INTERRUPT => "turn was interrupted",
        EVENT_AUTH_ERROR => "Codex authentication failed",
        EVENT_RATE_LIMITED => "Codex hit a rate limit",
        _ => "Codex hit a turn error",
    }
}

fn stalled_reason(last_event_kind: &str) -> &'static str {
    match last_event_kind {
        EVENT_NETWORK_RETRY => "Codex has been retrying for too long",
        EVENT_THINKING => "thinking has been quiet for too long",
        EVENT_TOOL_RUNNING => "tool execution has been quiet for too long",
        EVENT_REPLYING => "reply generation has been quiet for too long",
        EVENT_TURN_STARTED | EVENT_RUNNING => "Codex started work but no fresh output arrived",
        _ => "Codex appears stalled",
    }
}

fn running_stale_ms(last_event_kind: &str) -> u64 {
    match last_event_kind {
        EVENT_NETWORK_RETRY => RETRY_STALE_MS,
        EVENT_TURN_STARTED | EVENT_THINKING | EVENT_REPLYING | EVENT_RUNNING => {
            ACTIVE_PHASE_STALE_MS
        }
        _ => DEFAULT_RUNNING_STALE_MS,
    }
}

fn idle_reason_after_attention(kind: &str) -> &'static str {
    match kind {
        EVENT_INTERRUPT => "waiting for the next turn",
        EVENT_AUTH_ERROR => "last authentication issue is no longer active",
        EVENT_RATE_LIMITED => "last rate limit is no longer active",
        _ => "last turn error is no longer active",
    }
}

fn is_transient_attention(kind: &str) -> bool {
    matches!(
        kind,
        EVENT_INTERRUPT | EVENT_AUTH_ERROR | EVENT_RATE_LIMITED | EVENT_TURN_ERROR
    )
}

fn attention_hold_ms(kind: &str) -> Option<u64> {
    match kind {
        EVENT_INTERRUPT => Some(DEFAULT_INTERRUPT_HOLD_MS),
        EVENT_AUTH_ERROR | EVENT_RATE_LIMITED | EVENT_TURN_ERROR => Some(DEFAULT_ERROR_HOLD_MS),
        _ => None,
    }
}

fn reduce_event(current_status: &StatusSnapshot, event: StatusEvent) -> StatusSnapshot {
    let thread_id = event
        .thread_id
        .clone()
        .or_else(|| current_status.thread_id.clone());

    match event.kind {
        EVENT_TURN_COMPLETED => snapshot_for(
            STATE_RUNNING,
            "Codex just finished; holding yellow briefly",
            EVENT_COOLDOWN,
            event.at,
            thread_id,
        ),
        EVENT_TURN_STARTED
        | EVENT_THINKING
        | EVENT_TOOL_RUNNING
        | EVENT_REPLYING
        | EVENT_NETWORK_RETRY
        | EVENT_APPROVAL_REQUIRED
        | EVENT_RUNNING => snapshot_for(
            STATE_RUNNING,
            running_reason(event.kind),
            event.kind,
            event.at,
            thread_id,
        ),
        EVENT_INTERRUPT | EVENT_AUTH_ERROR | EVENT_RATE_LIMITED | EVENT_TURN_ERROR => snapshot_for(
            STATE_ATTENTION,
            attention_reason(event.kind),
            event.kind,
            event.at,
            thread_id,
        ),
        _ => derive_status(current_status, event.at),
    }
}

fn derive_status(current_status: &StatusSnapshot, now: u64) -> StatusSnapshot {
    let age_ms = now.saturating_sub(current_status.last_event_at);

    if current_status.last_event_kind == EVENT_COOLDOWN {
        if age_ms <= DEFAULT_COMPLETION_HOLD_MS {
            return current_status.clone();
        }

        return snapshot_for(
            STATE_IDLE,
            "turn completed",
            EVENT_TURN_COMPLETED,
            current_status.last_event_at,
            current_status.thread_id.clone(),
        );
    }

    if current_status.last_event_kind == EVENT_APPROVAL_REQUIRED {
        return current_status.clone();
    }

    if current_status.state == STATE_RUNNING
        && age_ms > running_stale_ms(&current_status.last_event_kind)
    {
        return snapshot_for(
            STATE_ATTENTION,
            stalled_reason(&current_status.last_event_kind),
            EVENT_STALLED,
            current_status.last_event_at,
            current_status.thread_id.clone(),
        );
    }

    if current_status.state == STATE_ATTENTION
        && is_transient_attention(&current_status.last_event_kind)
    {
        if let Some(hold_ms) = attention_hold_ms(&current_status.last_event_kind) {
            if age_ms > hold_ms {
                return snapshot_for(
                    STATE_IDLE,
                    idle_reason_after_attention(&current_status.last_event_kind),
                    EVENT_ATTENTION_CLEARED,
                    current_status.last_event_at,
                    current_status.thread_id.clone(),
                );
            }
        }
    }

    current_status.clone()
}

fn extract_timestamp_ms(text: &str) -> Option<u64> {
    let first_token = text.split_whitespace().next()?;
    let parsed = DateTime::parse_from_rfc3339(first_token).ok()?;
    Some(parsed.timestamp_millis() as u64)
}

fn extract_marker_value(text: &str, marker: &str) -> Option<String> {
    let start = text.find(marker)? + marker.len();
    let suffix = &text[start..];
    let value: String = suffix
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || matches!(*ch, '-' | '_'))
        .collect();

    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn extract_thread_id(text: &str) -> Option<String> {
    extract_marker_value(text, "thread_id=").or_else(|| extract_marker_value(text, "conversation.id="))
}

fn extract_call_id(text: &str) -> Option<String> {
    extract_marker_value(text, "call_id=\"")
        .or_else(|| extract_marker_value(text, "call_id="))
        .or_else(|| extract_marker_value(text, "\"call_id\":\""))
}

fn classify_log_text(text: &str) -> Option<&'static str> {
    if text.contains("Turn error") && text.contains("Unauthorized") {
        return Some(EVENT_AUTH_ERROR);
    }

    if text.contains("Turn error") && text.contains("Invalid API Key") {
        return Some(EVENT_AUTH_ERROR);
    }

    if text.contains("Turn error") && text.contains("429") {
        return Some(EVENT_RATE_LIMITED);
    }

    if text.contains("interrupt received") {
        return Some(EVENT_INTERRUPT);
    }

    if text.contains("retrying sampling request") {
        return Some(EVENT_NETWORK_RETRY);
    }

    if text.contains("Turn error") {
        return Some(EVENT_TURN_ERROR);
    }

    if text.contains("response.completed") || text.contains("turn-ended") {
        return Some(EVENT_TURN_COMPLETED);
    }

    if text.contains("response.output_item.added") && text.contains("\"type\":\"function_call\"") {
        return Some(EVENT_TOOL_RUNNING);
    }

    if text.contains("response.function_call_arguments.delta") {
        return Some(EVENT_TOOL_RUNNING);
    }

    if text.contains("response.output_item.added") && text.contains("\"type\":\"message\"") {
        return Some(EVENT_REPLYING);
    }

    if text.contains("response.output_text.delta") {
        return Some(EVENT_REPLYING);
    }

    if text.contains("response.output_item.added") && text.contains("\"type\":\"reasoning\"") {
        return Some(EVENT_THINKING);
    }

    if text.contains("response.in_progress") {
        return Some(EVENT_THINKING);
    }

    if text.contains("response.output_item.done") {
        return Some(EVENT_RUNNING);
    }

    if text.contains("session_task.turn") && text.contains("codex_core::tasks: new") {
        return Some(EVENT_TURN_STARTED);
    }

    None
}

fn classify_log_line(line: &str) -> Option<StatusEvent> {
    let kind = classify_log_text(line)?;
    Some(StatusEvent {
        kind,
        at: extract_timestamp_ms(line).unwrap_or_else(current_time_ms),
        thread_id: extract_thread_id(line),
    })
}

fn derive_status_from_log_file(path: &Path, now: u64) -> Result<StatusSnapshot, String> {
    let log_text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(unavailable_snapshot(
                "No local Codex log file was found on this machine",
                now,
            ));
        }
        Err(error) => {
            return Err(format!("failed to read {}: {error}", path.display()));
        }
    };

    if log_text.trim().is_empty() {
        return Ok(unavailable_snapshot(
            "Codex log exists, but it does not contain runtime events yet",
            now,
        ));
    }

    let mut status = create_initial_status(now);
    let mut saw_event = false;

    for line in log_text.lines() {
        if let Some(event) = classify_log_line(line) {
            saw_event = true;
            status = reduce_event(&status, event);
        }
    }

    if !saw_event {
        return Ok(unavailable_snapshot(
            "Codex log does not contain a recognizable runtime event yet",
            now,
        ));
    }

    Ok(derive_status(&status, now))
}

fn open_sqlite_readonly(path: &Path) -> Result<Connection, String> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let connection = Connection::open_with_flags(path, flags)
        .map_err(|error| format!("failed to open {}: {error}", path.display()))?;
    let _ = connection.busy_timeout(Duration::from_millis(200));
    Ok(connection)
}

fn thread_scope_from_env() -> ThreadScope {
    match env::var("CODEX_STATUS_LIGHT_SCOPE") {
        Ok(value) if matches!(value.trim().to_ascii_lowercase().as_str(), "workspace" | "cwd" | "project") => {
            ThreadScope::Workspace
        }
        _ => ThreadScope::Global,
    }
}

fn global_thread_window_ms_from_env() -> u64 {
    env::var("CODEX_STATUS_LIGHT_GLOBAL_WINDOW_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|value| value.max(DEFAULT_RUNNING_STALE_MS + DEFAULT_ERROR_HOLD_MS))
        .unwrap_or(DEFAULT_GLOBAL_THREAD_WINDOW_MS)
}

fn select_recent_thread_candidates(
    connection: &Connection,
    limit: usize,
) -> Result<Vec<ThreadCandidate>, String> {
    let sql = format!(
        "select id, cwd, coalesce(updated_at_ms, updated_at * 1000) as updated_at_ms \
         from threads \
         where archived = 0 \
         order by updated_at_ms desc, updated_at desc \
         limit {limit}"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("failed to prepare recent thread lookup: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(ThreadCandidate {
                id: row.get(0)?,
                cwd: PathBuf::from(row.get::<_, String>(1)?),
                updated_at_ms: row.get::<_, i64>(2)?.max(0) as u64,
            })
        })
        .map_err(|error| format!("failed to query recent thread candidates: {error}"))?;

    let mut candidates = Vec::new();
    for row in rows {
        candidates.push(row.map_err(|error| format!("failed to decode recent thread candidate: {error}"))?);
    }
    Ok(candidates)
}

fn path_match_score(target: &Path, candidate: &Path) -> Option<(u8, usize)> {
    let depth = candidate.components().count();

    if target == candidate {
        return Some((3, depth));
    }

    if target.starts_with(candidate) {
        return Some((2, depth));
    }

    if candidate.starts_with(target) {
        return Some((1, depth));
    }

    None
}

fn select_active_thread_id(
    connection: &Connection,
    cwd: Option<&Path>,
) -> Result<Option<String>, String> {
    let candidates = select_recent_thread_candidates(connection, 200)?;

    if candidates.is_empty() {
        return Ok(None);
    }

    if let Some(target_cwd) = cwd {
        let mut best_match: Option<(u8, usize, String)> = None;

        for candidate in &candidates {
            let Some((priority, depth)) = path_match_score(target_cwd, &candidate.cwd) else {
                continue;
            };

            let should_replace = match &best_match {
                Some((best_priority, best_depth, _)) => {
                    priority > *best_priority || (priority == *best_priority && depth > *best_depth)
                }
                None => true,
            };

            if should_replace {
                best_match = Some((priority, depth, candidate.id.clone()));
            }
        }

        if let Some((_, _, thread_id)) = best_match {
            return Ok(Some(thread_id));
        }
    }

    Ok(candidates.into_iter().next().map(|candidate| candidate.id))
}

fn has_any_unarchived_threads(connection: &Connection) -> Result<bool, String> {
    connection
        .query_row(
            "select exists(select 1 from threads where archived = 0 limit 1)",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(|error| format!("failed to detect whether Codex has local threads: {error}"))
}

fn select_tracked_thread_ids(
    connection: &Connection,
    cwd: Option<&Path>,
    now: u64,
) -> Result<Vec<String>, String> {
    match thread_scope_from_env() {
        ThreadScope::Workspace => Ok(select_active_thread_id(connection, cwd)?.into_iter().collect()),
        ThreadScope::Global => {
            let cutoff = now.saturating_sub(global_thread_window_ms_from_env());
            let thread_ids = select_recent_thread_candidates(connection, DEFAULT_GLOBAL_THREAD_LIMIT)?
                .into_iter()
                .filter(|candidate| candidate.updated_at_ms >= cutoff)
                .map(|candidate| candidate.id)
                .collect::<Vec<_>>();

            Ok(thread_ids)
        }
    }
}

fn sql_pattern(pattern: &str) -> String {
    format!("'{}'", pattern.replace('\'', "''"))
}

fn select_thread_rows(
    connection: &Connection,
    thread_id: &str,
) -> Result<Vec<LogRow>, String> {
    let body_filter_sql = SIGNAL_BODY_FILTERS
        .iter()
        .map(|pattern| format!("feedback_log_body like {}", sql_pattern(pattern)))
        .collect::<Vec<_>>()
        .join(" or ");
    let conversation_pattern = format!("%conversation.id={thread_id}%");
    let thread_pattern = format!("%thread_id={thread_id}%");
    let sql = format!(
        "select ts, ts_nanos, thread_id, substr(feedback_log_body, 1, 1600) as feedback_log_body \
         from logs \
         where (thread_id = ?1 or feedback_log_body like ?2 or feedback_log_body like ?3) \
         and feedback_log_body is not null \
         and ({body_filter_sql}) \
         order by ts desc, ts_nanos desc, id desc \
         limit {DEFAULT_SQLITE_EVENT_LIMIT}"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("failed to prepare log query: {error}"))?;
    let rows = statement
        .query_map(
            params![thread_id, conversation_pattern, thread_pattern],
            |row| {
                Ok(LogRow {
                    ts: row.get(0)?,
                    ts_nanos: row.get(1)?,
                    thread_id: row.get(2)?,
                    feedback_log_body: row.get(3)?,
                })
            },
        )
        .map_err(|error| format!("failed to query log rows: {error}"))?;

    let mut collected = Vec::new();
    for row in rows {
        collected.push(row.map_err(|error| format!("failed to decode log row: {error}"))?);
    }
    collected.reverse();
    Ok(collected)
}

fn select_approval_rows(
    connection: &Connection,
    thread_id: &str,
) -> Result<Vec<LogRow>, String> {
    let conversation_pattern = format!("%conversation.id={thread_id}%");
    let thread_pattern = format!("%thread_id={thread_id}%");
    let sql = format!(
        "select ts, ts_nanos, thread_id, substr(feedback_log_body, 1, 2400) as feedback_log_body \
         from logs \
         where (thread_id = ?1 or feedback_log_body like ?2 or feedback_log_body like ?3) \
         and feedback_log_body is not null \
         and ( \
             (feedback_log_body like '%handle_output_item_done: ToolCall:%' and feedback_log_body like '%sandbox_permissions%require_escalated%') \
             or feedback_log_body like '%event.name=\"codex.tool_decision\"%' \
             or feedback_log_body like '%event.name=\"codex.tool_result\"%' \
         ) \
         order by ts desc, ts_nanos desc, id desc \
         limit {DEFAULT_SQLITE_APPROVAL_LIMIT}"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("failed to prepare approval query: {error}"))?;
    let rows = statement
        .query_map(
            params![thread_id, conversation_pattern, thread_pattern],
            |row| {
                Ok(LogRow {
                    ts: row.get(0)?,
                    ts_nanos: row.get(1)?,
                    thread_id: row.get(2)?,
                    feedback_log_body: row.get(3)?,
                })
            },
        )
        .map_err(|error| format!("failed to query approval rows: {error}"))?;

    let mut collected = Vec::new();
    for row in rows {
        collected.push(row.map_err(|error| format!("failed to decode approval row: {error}"))?);
    }
    Ok(collected)
}

fn is_approval_request(text: &str) -> bool {
    text.contains("handle_output_item_done: ToolCall:")
        && text.contains("sandbox_permissions")
        && text.contains("require_escalated")
}

fn is_approval_resolution(text: &str) -> bool {
    text.contains("event.name=\"codex.tool_decision\"")
        || text.contains("event.name=\"codex.tool_result\"")
}

fn pending_approval_from_rows(rows: &[LogRow], now: u64) -> Option<StatusEvent> {
    let mut resolved_call_ids = HashSet::new();

    for row in rows {
        if is_approval_resolution(&row.feedback_log_body) {
            if let Some(call_id) = extract_call_id(&row.feedback_log_body) {
                resolved_call_ids.insert(call_id);
            }
            continue;
        }

        if !is_approval_request(&row.feedback_log_body) {
            continue;
        }

        let event = StatusEvent {
            kind: EVENT_APPROVAL_REQUIRED,
            at: event_time_ms(row),
            thread_id: row
                .thread_id
                .clone()
                .or_else(|| extract_thread_id(&row.feedback_log_body)),
        };

        if let Some(call_id) = extract_call_id(&row.feedback_log_body) {
            if !resolved_call_ids.contains(&call_id) {
                return Some(event);
            }
            continue;
        }

        if now.saturating_sub(event.at) <= APPROVAL_PENDING_FALLBACK_MS {
            return Some(event);
        }
    }

    None
}

fn event_time_ms(row: &LogRow) -> u64 {
    (row.ts as u64) * 1000 + ((row.ts_nanos.max(0) as u64) / 1_000_000)
}

fn derive_status_for_thread(
    connection: &Connection,
    thread_id: &str,
    now: u64,
) -> Result<StatusSnapshot, String> {
    if let Some(approval_event) =
        pending_approval_from_rows(&select_approval_rows(connection, thread_id)?, now)
    {
        return Ok(reduce_event(&create_initial_status(now), approval_event));
    }

    let rows = select_thread_rows(connection, thread_id)?;
    let mut status = create_initial_status(now);

    for row in rows {
        let Some(kind) = classify_log_text(&row.feedback_log_body) else {
            continue;
        };
        status = reduce_event(
            &status,
            StatusEvent {
                kind,
                at: event_time_ms(&row),
                thread_id: row.thread_id.or_else(|| extract_thread_id(&row.feedback_log_body)),
            },
        );
    }

    Ok(derive_status(&status, now))
}

fn freshness_priority(age_ms: u64) -> u8 {
    match age_ms {
        0..=5_000 => 4,
        5_001..=15_000 => 3,
        15_001..=60_000 => 2,
        _ => 1,
    }
}

fn snapshot_priority(snapshot: &StatusSnapshot, now: u64) -> (u8, u8, u64) {
    let age_ms = now.saturating_sub(snapshot.last_event_at);
    let state_priority = match snapshot.state.as_str() {
        STATE_ATTENTION if snapshot.last_event_kind != EVENT_STALLED => 6,
        STATE_ATTENTION if age_ms <= DOMINANT_ATTENTION_FRESH_MS => 5,
        STATE_RUNNING if snapshot.last_event_kind == EVENT_APPROVAL_REQUIRED => 4,
        STATE_RUNNING if age_ms <= DOMINANT_RUNNING_FRESH_MS => 3,
        STATE_ATTENTION => 2,
        STATE_RUNNING => 1,
        STATE_IDLE => 0,
        _ => 0,
    };
    (state_priority, freshness_priority(age_ms), snapshot.last_event_at)
}

fn pick_dominant_snapshot(
    snapshots: impl IntoIterator<Item = StatusSnapshot>,
    now: u64,
) -> StatusSnapshot {
    let mut dominant: Option<StatusSnapshot> = None;

    for snapshot in snapshots {
        let should_replace = match dominant.as_ref() {
            Some(current) => snapshot_priority(&snapshot, now) > snapshot_priority(current, now),
            None => true,
        };

        if should_replace {
            dominant = Some(snapshot);
        }
    }

    dominant.unwrap_or_else(|| StatusSnapshot::unavailable("Status temporarily unavailable"))
}

fn derive_status_from_sqlite(
    logs_path: &Path,
    state_path: &Path,
    cwd: Option<&Path>,
    now: u64,
) -> Result<StatusSnapshot, String> {
    if !logs_path.exists() || !state_path.exists() {
        return Err("sqlite signal files are not available".into());
    }

    let state_connection = open_sqlite_readonly(state_path)?;
    let thread_ids = select_tracked_thread_ids(&state_connection, cwd, now)?;
    if thread_ids.is_empty() {
        return Ok(if has_any_unarchived_threads(&state_connection)? {
            create_no_recent_activity_status(now)
        } else {
            no_local_threads_snapshot(now)
        });
    }

    let logs_connection = open_sqlite_readonly(logs_path)?;
    let mut snapshots = Vec::new();
    let mut errors = Vec::new();

    for thread_id in thread_ids {
        match derive_status_for_thread(&logs_connection, &thread_id, now) {
            Ok(snapshot) => snapshots.push(snapshot),
            Err(error) => errors.push(format!("{thread_id}: {error}")),
        }
    }

    if snapshots.is_empty() && !errors.is_empty() {
        return Ok(StatusSnapshot::unavailable(format!(
            "Status temporarily unavailable: {}",
            errors[0]
        )));
    }

    Ok(pick_dominant_snapshot(snapshots, now))
}

fn target_workspace_cwd() -> Option<PathBuf> {
    if let Some(path) = env::var_os("CODEX_STATUS_LIGHT_CWD") {
        return Some(PathBuf::from(path));
    }

    env::current_dir().ok()
}

pub fn read_status_snapshot() -> Result<StatusSnapshot, String> {
    let now = current_time_ms();

    if let Some(snapshot) = debug_scenario_snapshot(now) {
        return Ok(snapshot);
    }

    let cwd = target_workspace_cwd();
    let logs_path = codex_logs_sqlite_path();
    let state_path = codex_state_sqlite_path();
    let log_path = codex_log_path();

    if !logs_path.exists() && !state_path.exists() && !log_path.exists() {
        return Ok(no_local_codex_data_snapshot(now));
    }

    match derive_status_from_sqlite(&logs_path, &state_path, cwd.as_deref(), now) {
        Ok(snapshot) => Ok(snapshot),
        Err(sqlite_error) => {
            eprintln!("sqlite signal fallback to log file: {sqlite_error}");
            match derive_status_from_log_file(&log_path, now) {
                Ok(snapshot) => Ok(snapshot),
                Err(log_error) => Ok(StatusSnapshot::missing(format!(
                    "Status unavailable: {log_error}"
                ))),
            }
        }
    }
}

pub fn write_snapshot_file(snapshot: &StatusSnapshot) -> Result<PathBuf, String> {
    let path = snapshot_path();
    let dir = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    fs::create_dir_all(&dir)
        .map_err(|error| format!("failed to create {}: {error}", dir.display()))?;
    let payload = format!(
        "{}\n",
        serde_json::to_string_pretty(snapshot)
            .map_err(|error| format!("failed to serialize snapshot: {error}"))?
    );
    fs::write(&path, payload)
        .map_err(|error| format!("failed to write {}: {error}", path.display()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "codex-status-light-{name}-{}-{}",
            std::process::id(),
            current_time_ms()
        ));
        fs::create_dir_all(&dir).expect("temp test dir should be created");
        dir
    }

    #[test]
    fn classify_turn_started_event() {
        let line = "2026-06-05T01:00:00Z INFO session_loop{thread_id=abc-123}:submission_dispatch{otel.name=\"op.dispatch.user_input\"}:turn{otel.name=\"session_task.turn\"}: codex_core::tasks: new";
        let event = classify_log_line(line).expect("event should be classified");
        assert_eq!(event.kind, EVENT_TURN_STARTED);
        assert_eq!(event.thread_id.as_deref(), Some("abc-123"));
    }

    #[test]
    fn running_transitions_to_yellow() {
        let initial = create_initial_status(1_000);
        let next = reduce_event(
            &initial,
            classify_log_line("2026-06-05T01:00:00Z INFO session_loop{thread_id=abc-123}:submission_dispatch{otel.name=\"op.dispatch.user_input\"}:turn{otel.name=\"session_task.turn\"}: codex_core::tasks: new").unwrap(),
        );

        assert_eq!(next.state, STATE_RUNNING);
        assert_eq!(next.color, COLOR_YELLOW);
        assert_eq!(next.reason, "Codex started a new turn");
    }

    #[test]
    fn completion_hold_expires_back_to_green() {
        let cooling = reduce_event(
            &create_initial_status(1_000),
            classify_log_line("2026-06-05T01:00:05Z TRACE codex_api::sse::responses|SSE event: {\"type\":\"response.completed\"}").unwrap(),
        );
        let settled = derive_status(&cooling, cooling.last_event_at + DEFAULT_COMPLETION_HOLD_MS + 1);

        assert_eq!(settled.state, STATE_IDLE);
        assert_eq!(settled.last_event_kind, EVENT_TURN_COMPLETED);
        assert_eq!(settled.reason, "turn completed");
    }

    #[test]
    fn interrupt_attention_clears_after_hold() {
        let interrupted = reduce_event(
            &create_initial_status(1_000),
            classify_log_line("2026-06-05T01:00:03Z INFO codex_core::session: interrupt received: abort current task, if any").unwrap(),
        );
        let cleared = derive_status(&interrupted, interrupted.last_event_at + DEFAULT_INTERRUPT_HOLD_MS + 1);

        assert_eq!(cleared.state, STATE_IDLE);
        assert_eq!(cleared.last_event_kind, EVENT_ATTENTION_CLEARED);
        assert_eq!(cleared.reason, "waiting for the next turn");
    }

    #[test]
    fn stale_running_turns_red() {
        let running = reduce_event(
            &create_initial_status(1_000),
            classify_log_line("2026-06-05T01:00:00Z INFO session_loop{thread_id=abc-123}:submission_dispatch{otel.name=\"op.dispatch.user_input\"}:turn{otel.name=\"session_task.turn\"}: codex_core::tasks: new").unwrap(),
        );
        let stale = derive_status(&running, running.last_event_at + ACTIVE_PHASE_STALE_MS + 1_000);

        assert_eq!(stale.state, STATE_ATTENTION);
        assert_eq!(stale.color, COLOR_RED);
        assert_eq!(stale.last_event_kind, EVENT_STALLED);
    }

    #[test]
    fn retry_stales_faster_than_normal_running() {
        let retrying = reduce_event(
            &create_initial_status(1_000),
            StatusEvent {
                kind: EVENT_NETWORK_RETRY,
                at: 2_000,
                thread_id: Some("abc-123".into()),
            },
        );
        let stale = derive_status(&retrying, retrying.last_event_at + RETRY_STALE_MS + 1_000);

        assert_eq!(stale.state, STATE_ATTENTION);
        assert_eq!(stale.last_event_kind, EVENT_STALLED);
        assert_eq!(stale.reason, "Codex has been retrying for too long");
    }

    #[test]
    fn approval_required_stays_yellow_without_staling() {
        let pending = reduce_event(
            &create_initial_status(1_000),
            StatusEvent {
                kind: EVENT_APPROVAL_REQUIRED,
                at: 2_000,
                thread_id: Some("abc-123".into()),
            },
        );
        let later = derive_status(
            &pending,
            pending.last_event_at + DEFAULT_RUNNING_STALE_MS + 30_000,
        );

        assert_eq!(later.state, STATE_RUNNING);
        assert_eq!(later.color, COLOR_YELLOW);
        assert_eq!(later.last_event_kind, EVENT_APPROVAL_REQUIRED);
        assert_eq!(later.reason, "waiting for your approval");
    }

    #[test]
    fn pending_approval_detects_unresolved_call() {
        let rows = vec![LogRow {
            ts: 1_000,
            ts_nanos: 0,
            thread_id: Some("abc-123".into()),
            feedback_log_body: "session_loop{thread_id=abc-123}:handle_output_item_done:handle_tool_call:handle_tool_call_with_source:dispatch_tool_call_with_code_mode_result{tool_name=\"exec_command\" call_id=\"call_123\" aborted=false}:handle_output_item_done: ToolCall: exec_command {\"sandbox_permissions\":\"require_escalated\",\"justification\":\"Do you want to allow ...\"}".into(),
        }];

        let pending = pending_approval_from_rows(&rows, 1_000_500).expect("approval should be pending");
        assert_eq!(pending.kind, EVENT_APPROVAL_REQUIRED);
        assert_eq!(pending.thread_id.as_deref(), Some("abc-123"));
    }

    #[test]
    fn resolved_approval_is_not_treated_as_pending() {
        let rows = vec![
            LogRow {
                ts: 1_001,
                ts_nanos: 0,
                thread_id: Some("abc-123".into()),
                feedback_log_body: "dispatch_tool_call_with_terminal_outcome: event.name=\"codex.tool_decision\" tool_name=exec_command call_id=call_123 decision=approved conversation.id=abc-123".into(),
            },
            LogRow {
                ts: 1_000,
                ts_nanos: 0,
                thread_id: Some("abc-123".into()),
                feedback_log_body: "session_loop{thread_id=abc-123}:handle_output_item_done:handle_tool_call:handle_tool_call_with_source:dispatch_tool_call_with_code_mode_result{tool_name=\"exec_command\" call_id=\"call_123\" aborted=false}:handle_output_item_done: ToolCall: exec_command {\"sandbox_permissions\":\"require_escalated\",\"justification\":\"Do you want to allow ...\"}".into(),
            },
        ];

        assert!(pending_approval_from_rows(&rows, 1_001_000).is_none());
    }

    #[test]
    fn select_thread_prefers_parent_workspace_match() {
        let target = Path::new("/Users/chentulin/Documents/指示灯/apps/status-light-shell");
        let candidate = Path::new("/Users/chentulin/Documents/指示灯");

        assert_eq!(path_match_score(target, candidate), Some((2, 5)));
    }

    #[test]
    fn dominant_snapshot_prefers_attention_over_running() {
        let running = snapshot_for(
            STATE_RUNNING,
            "Codex is thinking",
            EVENT_THINKING,
            2_000,
            Some("thread-running".into()),
        );
        let attention = snapshot_for(
            STATE_ATTENTION,
            "Codex hit a turn error",
            EVENT_TURN_ERROR,
            1_500,
            Some("thread-attention".into()),
        );

        let dominant = pick_dominant_snapshot([running, attention], 3_000);
        assert_eq!(dominant.state, STATE_ATTENTION);
        assert_eq!(dominant.thread_id.as_deref(), Some("thread-attention"));
    }

    #[test]
    fn dominant_snapshot_prefers_approval_over_normal_running() {
        let running = snapshot_for(
            STATE_RUNNING,
            "Codex is writing the reply",
            EVENT_REPLYING,
            3_000,
            Some("thread-reply".into()),
        );
        let approval = snapshot_for(
            STATE_RUNNING,
            "waiting for your approval",
            EVENT_APPROVAL_REQUIRED,
            2_000,
            Some("thread-approval".into()),
        );

        let dominant = pick_dominant_snapshot([running, approval], 4_000);
        assert_eq!(dominant.last_event_kind, EVENT_APPROVAL_REQUIRED);
        assert_eq!(dominant.thread_id.as_deref(), Some("thread-approval"));
    }

    #[test]
    fn dominant_snapshot_prefers_fresh_running_over_old_stalled_attention() {
        let old_stalled = snapshot_for(
            STATE_ATTENTION,
            "Codex appears stalled",
            EVENT_STALLED,
            10_000,
            Some("thread-stalled".into()),
        );
        let fresh_running = snapshot_for(
            STATE_RUNNING,
            "Codex is thinking",
            EVENT_THINKING,
            55_000,
            Some("thread-running".into()),
        );

        let dominant = pick_dominant_snapshot([old_stalled, fresh_running], 60_000);
        assert_eq!(dominant.state, STATE_RUNNING);
        assert_eq!(dominant.thread_id.as_deref(), Some("thread-running"));
    }

    #[test]
    fn dominant_snapshot_keeps_fresh_error_over_running() {
        let fresh_error = snapshot_for(
            STATE_ATTENTION,
            "Codex hit a turn error",
            EVENT_TURN_ERROR,
            58_000,
            Some("thread-error".into()),
        );
        let fresh_running = snapshot_for(
            STATE_RUNNING,
            "Codex is thinking",
            EVENT_THINKING,
            59_000,
            Some("thread-running".into()),
        );

        let dominant = pick_dominant_snapshot([fresh_error, fresh_running], 60_000);
        assert_eq!(dominant.state, STATE_ATTENTION);
        assert_eq!(dominant.thread_id.as_deref(), Some("thread-error"));
    }

    #[test]
    fn derive_status_from_sqlite_without_any_threads_is_unavailable() {
        let dir = temp_test_dir("no-threads");
        let logs_path = dir.join("logs_2.sqlite");
        let state_path = dir.join("state_5.sqlite");
        fs::write(&logs_path, "").expect("log sqlite placeholder should be written");

        let connection = Connection::open(&state_path).expect("state db should open");
        connection
            .execute(
                "create table threads (
                    id text not null,
                    cwd text not null,
                    updated_at_ms integer,
                    updated_at integer,
                    archived integer not null default 0
                )",
                [],
            )
            .expect("threads table should be created");
        drop(connection);

        let snapshot =
            derive_status_from_sqlite(&logs_path, &state_path, None, 1_000).expect("status");

        assert_eq!(snapshot.state, "unknown");
        assert_eq!(snapshot.last_event_kind, EVENT_UNAVAILABLE);
        assert_eq!(
            snapshot.reason,
            "Codex has not created any local threads on this machine yet"
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn derive_status_from_sqlite_without_recent_threads_is_idle() {
        let dir = temp_test_dir("no-recent-threads");
        let logs_path = dir.join("logs_2.sqlite");
        let state_path = dir.join("state_5.sqlite");
        fs::write(&logs_path, "").expect("log sqlite placeholder should be written");

        let connection = Connection::open(&state_path).expect("state db should open");
        connection
            .execute(
                "create table threads (
                    id text not null,
                    cwd text not null,
                    updated_at_ms integer,
                    updated_at integer,
                    archived integer not null default 0
                )",
                [],
            )
            .expect("threads table should be created");
        connection
            .execute(
                "insert into threads (id, cwd, updated_at_ms, updated_at, archived)
                 values (?1, ?2, ?3, ?4, 0)",
                params!["thread-1", "/tmp/codex", 1_i64, 0_i64],
            )
            .expect("thread row should be inserted");
        drop(connection);

        let now = global_thread_window_ms_from_env() + 60_000;
        let snapshot =
            derive_status_from_sqlite(&logs_path, &state_path, None, now).expect("status");

        assert_eq!(snapshot.state, STATE_IDLE);
        assert_eq!(snapshot.color, COLOR_GREEN);
        assert_eq!(snapshot.reason, "No recent Codex activity was found");

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn derive_status_from_log_file_without_runtime_events_is_unavailable() {
        let dir = temp_test_dir("empty-log");
        let log_path = dir.join("codex-tui.log");
        fs::write(&log_path, "plain text without runtime markers\n")
            .expect("log file should be written");

        let snapshot = derive_status_from_log_file(&log_path, 1_000).expect("status");

        assert_eq!(snapshot.state, "unknown");
        assert_eq!(snapshot.last_event_kind, EVENT_UNAVAILABLE);
        assert_eq!(
            snapshot.reason,
            "Codex log does not contain a recognizable runtime event yet"
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn debug_scenario_approval_maps_to_running_yellow() {
        let snapshot =
            debug_scenario_snapshot_named("approval", 1_000).expect("debug scenario should exist");

        assert_eq!(snapshot.state, STATE_RUNNING);
        assert_eq!(snapshot.color, COLOR_YELLOW);
        assert_eq!(snapshot.last_event_kind, EVENT_APPROVAL_REQUIRED);
    }

    #[test]
    fn debug_scenario_error_maps_to_attention_red() {
        let snapshot =
            debug_scenario_snapshot_named("error", 1_000).expect("debug scenario should exist");

        assert_eq!(snapshot.state, STATE_ATTENTION);
        assert_eq!(snapshot.color, COLOR_RED);
        assert_eq!(snapshot.last_event_kind, EVENT_TURN_ERROR);
    }
}

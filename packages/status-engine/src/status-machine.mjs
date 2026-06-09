import {
  createSnapshot,
  DEFAULT_COMPLETION_HOLD_MS,
  DEFAULT_ERROR_HOLD_MS,
  DEFAULT_INTERRUPT_HOLD_MS,
  DEFAULT_RUNNING_STALE_MS,
  LIGHT_STATES
} from "./status-contract.mjs";
import { classifyLogLine } from "./log-events.mjs";

export function createInitialStatus(now = Date.now()) {
  return createSnapshot({
    state: LIGHT_STATES.IDLE,
    reason: "waiting for Codex activity",
    lastEventKind: "startup",
    lastEventAt: now,
    threadId: null
  });
}

function runningReason(kind) {
  switch (kind) {
    case "turn_started":
      return "Codex started a new turn";
    case "thinking":
      return "Codex is thinking";
    case "tool_running":
      return "Codex is running tools";
    case "replying":
      return "Codex is writing the reply";
    case "network_retry":
      return "Codex is retrying the model request";
    default:
      return "Codex is actively working";
  }
}

function attentionReason(kind) {
  switch (kind) {
    case "interrupt":
      return "turn was interrupted";
    case "auth_error":
      return "Codex authentication failed";
    case "rate_limited":
      return "Codex hit a rate limit";
    default:
      return "Codex hit a turn error";
  }
}

function stalledReason(lastEventKind) {
  if (lastEventKind === "network_retry") {
    return "Codex has been retrying for too long";
  }

  if (lastEventKind === "tool_running") {
    return "tool execution has been quiet for too long";
  }

  return "Codex appears stalled";
}

function isTransientAttention(kind) {
  return (
    kind === "interrupt" ||
    kind === "auth_error" ||
    kind === "rate_limited" ||
    kind === "turn_error"
  );
}

function attentionHoldMs(kind, options) {
  if (kind === "interrupt") {
    return options.interruptHoldMs ?? DEFAULT_INTERRUPT_HOLD_MS;
  }

  if (
    kind === "auth_error" ||
    kind === "rate_limited" ||
    kind === "turn_error"
  ) {
    return options.errorHoldMs ?? DEFAULT_ERROR_HOLD_MS;
  }

  return null;
}

function idleReasonAfterAttention(kind) {
  switch (kind) {
    case "interrupt":
      return "waiting for the next turn";
    case "auth_error":
      return "last authentication issue is no longer active";
    case "rate_limited":
      return "last rate limit is no longer active";
    default:
      return "last turn error is no longer active";
  }
}

export function reduceEvent(currentStatus, event, options = {}) {
  const staleMs = options.runningStaleMs ?? DEFAULT_RUNNING_STALE_MS;
  const at = event.at ?? Date.now();
  const threadId = event.threadId ?? currentStatus.threadId ?? null;

  switch (event.kind) {
    case "turn_completed":
      return createSnapshot({
        state: LIGHT_STATES.RUNNING,
        reason: "Codex just finished; holding yellow briefly",
        lastEventKind: "cooldown",
        lastEventAt: at,
        threadId
      });
    case "turn_started":
    case "thinking":
    case "tool_running":
    case "replying":
    case "network_retry":
    case "running":
      return createSnapshot({
        state: LIGHT_STATES.RUNNING,
        reason: runningReason(event.kind),
        lastEventKind: event.kind,
        lastEventAt: at,
        threadId
      });
    case "interrupt":
    case "auth_error":
    case "rate_limited":
    case "turn_error":
      return createSnapshot({
        state: LIGHT_STATES.ATTENTION,
        reason: attentionReason(event.kind),
        lastEventKind: event.kind,
        lastEventAt: at,
        threadId
      });
    default:
      return deriveStatus(currentStatus, {
        now: at,
        runningStaleMs: staleMs
      });
  }
}

export function reduceLogLine(currentStatus, line, options = {}) {
  const event = classifyLogLine(line);
  if (!event) {
    return deriveStatus(currentStatus, options);
  }

  return reduceEvent(currentStatus, event, options);
}

export function deriveStatus(currentStatus, options = {}) {
  const now = options.now ?? Date.now();
  const staleMs = options.runningStaleMs ?? DEFAULT_RUNNING_STALE_MS;
  const completionHoldMs =
    options.completionHoldMs ?? DEFAULT_COMPLETION_HOLD_MS;
  const ageMs = now - currentStatus.lastEventAt;

  if (currentStatus.lastEventKind === "cooldown") {
    if (ageMs <= completionHoldMs) {
      return currentStatus;
    }

    return createSnapshot({
      state: LIGHT_STATES.IDLE,
      reason: "turn completed",
      lastEventKind: "turn_completed",
      lastEventAt: currentStatus.lastEventAt,
      threadId: currentStatus.threadId
    });
  }

  if (
    currentStatus.state === LIGHT_STATES.RUNNING &&
    ageMs > staleMs
  ) {
    return createSnapshot({
      state: LIGHT_STATES.ATTENTION,
      reason: stalledReason(currentStatus.lastEventKind),
      lastEventKind: "stalled",
      lastEventAt: currentStatus.lastEventAt,
      threadId: currentStatus.threadId
    });
  }

  if (
    currentStatus.state === LIGHT_STATES.ATTENTION &&
    isTransientAttention(currentStatus.lastEventKind)
  ) {
    const holdMs = attentionHoldMs(currentStatus.lastEventKind, options);

    if (holdMs !== null && ageMs > holdMs) {
      return createSnapshot({
        state: LIGHT_STATES.IDLE,
        reason: idleReasonAfterAttention(currentStatus.lastEventKind),
        lastEventKind: "attention_cleared",
        lastEventAt: currentStatus.lastEventAt,
        threadId: currentStatus.threadId
      });
    }
  }

  return currentStatus;
}

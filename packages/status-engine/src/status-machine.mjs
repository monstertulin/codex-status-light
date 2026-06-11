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
    reason: "等待 Codex 活动",
    lastEventKind: "startup",
    lastEventAt: now,
    threadId: null
  });
}

function runningReason(kind) {
  switch (kind) {
    case "turn_started":
      return "Codex 已开始新一轮";
    case "thinking":
      return "Codex 正在读取上下文";
    case "tool_running":
      return "Codex 正在运行工具";
    case "replying":
      return "Codex 正在生成回复";
    case "network_retry":
      return "Codex 正在重试模型请求";
    default:
      return "Codex 正在工作";
  }
}

function attentionReason(kind) {
  switch (kind) {
    case "interrupt":
      return "当前轮次已被中断";
    case "auth_error":
      return "Codex 认证失败";
    case "rate_limited":
      return "Codex 遇到速率限制";
    default:
      return "Codex 当前轮次出错";
  }
}

function stalledReason(lastEventKind) {
  if (lastEventKind === "network_retry") {
    return "Codex 重试时间过长";
  }

  if (lastEventKind === "thinking") {
    return "读取状态过久没有新进展";
  }

  if (lastEventKind === "tool_running") {
    return "工具执行过久没有新进展";
  }

  if (lastEventKind === "replying") {
    return "回复生成过久没有新进展";
  }

  return "Codex 似乎已卡住";
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
      return "等待下一轮开始";
    case "auth_error":
      return "上一次认证问题已恢复";
    case "rate_limited":
      return "上一次速率限制已恢复";
    default:
      return "上一次轮次错误已恢复";
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
        reason: "Codex 刚完成任务，黄灯会短暂停留",
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
      reason: "本轮已完成",
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

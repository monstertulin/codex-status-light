export const LIGHT_STATES = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  ATTENTION: "attention"
});

export const LIGHT_COLORS = Object.freeze({
  [LIGHT_STATES.IDLE]: "green",
  [LIGHT_STATES.RUNNING]: "yellow",
  [LIGHT_STATES.ATTENTION]: "red"
});

export const DEFAULT_RUNNING_STALE_MS = 180_000;
export const DEFAULT_COMPLETION_HOLD_MS = 3_000;
export const DEFAULT_INTERRUPT_HOLD_MS = 4_000;
export const DEFAULT_ERROR_HOLD_MS = 10_000;

export function createSnapshot({
  state,
  reason,
  lastEventKind,
  lastEventAt,
  threadId = null
}) {
  return {
    state,
    color: LIGHT_COLORS[state],
    reason,
    lastEventKind,
    lastEventAt,
    threadId
  };
}

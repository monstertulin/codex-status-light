const SNAPSHOT_URL = "./runtime/current-status.json";
const POLL_INTERVAL_MS = 500;
const MISSING_GRACE_MS = 4000;

const refs = {
  body: document.body,
  statusChip: document.getElementById("status-chip"),
  meaningLabel: document.getElementById("meaning-label"),
  stateLabel: document.getElementById("state-label"),
  reason: document.getElementById("reason"),
  substateLabel: document.getElementById("substate-label"),
  colorValue: document.getElementById("color-value"),
  eventValue: document.getElementById("event-value"),
  threadValue: document.getElementById("thread-value"),
  updatedValue: document.getElementById("updated-value")
};

const STATE_LABELS = {
  idle: "Ready",
  running: "Working",
  attention: "Needs Attention",
  unknown: "Unavailable"
};

const EVENT_LABELS = {
  startup: "Startup",
  unavailable: "Unavailable",
  cooldown: "Settling",
  turn_completed: "Completed",
  turn_started: "Turn started",
  thinking: "Thinking",
  tool_running: "Running tools",
  replying: "Replying",
  network_retry: "Retrying",
  approval_required: "Awaiting approval",
  interrupt: "Interrupted",
  auth_error: "Authentication error",
  rate_limited: "Rate limited",
  turn_error: "Turn error",
  attention_cleared: "Recovered",
  stalled: "Stalled",
  running: "Working"
};

const COLOR_LABELS = {
  green: "Green",
  yellow: "Yellow",
  red: "Red",
  neutral: "Neutral"
};

function isMissingLocalRuntimeData(snapshot = {}) {
  const reason = (snapshot.reason ?? "").toLowerCase();
  return (
    reason.includes("no local codex runtime data") ||
    reason.includes("no local codex log file") ||
    reason.includes("has not created any local threads") ||
    reason.includes("does not contain runtime events yet") ||
    reason.includes("does not contain a recognizable runtime event")
  );
}

function colorLabelFor(color) {
  return COLOR_LABELS[color] ?? color ?? "Unknown";
}

function phaseGroupFor(snapshot = {}) {
  switch (snapshot.lastEventKind) {
    case "approval_required":
      return "approval";
    case "thinking":
    case "tool_running":
    case "replying":
    case "network_retry":
    case "cooldown":
      return "active";
    case "interrupt":
    case "auth_error":
    case "rate_limited":
    case "turn_error":
      return "error";
    case "stalled":
      return "stalled";
    case "unavailable":
      return "unavailable";
    case "turn_completed":
    case "attention_cleared":
    case "startup":
    default:
      return snapshot.color === "green" ? "settled" : "idle";
  }
}

function headlineFor(snapshot) {
  if (
    snapshot.state === "running" &&
    snapshot.lastEventKind &&
    snapshot.lastEventKind !== "running"
  ) {
    return eventLabelFor(snapshot.lastEventKind);
  }

  if (
    snapshot.state === "attention" &&
    snapshot.lastEventKind &&
    snapshot.lastEventKind !== "attention_cleared"
  ) {
    return eventLabelFor(snapshot.lastEventKind);
  }

  return STATE_LABELS[snapshot.state] ?? "Unknown";
}

function toneLabelFor(snapshot) {
  switch (snapshot.lastEventKind) {
    case "approval_required":
      return "Waiting for your approval";
    case "thinking":
      return "Reasoning in progress";
    case "tool_running":
      return "Tool execution in progress";
    case "replying":
      return "Drafting the reply";
    case "network_retry":
      return "Retrying the model request";
    case "cooldown":
      return "Settling after completion";
    case "interrupt":
      return "Turn was interrupted";
    case "auth_error":
      return "Authentication issue";
    case "rate_limited":
      return "Rate limited";
    case "turn_error":
      return "Turn failed";
    case "stalled":
      return "Possibly stalled";
    case "unavailable":
      if (isMissingLocalRuntimeData(snapshot)) {
        return "No local Codex data yet";
      }
      return "Signal temporarily unavailable";
    default:
      switch (snapshot.color) {
        case "green":
          return "Stable and ready";
        case "yellow":
          return "Live activity in progress";
        case "red":
          return "Attention may be needed";
        default:
          return "Waiting for a live signal";
      }
  }
}

function supportLabelFor(snapshot) {
  switch (snapshot.lastEventKind) {
    case "approval_required":
      return "The yellow lamp is flashing: Codex is paused on an approval gate and is waiting for you to allow the next step.";
    case "thinking":
      return "The yellow lamp is active: Codex is still reasoning and has not started replying yet.";
    case "tool_running":
      return "The yellow lamp is active: Codex is calling or streaming tool execution output.";
    case "replying":
      return "The yellow lamp is active: Codex is actively generating the reply.";
    case "network_retry":
      return "The yellow lamp is active: Codex is retrying a model request and may escalate to red if that stays quiet too long.";
    case "cooldown":
      return "The yellow lamp is briefly held after completion so the state change feels natural instead of snapping instantly to green.";
    case "interrupt":
      return "The red lamp is active: the current turn was interrupted and Codex is waiting for the next action.";
    case "auth_error":
      return "The red lamp is active: Codex hit an authentication problem and needs account or token attention.";
    case "rate_limited":
      return "The red lamp is active: Codex hit a rate limit and could not continue normally.";
    case "turn_error":
      return "The red lamp is active: the last turn failed unexpectedly and likely needs action before Codex can continue cleanly.";
    case "stalled":
      return "The red lamp is active: Codex started work earlier, but fresh output has been quiet for too long, so this looks more like a stall than an immediate hard error.";
    case "unavailable":
      if (isMissingLocalRuntimeData(snapshot)) {
        return "The neutral state is active: this machine has not produced usable local Codex runtime data yet, so the tray cannot infer a live status.";
      }
      return "The neutral state is active: the app could not read a reliable runtime signal just now.";
    default:
      switch (snapshot.color) {
        case "green":
          return "The green lamp is active: Codex is idle or the last turn has fully settled.";
        case "yellow":
          return "The yellow lamp is active: Codex is working through an active turn.";
        case "red":
          return "The red lamp is active: Codex needs attention.";
        default:
          return "Start the snapshot writer to feed live Codex state into this panel.";
      }
  }
}

function applyTone(snapshotOrColor = "neutral") {
  const snapshot =
    typeof snapshotOrColor === "string" ? null : snapshotOrColor ?? null;
  const color =
    typeof snapshotOrColor === "string"
      ? snapshotOrColor
      : snapshotOrColor?.color ?? "neutral";

  refs.body.dataset.color = color;
  refs.body.dataset.state = snapshot?.state ?? "unknown";
  refs.body.dataset.event = snapshot?.lastEventKind ?? "unknown";
  refs.body.dataset.phase = phaseGroupFor(snapshot ?? { color });
  refs.statusChip.className = `status-chip status-chip-${color}`;
  refs.statusChip.textContent = colorLabelFor(color);
}

let hasSnapshot = false;
let lastRenderKey = null;
let isLoading = false;
let lastSuccessAt = 0;

function embeddedSnapshot() {
  return window.__STATUS_LIGHT_LAST_SNAPSHOT__ ?? null;
}

function formatTimestamp(ms) {
  if (!ms) {
    return "n/a";
  }

  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "n/a" : date.toLocaleString();
}

function eventLabelFor(kind) {
  return EVENT_LABELS[kind] ?? kind ?? "unknown";
}

function snapshotKey(snapshot) {
  return JSON.stringify([
    snapshot.state ?? "idle",
    snapshot.color ?? "neutral",
    snapshot.reason ?? "",
    snapshot.lastEventKind ?? "unknown",
    snapshot.lastEventAt ?? 0,
    snapshot.threadId ?? null
  ]);
}

function renderMissingState(force = false) {
  const key = "__missing__";
  if (!force && lastRenderKey === key) {
    return;
  }

  applyTone({
    color: "neutral",
    state: "unknown",
    lastEventKind: "startup"
  });
  refs.meaningLabel.textContent = "Waiting for a live signal";
  refs.stateLabel.textContent = "Waiting for snapshot";
  refs.reason.textContent =
    "Run the snapshot writer so the dashboard can read the current Codex status.";
  refs.substateLabel.textContent =
    "The tray watches your local Codex runtime and mirrors its live state here.";
  refs.colorValue.textContent = "Neutral";
  refs.eventValue.textContent = "Startup";
  refs.threadValue.textContent = "n/a";
  refs.updatedValue.textContent = "n/a";
  refs.threadValue.title = "";
  refs.updatedValue.title = "";
  lastRenderKey = key;
  hasSnapshot = false;
}

function renderSnapshot(snapshot) {
  const key = snapshotKey(snapshot);
  if (key === lastRenderKey) {
    return;
  }

  applyTone(snapshot);
  refs.meaningLabel.textContent = toneLabelFor(snapshot);
  refs.stateLabel.textContent = headlineFor(snapshot);
  refs.reason.textContent = snapshot.reason ?? "No reason supplied";
  refs.substateLabel.textContent = supportLabelFor(snapshot);
  refs.colorValue.textContent = colorLabelFor(snapshot.color);
  refs.eventValue.textContent = eventLabelFor(snapshot.lastEventKind);
  refs.threadValue.textContent = snapshot.threadId ?? "n/a";
  refs.updatedValue.textContent = formatTimestamp(snapshot.lastEventAt);
  refs.threadValue.title = snapshot.threadId ?? "";
  refs.updatedValue.title = snapshot.lastEventAt
    ? new Date(snapshot.lastEventAt).toISOString()
    : "";
  lastRenderKey = key;
  hasSnapshot = true;
  lastSuccessAt = Date.now();
}

async function loadSnapshotFromTauri() {
  const invoke =
    window.__TAURI_INTERNALS__?.invoke ?? window.__TAURI__?.core?.invoke;

  if (!invoke) {
    throw new Error("Tauri invoke bridge is not ready");
  }

  return invoke("read_status_snapshot");
}

async function loadSnapshot() {
  if (isLoading) {
    return;
  }

  isLoading = true;

  try {
    if (window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke) {
      const snapshot = await loadSnapshotFromTauri();
      renderSnapshot(snapshot);
      return;
    }

    const response = await fetch(`${SNAPSHOT_URL}?ts=${Date.now()}`, {
      cache: "no-store"
    });

    if (!response.ok) {
      renderMissingState();
      return;
    }

    const snapshot = await response.json();
    renderSnapshot(snapshot);
  } catch {
    if (!hasSnapshot || Date.now() - lastSuccessAt > MISSING_GRACE_MS) {
      renderMissingState(!hasSnapshot);
    }
  } finally {
    isLoading = false;
  }
}

window.addEventListener("status-light:snapshot", (event) => {
  if (event?.detail) {
    renderSnapshot(event.detail);
  }
});

const initialEmbeddedSnapshot = embeddedSnapshot();
if (initialEmbeddedSnapshot) {
  renderSnapshot(initialEmbeddedSnapshot);
}

loadSnapshot();
window.setInterval(loadSnapshot, POLL_INTERVAL_MS);

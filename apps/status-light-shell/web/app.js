const SNAPSHOT_URL = "./runtime/current-status.json";
const POLL_INTERVAL_MS = 500;
const TAURI_BOOT_POLL_INTERVAL_MS = 250;
const TAURI_VISIBLE_POLL_INTERVAL_MS = 300;
const TAURI_HIDDEN_POLL_INTERVAL_MS = 1200;
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
  updatedValue: document.getElementById("updated-value"),
  renderedValue: document.getElementById("rendered-value"),
  latencyValue: document.getElementById("latency-value"),
  sourceValue: document.getElementById("source-value")
};

const STATE_LABELS = {
  idle: "就绪",
  running: "运行中",
  attention: "需处理",
  unknown: "不可用"
};

const EVENT_LABELS = {
  startup: "启动中",
  unavailable: "不可用",
  cooldown: "收尾中",
  turn_completed: "已完成",
  turn_started: "已开始",
  thinking: "读取中",
  tool_running: "工具处理中",
  replying: "回复中",
  network_retry: "重试中",
  approval_required: "等待授权",
  interrupt: "已中断",
  auth_error: "认证错误",
  rate_limited: "速率受限",
  turn_error: "轮次错误",
  attention_cleared: "已恢复",
  stalled: "已卡住",
  running: "运行中"
};

const COLOR_LABELS = {
  green: "绿灯",
  yellow: "黄灯",
  red: "红灯",
  neutral: "灰灯"
};

function isMissingLocalRuntimeData(snapshot = {}) {
  const reason = snapshot.reason ?? "";
  return (
    reason.includes("未发现本地 Codex 运行数据") ||
    reason.includes("未找到本地 Codex 日志文件") ||
    reason.includes("还没有创建任何本地线程") ||
    reason.includes("还没有运行时事件") ||
    reason.includes("还没有可识别的运行时事件") ||
    reason.toLowerCase().includes("no local codex runtime data") ||
    reason.toLowerCase().includes("no local codex log file") ||
    reason.toLowerCase().includes("has not created any local threads") ||
    reason.toLowerCase().includes("does not contain runtime events yet") ||
    reason.toLowerCase().includes("does not contain a recognizable runtime event")
  );
}

function colorLabelFor(color) {
  return COLOR_LABELS[color] ?? color ?? "未知";
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

  return STATE_LABELS[snapshot.state] ?? "未知";
}

function toneLabelFor(snapshot) {
  switch (snapshot.lastEventKind) {
    case "approval_required":
      return "等待你的授权";
    case "thinking":
      return "正在读取上下文";
    case "tool_running":
      return "正在执行工具";
    case "replying":
      return "正在生成回复";
    case "network_retry":
      return "正在重试模型请求";
    case "cooldown":
      return "完成后短暂停留";
    case "interrupt":
      return "当前轮次已被中断";
    case "auth_error":
      return "认证异常";
    case "rate_limited":
      return "速率受限";
    case "turn_error":
      return "当前轮次失败";
    case "stalled":
      return "可能已卡住";
    case "unavailable":
      if (isMissingLocalRuntimeData(snapshot)) {
        return "本地还没有 Codex 运行数据";
      }
      return "状态信号暂时不可用";
    default:
      switch (snapshot.color) {
        case "green":
          return "状态稳定，随时可用";
        case "yellow":
          return "当前正在处理中";
        case "red":
          return "当前需要关注";
        default:
          return "等待可用状态信号";
      }
  }
}

function supportLabelFor(snapshot) {
  switch (snapshot.lastEventKind) {
    case "approval_required":
      return "黄灯闪烁：Codex 暂停在授权步骤，正在等待你允许下一步操作。";
    case "thinking":
      return "黄灯亮起：Codex 正在读取上下文，并在回复前准备下一步。";
    case "tool_running":
      return "黄灯亮起：Codex 正在调用工具或接收工具执行输出。";
    case "replying":
      return "黄灯亮起：Codex 正在生成回复。";
    case "network_retry":
      return "黄灯亮起：Codex 正在重试模型请求，如果长时间没有新进展，可能会转成红灯。";
    case "cooldown":
      return "黄灯会在完成后短暂停留，让状态切换更自然，而不是立刻跳回绿灯。";
    case "interrupt":
      return "红灯亮起：当前轮次已被中断，Codex 正在等待下一步操作。";
    case "auth_error":
      return "红灯亮起：Codex 遇到了认证问题，需要检查账号或令牌。";
    case "rate_limited":
      return "红灯亮起：Codex 遇到了速率限制，暂时无法正常继续。";
    case "turn_error":
      return "红灯亮起：上一轮意外失败，通常需要处理后才能继续顺畅运行。";
    case "stalled":
      return "红灯亮起：Codex 之前已经开始工作，但长时间没有新输出，这更像是卡住了，而不是立即报硬错误。";
    case "unavailable":
      if (isMissingLocalRuntimeData(snapshot)) {
        return "灰灯亮起：这台机器还没有产生可用的本地 Codex 运行数据，所以托盘暂时无法判断实时状态。";
      }
      return "灰灯亮起：应用刚刚没能读到可靠的运行时信号。";
    default:
      switch (snapshot.color) {
        case "green":
          return "绿灯亮起：Codex 当前空闲，或上一轮已经完全稳定结束。";
        case "yellow":
          return "黄灯亮起：Codex 正在处理当前轮次。";
        case "red":
          return "红灯亮起：Codex 当前需要关注。";
        default:
          return "请启动快照写入器，把实时 Codex 状态传给这个面板。";
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
let lastSnapshotSource = "unknown";

function embeddedSnapshot() {
  return window.__STATUS_LIGHT_LAST_SNAPSHOT__ ?? null;
}

function isProbablyTauriRuntime() {
  if (hasTauriBridge()) {
    return true;
  }

  const protocol = window.location.protocol?.toLowerCase?.() ?? "";
  if (protocol && protocol !== "http:" && protocol !== "https:") {
    return true;
  }

  const host = window.location.host?.toLowerCase?.() ?? "";
  if (host === "tauri.localhost" || host.endsWith(".tauri.localhost")) {
    return true;
  }

  const userAgent = navigator.userAgent?.toLowerCase?.() ?? "";
  return userAgent.includes("tauri");
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

function formatLatency(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return "n/a";
  }

  return `${Math.round(ms)} ms`;
}

function sourceLabelFor(source) {
  switch (source) {
    case "push":
      return "push";
    case "invoke":
      return "invoke";
    case "embedded":
      return "embedded";
    case "web-runtime":
      return "web-runtime";
    case "tauri-waiting":
      return "tauri-waiting";
    case "missing":
      return "missing";
    default:
      return source ?? "unknown";
  }
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
  refs.meaningLabel.textContent = "等待实时状态";
  refs.stateLabel.textContent = "等待状态快照";
  refs.reason.textContent =
    "请启动快照写入器，让面板能够读取当前 Codex 状态。";
  refs.substateLabel.textContent =
    "托盘会监控你本地的 Codex 运行状态，并把实时状态同步到这里。";
  refs.colorValue.textContent = "灰灯";
  refs.eventValue.textContent = "启动中";
  refs.threadValue.textContent = "n/a";
  refs.updatedValue.textContent = "n/a";
  refs.renderedValue.textContent = formatTimestamp(Date.now());
  refs.latencyValue.textContent = "n/a";
  refs.sourceValue.textContent = sourceLabelFor("missing");
  refs.threadValue.title = "";
  refs.updatedValue.title = "";
  refs.renderedValue.title = "";
  refs.latencyValue.title = "";
  refs.sourceValue.title = "missing";
  lastRenderKey = key;
  hasSnapshot = false;
  lastSnapshotSource = "missing";
}

function renderTauriWaitingState(force = false) {
  const key = "__tauri_waiting__";
  if (!force && lastRenderKey === key) {
    return;
  }

  applyTone({
    color: "neutral",
    state: "unknown",
    lastEventKind: "startup"
  });
  refs.meaningLabel.textContent = "正在连接原生实时状态";
  refs.stateLabel.textContent = "等待状态快照";
  refs.reason.textContent = "原生状态桥正在准备中，页面会直接复用状态栏的实时状态。";
  refs.substateLabel.textContent =
    "这个窗口现在不会再读取网页调试快照，所以不会被旧的 runtime 文件误导。";
  refs.colorValue.textContent = "灰灯";
  refs.eventValue.textContent = "启动中";
  refs.threadValue.textContent = "n/a";
  refs.updatedValue.textContent = "n/a";
  refs.renderedValue.textContent = formatTimestamp(Date.now());
  refs.latencyValue.textContent = "n/a";
  refs.sourceValue.textContent = sourceLabelFor("tauri-waiting");
  refs.threadValue.title = "";
  refs.updatedValue.title = "";
  refs.renderedValue.title = "";
  refs.latencyValue.title = "";
  refs.sourceValue.title = "tauri-waiting";
  lastRenderKey = key;
  hasSnapshot = false;
  lastSnapshotSource = "tauri-waiting";
}

function renderSnapshot(snapshot, source = lastSnapshotSource || "unknown") {
  const key = snapshotKey(snapshot);
  if (key === lastRenderKey) {
    return;
  }

  const renderedAt = Date.now();
  const latencyMs = snapshot.lastEventAt
    ? Math.max(0, renderedAt - snapshot.lastEventAt)
    : null;

  applyTone(snapshot);
  refs.meaningLabel.textContent = toneLabelFor(snapshot);
  refs.stateLabel.textContent = headlineFor(snapshot);
  refs.reason.textContent = snapshot.reason ?? "暂无状态说明";
  refs.substateLabel.textContent = supportLabelFor(snapshot);
  refs.colorValue.textContent = colorLabelFor(snapshot.color);
  refs.eventValue.textContent = eventLabelFor(snapshot.lastEventKind);
  refs.threadValue.textContent = snapshot.threadId ?? "n/a";
  refs.updatedValue.textContent = formatTimestamp(snapshot.lastEventAt);
  refs.renderedValue.textContent = formatTimestamp(renderedAt);
  refs.latencyValue.textContent = formatLatency(latencyMs);
  refs.sourceValue.textContent = sourceLabelFor(source);
  refs.threadValue.title = snapshot.threadId ?? "";
  refs.updatedValue.title = snapshot.lastEventAt
    ? new Date(snapshot.lastEventAt).toISOString()
    : "";
  refs.renderedValue.title = new Date(renderedAt).toISOString();
  refs.latencyValue.title =
    latencyMs == null ? "" : `${latencyMs}ms since lastEventAt`;
  refs.sourceValue.title = source ?? "unknown";
  lastRenderKey = key;
  hasSnapshot = true;
  lastSuccessAt = renderedAt;
  lastSnapshotSource = source ?? "unknown";
}

async function loadSnapshotFromTauri() {
  const invoke =
    window.__TAURI_INTERNALS__?.invoke ?? window.__TAURI__?.core?.invoke;

  if (!invoke) {
    throw new Error("Tauri invoke bridge is not ready");
  }

  return invoke("read_status_snapshot");
}

function hasTauriBridge() {
  return Boolean(
    window.__TAURI_INTERNALS__?.invoke ?? window.__TAURI__?.core?.invoke
  );
}

async function loadSnapshot() {
  if (isLoading) {
    return;
  }

  isLoading = true;
  const tauriRuntime = isProbablyTauriRuntime();

  try {
    if (hasTauriBridge()) {
      const snapshot = await loadSnapshotFromTauri();
      renderSnapshot(snapshot, "invoke");
      return;
    }

    const embedded = embeddedSnapshot();
    if (embedded) {
      renderSnapshot(embedded, "embedded");
      return;
    }

    if (tauriRuntime) {
      if (!hasSnapshot || Date.now() - lastSuccessAt > MISSING_GRACE_MS) {
        renderTauriWaitingState(!hasSnapshot);
      }
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
    renderSnapshot(snapshot, "web-runtime");
  } catch {
    if (tauriRuntime && !hasTauriBridge()) {
      if (!hasSnapshot || Date.now() - lastSuccessAt > MISSING_GRACE_MS) {
        renderTauriWaitingState(!hasSnapshot);
      }
      return;
    }

    if (!hasSnapshot || Date.now() - lastSuccessAt > MISSING_GRACE_MS) {
      renderMissingState(!hasSnapshot);
    }
  } finally {
    isLoading = false;
  }
}

function pollIntervalForCurrentRuntime() {
  if (hasTauriBridge()) {
    return document.hidden
      ? TAURI_HIDDEN_POLL_INTERVAL_MS
      : TAURI_VISIBLE_POLL_INTERVAL_MS;
  }

  if (isProbablyTauriRuntime()) {
    return TAURI_BOOT_POLL_INTERVAL_MS;
  }

  return POLL_INTERVAL_MS;
}

function startSnapshotPolling() {
  async function tick() {
    await loadSnapshot();
    window.setTimeout(tick, pollIntervalForCurrentRuntime());
  }

  void tick();
}

window.addEventListener("status-light:snapshot", (event) => {
  if (event?.detail) {
    renderSnapshot(event.detail, "push");
  }
});

const initialEmbeddedSnapshot = embeddedSnapshot();
if (initialEmbeddedSnapshot) {
  renderSnapshot(initialEmbeddedSnapshot, "embedded");
}

startSnapshotPolling();

if (isProbablyTauriRuntime()) {
  window.addEventListener("focus", () => {
    void loadSnapshot();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      void loadSnapshot();
    }
  });
}

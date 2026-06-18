const RULES = [
  {
    kind: "auth_error",
    tokens: ["Turn error", "Unauthorized"]
  },
  {
    kind: "auth_error",
    tokens: ["Turn error", "Invalid API Key"]
  },
  {
    kind: "rate_limited",
    tokens: ["Turn error", "429"]
  },
  {
    kind: "interrupt",
    tokens: ["interrupt received"]
  },
  {
    kind: "network_retry",
    tokens: ["retrying sampling request"]
  },
  {
    kind: "turn_started",
    tokens: ['event.name="codex.user_prompt"']
  },
  {
    kind: "thinking",
    tokens: ["run_sampling_request"]
  },
  {
    kind: "thinking",
    tokens: ["stream_request"]
  },
  {
    kind: "turn_error",
    tokens: ["Turn error"]
  },
  {
    kind: "turn_completed",
    tokens: ["app-server event: item/completed"]
  },
  {
    kind: "turn_completed",
    tokens: ["response.completed"]
  },
  {
    kind: "turn_completed",
    tokens: ["turn-ended"]
  },
  {
    kind: "tool_running",
    tokens: ["response.output_item.added", "\"type\":\"function_call\""]
  },
  {
    kind: "tool_running",
    tokens: ["response.function_call_arguments.delta"]
  },
  {
    kind: "tool_running",
    tokens: ["response.custom_tool_call_input.delta"]
  },
  {
    kind: "replying",
    tokens: ["response.output_item.added", "\"type\":\"message\""]
  },
  {
    kind: "replying",
    tokens: ["response.output_text.delta"]
  },
  {
    kind: "replying",
    tokens: ["app-server event: item/agentMessage/delta"]
  },
  {
    kind: "thinking",
    tokens: ["response.output_item.added", "\"type\":\"reasoning\""]
  },
  {
    kind: "thinking",
    tokens: ["response.in_progress"]
  },
  {
    kind: "running",
    tokens: ["response.output_item.done"]
  },
  {
    kind: "turn_started",
    tokens: ["session_task.turn", "codex_core::tasks: new"]
  }
];

const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T[^\s]+)/;
const THREAD_RE = /thread_id=([A-Za-z0-9-]+)/;
const CONVERSATION_RE = /conversation\.id=([A-Za-z0-9-]+)/;

export function extractTimestamp(line) {
  const match = line.match(TIMESTAMP_RE);

  if (!match) {
    return null;
  }

  const ms = Date.parse(match[1]);
  return Number.isNaN(ms) ? null : ms;
}

export function extractThreadId(line) {
  const match = line.match(THREAD_RE) ?? line.match(CONVERSATION_RE);
  return match ? match[1] : null;
}

export function classifyLogText(text) {
  for (const rule of RULES) {
    if (rule.tokens.every((token) => text.includes(token))) {
      return {
        kind: rule.kind,
        at: extractTimestamp(text),
        threadId: extractThreadId(text),
        raw: text
      };
    }
  }

  return null;
}

export function classifyLogLine(line) {
  return classifyLogText(line);
}

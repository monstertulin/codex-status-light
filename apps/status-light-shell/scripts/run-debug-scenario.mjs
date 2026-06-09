#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const supportedScenarios = [
  "green",
  "idle",
  "ready",
  "yellow",
  "working",
  "thinking",
  "tools",
  "tool",
  "replying",
  "reply",
  "approval",
  "approve",
  "retry",
  "network",
  "red",
  "error",
  "attention",
  "stalled",
  "auth",
  "rate-limit",
  "ratelimit",
  "limit",
  "interrupt",
  "neutral",
  "unavailable"
];

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  npm run shell:debug -- <scenario>",
      "",
      "Examples:",
      "  npm run shell:debug -- green",
      "  npm run shell:debug -- approval",
      "  npm run shell:debug -- stalled",
      "",
      "Scenarios:",
      `  ${supportedScenarios.join(", ")}`
    ].join("\n") + "\n"
  );
}

const scenario = process.argv[2]?.trim().toLowerCase();

if (!scenario || scenario === "--help" || scenario === "-h") {
  printUsage();
  process.exit(0);
}

if (scenario === "list") {
  process.stdout.write(`${supportedScenarios.join("\n")}\n`);
  process.exit(0);
}

if (!supportedScenarios.includes(scenario)) {
  process.stderr.write(`Unsupported scenario: ${scenario}\n\n`);
  printUsage();
  process.exit(1);
}

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";

const child = spawn(npxCommand, ["tauri", "dev"], {
  cwd: appDir,
  stdio: "inherit",
  env: {
    ...process.env,
    CODEX_STATUS_LIGHT_DEBUG_SCENARIO: scenario,
    CODEX_STATUS_LIGHT_OPEN_ON_LAUNCH: "1"
  }
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

import fs from "node:fs/promises";
import { resolveSignalFiles } from "./codex-paths.mjs";
import { createInitialStatus, deriveStatus, reduceLogLine } from "./status-machine.mjs";

export function deriveStatusFromLogText(logText, options = {}) {
  const initialNow = options.initialNow ?? Date.now();
  const runningStaleMs = options.runningStaleMs;

  let status = createInitialStatus(initialNow);

  for (const line of logText.split(/\r?\n/u)) {
    if (!line.trim()) {
      continue;
    }

    status = reduceLogLine(status, line, { runningStaleMs });
  }

  return deriveStatus(status, {
    now: options.now ?? Date.now(),
    runningStaleMs
  });
}

export async function deriveStatusFromLogFile(logFilePath, options = {}) {
  try {
    const logText = await fs.readFile(logFilePath, "utf8");
    return deriveStatusFromLogText(logText, options);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return createInitialStatus(options.now ?? Date.now());
    }

    throw error;
  }
}

export function defaultLogFilePath(options = {}) {
  return resolveSignalFiles(options).logFile;
}


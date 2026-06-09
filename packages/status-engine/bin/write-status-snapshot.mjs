#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  DEFAULT_COMPLETION_HOLD_MS,
  DEFAULT_ERROR_HOLD_MS,
  DEFAULT_INTERRUPT_HOLD_MS,
  DEFAULT_RUNNING_STALE_MS,
  defaultLogFilePath,
  defaultLogsSqlitePath,
  defaultStateSqlitePath,
  deriveStatusFromSignals,
  writeSnapshotFile
} from "../src/index.mjs";

function parseArgs(argv) {
  const options = {
    watch: false,
    once: false,
    intervalMs: 1500,
    runningStaleMs: DEFAULT_RUNNING_STALE_MS,
    completionHoldMs: DEFAULT_COMPLETION_HOLD_MS,
    interruptHoldMs: DEFAULT_INTERRUPT_HOLD_MS,
    errorHoldMs: DEFAULT_ERROR_HOLD_MS,
    logFile: defaultLogFilePath(),
    logsSqlite: defaultLogsSqlitePath(),
    stateSqlite: defaultStateSqlitePath(),
    out: path.resolve(process.cwd(), "apps/status-light-shell/web/runtime/current-status.json")
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--watch":
        options.watch = true;
        break;
      case "--once":
        options.once = true;
        break;
      case "--log-file":
        options.logFile = path.resolve(argv[index + 1]);
        index += 1;
        break;
      case "--out":
        options.out = path.resolve(argv[index + 1]);
        index += 1;
        break;
      case "--logs-sqlite":
        options.logsSqlite = path.resolve(argv[index + 1]);
        index += 1;
        break;
      case "--state-sqlite":
        options.stateSqlite = path.resolve(argv[index + 1]);
        index += 1;
        break;
      case "--interval-ms":
        options.intervalMs = Number(argv[index + 1]);
        index += 1;
        break;
      case "--running-stale-ms":
        options.runningStaleMs = Number(argv[index + 1]);
        index += 1;
        break;
      case "--completion-hold-ms":
        options.completionHoldMs = Number(argv[index + 1]);
        index += 1;
        break;
      case "--interrupt-hold-ms":
        options.interruptHoldMs = Number(argv[index + 1]);
        index += 1;
        break;
      case "--error-hold-ms":
        options.errorHoldMs = Number(argv[index + 1]);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.watch && !options.once) {
    options.once = true;
  }

  return options;
}

async function writeCurrentSnapshot(options) {
  const snapshot = await deriveStatusFromSignals({
    logFile: options.logFile,
    logsSqlite: options.logsSqlite,
    stateSqlite: options.stateSqlite,
    runningStaleMs: options.runningStaleMs,
    completionHoldMs: options.completionHoldMs,
    interruptHoldMs: options.interruptHoldMs,
    errorHoldMs: options.errorHoldMs,
    now: Date.now()
  });

  const wrote = await writeSnapshotFile(options.out, snapshot);
  if (wrote) {
    process.stdout.write(
      `updated ${snapshot.color} snapshot (${snapshot.lastEventKind}) at ${options.out}\n`
    );
  }
}

async function watchSnapshot(options) {
  let timer = null;
  let watchAttached = false;

  const scheduleWrite = () => {
    if (timer !== null) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      void writeCurrentSnapshot(options);
    }, 100);
  };

  await writeCurrentSnapshot(options);

  const logDir = path.dirname(options.logFile);

  if (fs.existsSync(logDir)) {
    try {
      const watcher = fs.watch(logDir, (_eventType, filename) => {
        if (!filename || filename.toString() === path.basename(options.logFile)) {
          scheduleWrite();
        }
      });

      watcher.on("error", (error) => {
        process.stderr.write(
          `watch mode degraded to polling: ${error.code ?? error.message}\n`
        );
      });
      watchAttached = true;
    } catch (error) {
      process.stderr.write(
        `watch mode unavailable, using polling only: ${error.code ?? error.message}\n`
      );
    }
  }

  setInterval(() => {
    void writeCurrentSnapshot(options);
  }, options.intervalMs);

  process.stdout.write(
    `watching Codex signals for status updates (${watchAttached ? "fs.watch + polling" : "polling only"})\n`
  );
}

const options = parseArgs(process.argv.slice(2));

if (options.watch) {
  await watchSnapshot(options);
} else {
  await writeCurrentSnapshot(options);
}

import { defaultLogFilePath, deriveStatusFromLogFile } from "./log-snapshot.mjs";
import {
  defaultLogsSqlitePath,
  defaultStateSqlitePath,
  deriveStatusFromSqliteFiles
} from "./sqlite-snapshot.mjs";

function isMissingFileError(error) {
  return error?.code === "ENOENT";
}

export async function deriveStatusFromSignals(options = {}) {
  const logFile = options.logFile ?? defaultLogFilePath(options);
  const logsSqlite = options.logsSqlite ?? defaultLogsSqlitePath(options);
  const stateSqlite = options.stateSqlite ?? defaultStateSqlitePath(options);
  const cwd = options.cwd ?? process.cwd();
  const sqliteOptions = {
    ...options,
    cwd
  };

  try {
    return await deriveStatusFromSqliteFiles(logsSqlite, stateSqlite, sqliteOptions);
  } catch (error) {
    if (!isMissingFileError(error)) {
      process.stderr.write(
        `sqlite signal fallback to log file: ${error.code ?? error.message}\n`
      );
    }
  }

  return deriveStatusFromLogFile(logFile, {
    ...options,
    logFile
  });
}

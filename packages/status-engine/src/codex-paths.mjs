import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function selectPathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

export function resolveCodexHome({
  platform = process.platform,
  homeDir = os.homedir()
} = {}) {
  const pathApi = selectPathApi(platform);

  return pathApi.join(homeDir, ".codex");
}

export function resolveSignalFiles(options = {}) {
  const platform = options.platform ?? process.platform;
  const pathApi = selectPathApi(platform);
  const codexHome = options.codexHome ?? resolveCodexHome(options);
  const existsSync = options.existsSync ?? fs.existsSync;
  const statSync = options.statSync ?? fs.statSync;
  const preferredSqlitePath = (fileName) => {
    const rootPath = pathApi.join(codexHome, fileName);
    const sqliteDirPath = pathApi.join(codexHome, "sqlite", fileName);

    const candidates = [rootPath, sqliteDirPath].filter((targetPath) =>
      existsSync(targetPath)
    );

    if (candidates.length === 0) {
      return rootPath;
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    const mtimeMsFor = (targetPath) => {
      try {
        return statSync(targetPath).mtimeMs ?? 0;
      } catch {
        return 0;
      }
    };

    return candidates.sort((left, right) => mtimeMsFor(right) - mtimeMsFor(left))[0];
  };

  return {
    codexHome,
    configToml: pathApi.join(codexHome, "config.toml"),
    logFile: pathApi.join(codexHome, "log", "codex-tui.log"),
    logsSqlite: preferredSqlitePath("logs_2.sqlite"),
    stateSqlite: preferredSqlitePath("state_5.sqlite")
  };
}

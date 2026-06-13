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
  const preferredSqlitePath = (fileName) => {
    const sqliteDirPath = pathApi.join(codexHome, "sqlite", fileName);
    return existsSync(sqliteDirPath)
      ? sqliteDirPath
      : pathApi.join(codexHome, fileName);
  };

  return {
    codexHome,
    configToml: pathApi.join(codexHome, "config.toml"),
    logFile: pathApi.join(codexHome, "log", "codex-tui.log"),
    logsSqlite: preferredSqlitePath("logs_2.sqlite"),
    stateSqlite: preferredSqlitePath("state_5.sqlite")
  };
}

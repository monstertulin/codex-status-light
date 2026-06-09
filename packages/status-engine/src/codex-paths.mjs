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

  return {
    codexHome,
    configToml: pathApi.join(codexHome, "config.toml"),
    logFile: pathApi.join(codexHome, "log", "codex-tui.log"),
    logsSqlite: pathApi.join(codexHome, "logs_2.sqlite"),
    stateSqlite: pathApi.join(codexHome, "state_5.sqlite")
  };
}

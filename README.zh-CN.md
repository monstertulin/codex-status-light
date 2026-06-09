# Codex Status Light

[English](README.md) | [简体中文](README.zh-CN.md)

Codex Status Light 是一个原生的 `macOS` 菜单栏应用和 `Windows` 系统托盘应用，用来把你本机的 Codex 运行状态转换成简单直观的红 / 黄 / 绿信号灯。

它只做一件事：让你一眼看托盘，就知道 Codex 现在是空闲、忙碌、在等你，还是卡住了。

## 功能

- 在 `macOS` 和 `Windows` 上显示实时状态灯
- 直接读取你本机上的 Codex 运行信号
- 区分活跃工作、审批等待、错误和卡住等状态
- 点击后打开小面板，查看当前亮灯背后的具体原因

## 下载

如果已经有发布产物，可以从 [GitHub Releases](https://github.com/monstertulin/codex-status-light/releases) 下载最新安装包或应用包。

- `macOS`：下载 `.dmg`
- `Windows`：下载 `.msi` 或 `NSIS .exe`

如果 Releases 页面暂时还是空的，可以先按下面的源码构建方式使用。

未签名的内部构建版本可能会触发系统的常见安全提示：

- `macOS`：第一次可以使用 `右键 -> 打开`，或者去 `系统设置 -> 隐私与安全性` 里允许
- `Windows`：SmartScreen 可能会提示，可使用 `更多信息 -> 仍要运行`

## 运行要求

这个应用只有在当前机器至少运行过一次 Codex 时，才会真正有意义。

它会从用户目录下的 `.codex` 中读取本地运行文件：

- `~/.codex/log/codex-tui.log`
- `~/.codex/logs_2.sqlite`
- `~/.codex/state_5.sqlite`

在 Windows 上，对应路径是 `%USERPROFILE%\\.codex\\...`。

如果这些文件还不存在，应用会停留在中性不可用状态，而不是误显示为绿色空闲状态。

## 灯的含义

- `绿色`：Codex 当前空闲、状态稳定，或者上一轮任务已经干净结束
- `黄色`：Codex 正在思考、流式输出，或者执行工具调用
- `黄色闪烁`：Codex 正在等待用户审批
- `红色`：Codex 发生错误、被中断，或者看起来已经卡住
- `中性`：当前还没有可靠的本地 Codex 运行信号可供判断

更细的判定规则见 [docs/status-signal-model.md](docs/status-signal-model.md)。

## 如何使用

1. 启动应用。
2. 让它常驻在菜单栏或系统托盘中。
3. 点击托盘状态灯，打开详情面板。
4. 如果要排查问题，可以用 `Open Snapshot` 查看最新状态 JSON。
5. 如果要直接看 Codex 日志，可以用 `Open Codex Log` 打开当前日志文件。

原生应用会直接读取 Codex 信号，不依赖浏览器预览页面持续运行。

## 从源码构建

先安装应用依赖：

```bash
npm --prefix apps/status-light-shell install
```

运行共享状态引擎测试：

```bash
npm test
```

开发模式运行原生托盘应用：

```bash
npm run shell:dev
```

强制切到某个状态场景，方便验证灯效：

```bash
npm run shell:debug -- approval
```

本地打包：

```bash
npm run shell:build:mac
```

```bash
npm run shell:build:win
```

## 仓库结构

- `apps/status-light-shell`：原生 Tauri 托盘应用
- `packages/status-engine`：状态解析与信号映射逻辑
- `plugins/codex-status-light`：可选的 Codex 侧辅助插件骨架
- `docs`：设计说明与状态模型文档

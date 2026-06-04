# Codex 保安

Codex 保安是一个 Tauri 2 桌面应用：Rust 后端负责本机配置发现、保护状态和命令风险检查，React/TypeScript 前端负责桌面界面展示。它是标准桌面应用，不是浏览器页面、脚本壳或插件包装。

目标是让普通用户在使用未知模型中转站时，不需要手动填写 Base URL / API Key，就能看到 Codex 连接了哪些模型供应商、当前保护是否启用、命令风险是否命中，并能通过清晰的桌面界面完成安装、升级和卸载入口操作。

## 普通用户安装

从 GitHub Releases 下载最新安装包：

https://github.com/jiangliushi666/codex-baoan/releases/latest

Tauri 会生成标准桌面安装产物：

- Windows: `.exe` / `.msi`
- macOS: `.dmg`
- Linux: `.AppImage` / `.deb` / `.rpm`

卸载走系统应用管理。Windows 用户可以在应用右侧设置抽屉里点击“卸载入口”，或打开“设置 > 应用 > 已安装的应用”。升级时下载最新 Release 安装包覆盖安装。

## 开发运行

本项目使用 pnpm + Tauri。开发启动也先构建本地 `dist/`，再启动 Tauri 桌面窗口；不会暴露浏览器网页入口：

```bash
pnpm install
pnpm run dev
```

类型检查：

```bash
pnpm run typecheck
```

构建安装包：

```bash
pnpm tauri build
```

本地构建产物会出现在：

```text
src-tauri/target/release/bundle/
```

## 自动发现

启动后会自动扫描本机已有配置，成功时直接按来源分组展示模型供应商，不要求用户手填密钥。

- ccswitch: `%APPDATA%\cc-switch\cc-switch.db`、`~/.cc-switch/cc-switch.db`
- Codex++: `~/.codex-session-delete/settings.json` 及常见 AppData/config 目录
- Codex: `~/.codex/config.toml`

读取到的 API Key 只在 Rust 后端用于判断可用性，前端只显示脱敏结果。

## 当前能力

- ccswitch 风格的桌面窗口、左侧固定导航、右侧可滚动内容区、按来源分组的模型供应商列表。
- 一键启用/停止保护状态，自动选择推荐 provider。
- 自动发现 ccswitch、Codex++、Codex 的默认配置位置。
- 命令风险检查：识别密钥目录、环境文件、网络传输、删除命令等高危行为。
- 应用管理：打开安装包页面、检查升级、打开安装目录、打开系统卸载入口。
- Tauri 打包：标准安装/卸载能力由系统安装器负责。

## 后续路线

- 接入签名 Tauri updater，发布 `latest.json` 实现应用内升级。
- 增加本地代理或 CLI wrapper，捕获完整模型响应和工具调用。
- 对 Codex App 做更深的进程/网络层监控，在可路由路径中执行拦截策略。
- 引入持久化会话日志，展示清晰的告警时间线。

## 开源

MIT License。仓库地址：https://github.com/jiangliushi666/codex-baoan

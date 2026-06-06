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

卸载走系统应用管理。Windows 用户可以在应用右侧设置抽屉里点击「卸载入口」，或打开「设置 > 应用 > 已安装的应用」。

### 自动更新

应用内置了自动更新功能：

1. 打开应用，点击右上角「设置」按钮
2. 在「版本更新」区域点击「检查更新」
3. 如果有新版本，点击「立即更新」按钮
4. 更新下载完成后，应用会自动重启到新版本

所有更新包都经过签名验证，确保安全性。开发模式下不会执行应用内更新，可通过下载页手动查看正式版本。

### 维护者发布

正式自动更新依赖 Tauri updater 签名。仓库 Secrets 需要配置与 `src-tauri/tauri.conf.json` 中 `plugins.updater.pubkey` 配对的私钥：

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

推送 `v*` tag 后，GitHub Actions 会构建多平台安装包、签名更新产物并上传 `latest.json` 到本次 Release，已安装应用会从 Releases latest endpoint 检查新版本。

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

启动后会自动扫描本机已有配置，只展示当前实际启用的 Codex 上游来源；不会把历史供应商列表当成可切换管理面板。

- ccswitch: `%APPDATA%\cc-switch\cc-switch.db`、`~/.cc-switch/cc-switch.db`
- Codex++: `~/.codex-session-delete/settings.json` 及常见 AppData/config 目录
- Codex: `~/.codex/config.toml`

读取到的 API Key 只在 Rust 后端用于判断可用性，前端只显示脱敏结果。

## 当前能力

- 监控优先的桌面窗口：左侧按活动类型筛选，右侧展示当前上游与执行记录。
- 自动发现并只展示当前实际启用的 ccswitch / Codex++ / Codex 配置来源，不做逐个供应商的启用/禁用管理。
- 一键开启/关闭监控状态开关，监控对象由当前 Codex 上游自动决定。
- 执行记录展示层：命令、读取、新建、修改、删除、网络请求、高危事件分类齐全；活动数据通过 `record_command` / `record_file_event` 接口写入，完整的自动采集见下方后续路线。
- 命令风险规则：识别密钥目录、环境文件、网络传输、删除命令等高危行为，并按等级标记告警。
- 应用管理：打开安装包页面、检查升级、打开安装目录、打开系统卸载入口。
- Tauri 打包：标准安装 / 卸载由系统安装器负责。

## 后续路线

- 增加本地代理或 CLI wrapper，捕获完整模型响应和工具调用。
- 对 Codex App 做更深的进程/网络层监控，在可路由路径中执行拦截策略。
- 引入持久化会话日志，展示清晰的告警时间线。

## 开源

MIT License。仓库地址：https://github.com/jiangliushi666/codex-baoan

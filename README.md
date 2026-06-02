# Codex 保安

Codex 保安是一个给 Codex CLI / Codex App 外挂的桌面监控工具。它面向使用未知模型中转站的普通用户：默认自动读取本机已有配置，一键把 Codex 流量接入本地保护，并把高危行为和模型返回记录成清晰日志。

第一版按 ccswitch 的桌面应用形态交付：顶部应用切换、provider 大行列表、右上角一键启用、备用设置抽屉、日志面板。正常用户不需要手动输入 Base URL 或 API Key。

## 一键安装

Windows 用户下载并双击 Install-Codex-Baoan.cmd。安装器会自动完成：

- 检查 Node.js，缺失时用 winget 安装 Node.js LTS。
- 从 https://github.com/jiangliushi666/codex-baoan 下载最新代码。
- 安装依赖并构建桌面应用。
- 创建桌面和开始菜单快捷方式。
- 直接启动 Codex 保安桌面窗口。

也可以在项目目录运行：

    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

## 启动

普通用户使用桌面快捷方式 Codex Baoan，或双击：

    Start-Codex-Baoan.vbs

开发者可以运行：

    npm install
    npm start

npm start 会构建并打开桌面窗口。内部仍有本地后端服务，但它只服务于桌面壳；npm run gui / codex-guard gui --no-open 仅用于调试。

## 开箱即用发现

启动后会按顺序读取默认位置：

- ccswitch: ~/.cc-switch/cc-switch.db
- Codex++: ~/.codex-session-delete/settings.json
- Codex: ~/.codex/config.toml 和 ~/.codex/auth.json

读取成功时，界面会显示可用 provider 行。点推荐行或右上角 + 即可启用保护。读取失败时，再打开备用设置手动指定上游。

## 能监控什么

- OpenAI-compatible 模型代理请求、响应和疑似工具命令。
- Codex CLI stdout/stderr、模型返回中的命令片段、子进程命令行。
- Codex App 相关进程命令行。
- 根据当前工作目录、用户 prompt 中出现的路径和额外允许目录动态计算访问范围。

可配置为仅记录，或在进入代理/CLI wrapper 路径时拦截高危行为。

## 日志

每个会话写入 .codex-guard/sessions/<session-id>/：

- summary.md: 时间线。
- alerts.md: 高危和严重告警。
- events.ndjson: 结构化事件。
- stdout.log / stderr.log: CLI 捕获流。
- model-response.log: 模型响应捕获。

## CLI

    codex-guard run -- codex "only edit ./src"
    codex-guard inspect-command --mode block "Get-Content C:/Users/j/.ssh/id_rsa"
    codex-guard proxy --mode block --target https://api.openai.com

## 限制

在模型代理或 CLI wrapper 路径里，Codex 保安可以在执行前拦截。对封闭的 Codex App 纯进程监控只能做到发现后记录和可选结束进程，不能保证内核级预执行拦截。

## 开源

MIT License。仓库地址：https://github.com/jiangliushi666/codex-baoan。

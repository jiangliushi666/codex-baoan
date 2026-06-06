# 发布指南

本文档说明如何配置并发布带签名的 Codex 保安更新包。

## 前置条件

✅ 已生成签名密钥对（`codex-baoan-updater.key` 和 `.key.pub`）
✅ 已在 `tauri.conf.json` 中配置公钥
✅ 已配置 `release.yml` 工作流

## 配置 GitHub Secrets

在发布前，你需要在 GitHub 仓库中配置两个 Secrets：

### 1. 获取私钥内容

私钥文件位于项目根目录：`codex-baoan-updater.key`

读取私钥内容（**注意：私钥必须保密，不要泄露**）：

```bash
cat codex-baoan-updater.key
```

复制完整输出（包括 `-----BEGIN PRIVATE KEY-----` 和 `-----END PRIVATE KEY-----`）。

### 2. 添加 GitHub Secrets

1. 进入你的 GitHub 仓库
2. 点击 **Settings** → **Secrets and variables** → **Actions**
3. 点击 **New repository secret**
4. 添加以下两个 secrets：

#### Secret 1: `TAURI_SIGNING_PRIVATE_KEY`
- **Name**: `TAURI_SIGNING_PRIVATE_KEY`
- **Value**: 粘贴整个私钥内容（从 `cat` 命令输出）

#### Secret 2: `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- **Name**: `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- **Value**: 留空（如果生成密钥时没有设置密码）

> ⚠️ **安全提示**：
> - 私钥文件（`codex-baoan-updater.key`）**不要**提交到 Git 仓库
> - 已在 `.gitignore` 中添加了 `*.key` 规则防止意外提交
> - 公钥（`.key.pub`）可以公开，已配置在 `tauri.conf.json` 中

## 发布新版本

### 步骤 1: 更新版本号

修改以下文件中的版本号：

1. `package.json` → `"version": "0.X.X"`
2. `src-tauri/Cargo.toml` → `version = "0.X.X"`
3. `src-tauri/tauri.conf.json` → `"version": "0.X.X"`

### 步骤 2: 提交更改

```bash
git add .
git commit -m "chore: bump version to 0.X.X"
git push
```

### 步骤 3: 创建并推送 Tag

```bash
git tag v0.X.X
git push origin v0.X.X
```

### 步骤 4: 自动构建与发布

推送 tag 后，GitHub Actions 会自动：

1. 🔨 在 Windows、macOS、Linux 三个平台上构建应用
2. 🔐 使用私钥对每个安装包生成 `.sig` 签名文件
3. 📝 生成 `latest.json` 更新清单
4. 📦 创建 GitHub Release 并上传所有文件

你可以在仓库的 **Actions** 标签页查看构建进度。

### 步骤 5: 验证发布

发布完成后，检查：

1. **GitHub Release 页面** 应包含：
   - Windows: `.msi`, `.msi.zip`, `.msi.zip.sig`
   - macOS: `.dmg`, `.app.tar.gz`, `.app.tar.gz.sig`
   - Linux: `.AppImage`, `.deb`, `.AppImage.tar.gz`, `.AppImage.tar.gz.sig`
   - `latest.json` 文件（更新器用）

2. **测试自动更新**：
   - 打开已安装的旧版本应用
   - 进入「设置」
   - 点击「检查更新」
   - 应该能检测到新版本并显示「立即更新」按钮
   - 点击更新，下载完成后应用会自动重启到新版本

## 工作流程说明

### 自动触发方式

- **推送 tag**（推荐）：`git push origin v0.X.X`
- **手动触发**：在 GitHub 仓库 Actions 页面手动运行 `release` 工作流

### 构建产物

每个平台会生成：
- **安装包**：给新用户下载安装
- **更新包**（`.tar.gz` / `.zip`）：给已安装用户自动更新
- **签名文件**（`.sig`）：验证更新包完整性

### 签名验证流程

1. 应用启动时，从 `tauri.conf.json` 读取公钥
2. 检查更新时，从 `latest.json` 获取最新版本信息
3. 下载更新包和对应的 `.sig` 文件
4. 使用公钥验证签名，确保更新包未被篡改
5. 验证通过后安装更新

## 故障排除

### 构建失败：找不到私钥

**错误**：`ERROR: TAURI_SIGNING_PRIVATE_KEY is not set`

**解决**：检查 GitHub Secrets 是否正确配置了 `TAURI_SIGNING_PRIVATE_KEY`

### 更新检查失败

**现象**：应用中点击「检查更新」显示错误

**可能原因**：
1. `latest.json` 未生成或未上传到 Release
2. `tauri.conf.json` 中的 `endpoints` URL 不正确
3. 网络问题无法访问 GitHub

**解决**：
- 检查 Release 页面是否有 `latest.json` 文件
- 验证 URL: `https://github.com/jiangliushi666/codex-baoan/releases/latest/download/latest.json`

### 签名验证失败

**现象**：下载更新后无法安装，提示签名错误

**可能原因**：
1. `tauri.conf.json` 中的公钥与私钥不匹配
2. `.sig` 文件损坏或未生成

**解决**：
- 重新生成密钥对并更新配置
- 检查 GitHub Actions 日志，确认签名步骤成功

## 安全最佳实践

1. ✅ **私钥保密**：永远不要将 `.key` 文件提交到仓库或公开
2. ✅ **备份私钥**：将私钥安全地备份到加密存储中
3. ✅ **定期更新密钥**：考虑每年轮换一次签名密钥
4. ✅ **监控 Secrets 访问**：定期检查 GitHub Actions 日志

## 端到端测试说明

⚠️ **重要提示**：自动更新功能**必须**在真实的 GitHub Release 环境中测试。

本地开发模式（`pnpm run dev`）**无法**测试自动更新，因为：
1. 更新器需要从 GitHub Release 下载 `latest.json`
2. 签名验证需要真实的发布环境
3. 本地构建没有签名文件

**测试步骤**：
1. 发布版本 `v0.2.0`（当前版本）
2. 安装该版本到本地
3. 修改版本号到 `v0.3.0` 并发布
4. 打开已安装的 `v0.2.0`，点击「检查更新」
5. 应该检测到 `v0.3.0` 并能成功下载、安装、重启

## 相关文件

- **密钥文件**（本地）：
  - `codex-baoan-updater.key` - 私钥（保密）
  - `codex-baoan-updater.key.pub` - 公钥（可公开）

- **配置文件**：
  - `src-tauri/tauri.conf.json` - 公钥、更新端点配置
  - `.github/workflows/release.yml` - 自动发布工作流

- **文档**：
  - `README.md` - 项目介绍
  - `RELEASE.md` - 本文档（发布指南）

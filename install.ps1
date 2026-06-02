param(
  [string]$InstallDir = "$env:LOCALAPPDATA\CodexBaoan",
  [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"
$RepoZip = "https://github.com/jiangliushi666/codex-baoan/archive/refs/heads/main.zip"
$TempRoot = Join-Path $env:TEMP "codex-baoan-install"
$ZipPath = Join-Path $TempRoot "codex-baoan.zip"
$ExtractPath = Join-Path $TempRoot "source"

function Write-Step($Text) {
  Write-Host "[Codex Baoan] $Text" -ForegroundColor Cyan
}

function Ensure-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) { return }

  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    Write-Step "Installing Node.js LTS with winget"
    winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  }

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Start-Process "https://nodejs.org/en/download"
    throw "Node.js 20+ is required. Install Node.js and run this installer again."
  }
}

function New-Shortcut($ShortcutPath, $TargetPath, $WorkingDirectory) {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = $TargetPath
  $shortcut.WorkingDirectory = $WorkingDirectory
  $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,77"
  $shortcut.Save()
}

Write-Step "Preparing installer"
Ensure-Node
New-Item -ItemType Directory -Force -Path $TempRoot, $InstallDir | Out-Null
if (Test-Path $ExtractPath) { Remove-Item -LiteralPath $ExtractPath -Recurse -Force }

Write-Step "Downloading latest Codex Baoan"
Invoke-WebRequest -UseBasicParsing -Uri $RepoZip -OutFile $ZipPath
Expand-Archive -LiteralPath $ZipPath -DestinationPath $ExtractPath -Force
$SourceDir = Get-ChildItem -LiteralPath $ExtractPath -Directory | Select-Object -First 1
if (-not $SourceDir) { throw "Downloaded archive did not contain a source folder." }

Write-Step "Copying files to $InstallDir"
Copy-Item -Path (Join-Path $SourceDir.FullName "*") -Destination $InstallDir -Recurse -Force

Write-Step "Installing dependencies"
Push-Location $InstallDir
try {
  npm install
  npm run build
} finally {
  Pop-Location
}

Write-Step "Creating shortcuts"
$Desktop = [Environment]::GetFolderPath("DesktopDirectory")
$Programs = [Environment]::GetFolderPath("Programs")
$ShortcutName = "Codex Baoan.lnk"
New-Shortcut (Join-Path $Desktop $ShortcutName) (Join-Path $InstallDir "Start-Codex-Baoan.cmd") $InstallDir
New-Shortcut (Join-Path $Programs $ShortcutName) (Join-Path $InstallDir "Start-Codex-Baoan.cmd") $InstallDir

Write-Step "Installed successfully"
Write-Host "Install path: $InstallDir"
Write-Host "Open from Desktop shortcut: Codex Baoan"

if (-not $NoLaunch) {
  Start-Process -FilePath (Join-Path $InstallDir "Start-Codex-Baoan.cmd") -WorkingDirectory $InstallDir
}

param(
  [string]$InstallDir = "$env:LOCALAPPDATA\CodexBaoan",
  [switch]$NoLaunch,
  [switch]$Upgrade,
  [switch]$Uninstall,
  [switch]$KeepData
)

$ErrorActionPreference = "Stop"
$AppName = "Codex Baoan"
$AppId = "CodexBaoan"
$RepoZip = "https://github.com/jiangliushi666/codex-baoan/archive/refs/heads/main.zip"
$RepoUrl = "https://github.com/jiangliushi666/codex-baoan"
$TempRoot = Join-Path $env:TEMP "codex-baoan-install"
$ZipPath = Join-Path $TempRoot "codex-baoan.zip"
$ExtractPath = Join-Path $TempRoot "source"
$RegPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppId"

function Write-Step($Text) {
  Write-Host "[$AppName] $Text" -ForegroundColor Cyan
}

function Resolve-InstallDir {
  $parent = Split-Path -Parent $InstallDir
  if (-not $parent) { throw "InstallDir must not be a drive root." }
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $parentFull = (Resolve-Path -LiteralPath $parent).Path
  return [System.IO.Path]::GetFullPath((Join-Path $parentFull (Split-Path -Leaf $InstallDir)))
}

function Ensure-SafeInstallDir($Path) {
  $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  $forbidden = @(
    [System.IO.Path]::GetPathRoot($full).TrimEnd('\'),
    $env:SystemRoot,
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)},
    $env:USERPROFILE
  ) | Where-Object { $_ } | ForEach-Object { [System.IO.Path]::GetFullPath($_).TrimEnd('\') }
  if ($forbidden -contains $full) { throw "Refusing to use unsafe install directory: $full" }
  if ($full.Length -lt 12) { throw "Refusing to use suspiciously short install directory: $full" }
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

function New-Shortcut($ShortcutPath, $TargetPath, $WorkingDirectory, $Arguments = "", $IconLocation = "") {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = $TargetPath
  $shortcut.Arguments = $Arguments
  $shortcut.WorkingDirectory = $WorkingDirectory
  $shortcut.IconLocation = if ($IconLocation) { $IconLocation } else { "$env:SystemRoot\System32\shell32.dll,77" }
  $shortcut.Save()
}

function Remove-Shortcut($Path) {
  if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
}

function Get-InstallSizeKb($Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return 0 }
  $size = (Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  return [int][Math]::Ceiling(($size + 0) / 1KB)
}

function Stop-CodexBaoanProcesses($Path) {
  $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  $currentPid = $PID
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ProcessId -ne $currentPid -and
      $_.CommandLine -and
      ($_.Name -in @("node.exe", "electron.exe")) -and
      ($_.CommandLine -like "*$full*")
    } |
    ForEach-Object {
      try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {}
    }
}

function Register-UninstallEntry($Path) {
  $version = "0.1.0"
  $packagePath = Join-Path $Path "package.json"
  if (Test-Path -LiteralPath $packagePath) {
    try { $version = (Get-Content -Raw $packagePath | ConvertFrom-Json).version } catch {}
  }

  New-Item -Path $RegPath -Force | Out-Null
  New-ItemProperty -Path $RegPath -Name DisplayName -Value $AppName -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $RegPath -Name DisplayVersion -Value $version -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $RegPath -Name Publisher -Value "jiangliushi666" -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $RegPath -Name InstallLocation -Value $Path -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $RegPath -Name URLInfoAbout -Value $RepoUrl -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $RegPath -Name DisplayIcon -Value "$env:SystemRoot\System32\shell32.dll,77" -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $RegPath -Name UninstallString -Value "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $Path 'install.ps1')`" -InstallDir `"$Path`" -Uninstall" -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $RegPath -Name QuietUninstallString -Value "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $Path 'install.ps1')`" -InstallDir `"$Path`" -Uninstall" -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $RegPath -Name NoModify -Value 1 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $RegPath -Name NoRepair -Value 1 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $RegPath -Name EstimatedSize -Value (Get-InstallSizeKb $Path) -PropertyType DWord -Force | Out-Null
}

function New-AppShortcuts($Path) {
  $desktop = [Environment]::GetFolderPath("DesktopDirectory")
  $programs = [Environment]::GetFolderPath("Programs")
  $programGroup = Join-Path $programs $AppName
  New-Item -ItemType Directory -Force -Path $programGroup | Out-Null

  $wscript = Join-Path $env:SystemRoot "System32\wscript.exe"
  $launcher = Join-Path $Path "Start-Codex-Baoan.vbs"
  $upgrade = Join-Path $Path "Upgrade-Codex-Baoan.cmd"
  $uninstall = Join-Path $Path "Uninstall-Codex-Baoan.cmd"
  $cmd = Join-Path $env:SystemRoot "System32\cmd.exe"

  New-Shortcut (Join-Path $desktop "Codex Baoan.lnk") $wscript $Path "`"$launcher`""
  New-Shortcut (Join-Path $programGroup "Codex Baoan.lnk") $wscript $Path "`"$launcher`""
  New-Shortcut (Join-Path $programGroup "Upgrade Codex Baoan.lnk") $cmd $Path "/c `"$upgrade`""
  New-Shortcut (Join-Path $programGroup "Uninstall Codex Baoan.lnk") $cmd $Path "/c `"$uninstall`""

  $legacy = Join-Path $programs "Codex Baoan.lnk"
  Remove-Shortcut $legacy
}

function Remove-AppShortcuts {
  $desktop = [Environment]::GetFolderPath("DesktopDirectory")
  $programs = [Environment]::GetFolderPath("Programs")
  $programGroup = Join-Path $programs $AppName
  Remove-Shortcut (Join-Path $desktop "Codex Baoan.lnk")
  Remove-Shortcut (Join-Path $programs "Codex Baoan.lnk")
  if (Test-Path -LiteralPath $programGroup) { Remove-Item -LiteralPath $programGroup -Recurse -Force }
}

function Start-UninstallCleanup($Path) {
  $cleanupScript = Join-Path $env:TEMP ("codex-baoan-uninstall-" + [guid]::NewGuid().ToString("N") + ".ps1")
  $escapedPath = $Path.Replace("'", "''")
  $escapedScript = $cleanupScript.Replace("'", "''")
  $content = @"
Start-Sleep -Seconds 2
try { Remove-Item -LiteralPath '$escapedPath' -Recurse -Force -ErrorAction Stop } catch { Write-Host `$_.Exception.Message }
try { Remove-Item -LiteralPath '$escapedScript' -Force -ErrorAction SilentlyContinue } catch {}
"@
  Set-Content -LiteralPath $cleanupScript -Value $content -Encoding UTF8
  Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $cleanupScript) -WindowStyle Hidden
}

$InstallDir = Resolve-InstallDir
Ensure-SafeInstallDir $InstallDir

if ($Uninstall) {
  Write-Step "Uninstalling from $InstallDir"
  Stop-CodexBaoanProcesses $InstallDir
  Remove-AppShortcuts
  if (Test-Path $RegPath) { Remove-Item -Path $RegPath -Recurse -Force }
  if (-not $KeepData -and (Test-Path -LiteralPath $InstallDir)) { Start-UninstallCleanup $InstallDir }
  Write-Step "Uninstall scheduled"
  exit 0
}

if ($Upgrade) { Write-Step "Upgrading" } else { Write-Step "Installing" }
Ensure-Node
New-Item -ItemType Directory -Force -Path $TempRoot, $InstallDir | Out-Null
if (Test-Path $ExtractPath) { Remove-Item -LiteralPath $ExtractPath -Recurse -Force }

if ($Upgrade) { Stop-CodexBaoanProcesses $InstallDir }

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
  $electronPath = Join-Path $InstallDir "node_modules\electron\dist\electron.exe"
  if (-not (Test-Path -LiteralPath $electronPath)) {
    node node_modules\electron\install.js
  }
  npm run build
} finally {
  Pop-Location
}

Write-Step "Creating shortcuts and app registration"
New-AppShortcuts $InstallDir
Register-UninstallEntry $InstallDir

Write-Step "Ready"
Write-Host "Install path: $InstallDir"
Write-Host "Start Menu: Codex Baoan"
Write-Host "Windows Settings uninstall entry: Codex Baoan"

if (-not $NoLaunch) {
  $wscript = Join-Path $env:SystemRoot "System32\wscript.exe"
  $launcher = Join-Path $InstallDir "Start-Codex-Baoan.vbs"
  Start-Process -FilePath $wscript -ArgumentList "`"$launcher`"" -WorkingDirectory $InstallDir -WindowStyle Hidden
}

# Requires -Version 5.1
<#
.SYNOPSIS
  Register @zyfgood/dsh-mobile in a DSH desktop profile without using the
  Electron-managed `dsh plugin --profile desktop ...` command.

.DESCRIPTION
  The desktop profile is owned by the Electron application, so the CLI refuses
  to manage it. This script performs the same durable changes locally:
    - links this package into <profile>\node_modules\@zyfgood\dsh-mobile
    - adds a "link:" dependency to the profile package.json
    - appends the bundle to dsh.profile.bundles
    - appends a dsh-mobile config row to cordis.patch.yml when absent
  It backs up package.json and cordis.patch.yml before writing and never runs
  pnpm. Restart DeepSeek Harness afterwards.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\install-desktop.ps1
#>
param(
  [string]$ProfileName = 'desktop',
  [string]$PluginPath = (Split-Path -Parent $PSScriptRoot),
  [string]$DshHome = (Join-Path $HOME '.dsh'),
  [int]$Port = 35888
)

$ErrorActionPreference = 'Stop'
$plugin = (Resolve-Path -LiteralPath $PluginPath).Path
$manifestPath = Join-Path $plugin 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "找不到插件 package.json：$manifestPath"
}
$pluginManifest = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
$packageName = [string]$pluginManifest.name
if ([string]::IsNullOrWhiteSpace($packageName)) { throw '插件 package.json 缺少 name' }

$profileDir = Join-Path (Join-Path $DshHome 'profiles') $ProfileName
$profileManifestPath = Join-Path $profileDir 'package.json'
$profilePatchPath = Join-Path $profileDir 'cordis.patch.yml'
if (-not (Test-Path -LiteralPath $profileManifestPath)) {
  throw "找不到 profile：$profileDir"
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item -LiteralPath $profileManifestPath -Destination "$profileManifestPath.bak-$stamp" -Force
if (Test-Path -LiteralPath $profilePatchPath) {
  Copy-Item -LiteralPath $profilePatchPath -Destination "$profilePatchPath.bak-$stamp" -Force
}

# ── node_modules link ──────────────────────────────────────────────────────
$scopeDir = Join-Path (Join-Path $profileDir 'node_modules') '@zyfgood'
New-Item -ItemType Directory -Force -Path $scopeDir | Out-Null
$linkPath = Join-Path $scopeDir 'dsh-mobile'
if (Test-Path -LiteralPath $linkPath) {
  $item = Get-Item -LiteralPath $linkPath -Force
  if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
    $target = @($item.Target)[0]
    if ([IO.Path]::GetFullPath($target) -ne [IO.Path]::GetFullPath($plugin)) {
      throw "已存在指向其他目录的链接：$linkPath -> $target"
    }
  } else {
    throw "已存在同名目录（不是链接）：$linkPath"
  }
} else {
  New-Item -ItemType Junction -Path $linkPath -Target $plugin | Out-Null
}

# ── package.json: dependency + dsh.profile.bundles ─────────────────────────
$profileText = [IO.File]::ReadAllText($profileManifestPath)
$profileManifest = $profileText | ConvertFrom-Json
if ($null -eq $profileManifest.dependencies) {
  $profileManifest | Add-Member -MemberType NoteProperty -Name dependencies -Value ([pscustomobject]@{}) -Force
}
$spec = 'link:' + ($plugin -replace '\\', '/')
$dependencyNames = @($profileManifest.dependencies.PSObject.Properties.Name)
if ($dependencyNames -notcontains $packageName) {
  $profileManifest.dependencies | Add-Member -MemberType NoteProperty -Name $packageName -Value $spec -Force
}

if ($null -eq $profileManifest.dsh) {
  $profileManifest | Add-Member -MemberType NoteProperty -Name dsh -Value ([pscustomobject]@{}) -Force
}
if ($null -eq $profileManifest.dsh.profile) {
  $profileManifest.dsh | Add-Member -MemberType NoteProperty -Name profile -Value ([pscustomobject]@{}) -Force
}
if ($null -eq $profileManifest.dsh.profile.bundles) {
  $profileManifest.dsh.profile | Add-Member -MemberType NoteProperty -Name bundles -Value @() -Force
}
$bundles = @($profileManifest.dsh.profile.bundles)
if ($bundles -notcontains $packageName) {
  $profileManifest.dsh.profile.bundles = @($bundles + $packageName)
}

$json = $profileManifest | ConvertTo-Json -Depth 100
[IO.File]::WriteAllText($profileManifestPath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))

# ── cordis.patch.yml: explicit config row (bundle patch also inserts it) ───
$patchText = if (Test-Path -LiteralPath $profilePatchPath) { [IO.File]::ReadAllText($profilePatchPath) } else { '' }
if ($patchText -notmatch "name:\s*['""]$([regex]::Escape($packageName))['""]") {
  if ($patchText -ne '' -and -not $patchText.EndsWith("`n")) { $patchText += "`n" }
  $patchText += @"

- id: dsh-mobile
  name: '$packageName'
  config:
    host: 0.0.0.0
    port: $Port
"@
  [IO.File]::WriteAllText($profilePatchPath, $patchText, (New-Object System.Text.UTF8Encoding($false)))
}

Write-Host ''
Write-Host "已注册 $packageName" -ForegroundColor Green
Write-Host "  profile : $profileDir"
Write-Host "  link    : $linkPath -> $plugin"
Write-Host "  bundles : 已追加 $packageName"
Write-Host "  backups : *.bak-$stamp"
Write-Host ''
Write-Host '请完全退出并重新启动 DeepSeek Harness。启动后桌面 Web GUI 左下角会出现 📱 入口。' -ForegroundColor Yellow

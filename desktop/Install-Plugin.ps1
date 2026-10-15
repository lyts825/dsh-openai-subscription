#requires -Version 5.1
<#
Install the verified plugin through the desktop application's own package manager.
This script never initializes profiles, stops applications, or changes global PATH.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('official', 'next')][string]$Target,
  [Parameter(Mandatory = $true)][string]$ApplicationDirectory,
  [Parameter(Mandatory = $true)][string]$DshHome,
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')][string]$Profile = 'desktop',
  [string]$PackagePath,
  [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Read-Json([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required file is missing: $Path" }
  return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}
function Absolute-Directory([string]$Path) {
  if ($Path -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))') { throw "An absolute directory is required: $Path" }
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "Directory does not exist: $Path" }
  $directory = Get-Item -LiteralPath $Path
  if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Select the real directory instead of a directory link: $Path" }
  $fullName = $directory.FullName
  $root = [IO.Path]::GetPathRoot($fullName)
  if ($fullName.Length -gt $root.Length) { return $fullName.TrimEnd('\', '/') }
  return $root
}
function Assert-ApplicationStopped([string]$Directory, [string]$ExecutableName) {
  $prefix = $Directory.TrimEnd('\', '/') + '\'
  $running = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) -or
    (-not $_.ExecutablePath -and $_.Name -eq $ExecutableName)
  })
  if ($running.Count -gt 0) { throw 'Fully quit this desktop application from its tray or menu before continuing. The installer will not interrupt running work.' }
}

$release = Read-Json (Join-Path $PSScriptRoot 'release.json')
if ($release.schemaVersion -ne 1 -or $release.packageName -ne 'dsh-openai-subscription') { throw 'Unsupported release manifest.' }
if ($release.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'The release manifest contains an invalid SHA-256.' }
if (-not $PackagePath) { $PackagePath = Join-Path $PSScriptRoot $release.packageFile }
$archive = (Get-Item -LiteralPath $PackagePath -ErrorAction Stop).FullName
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $release.sha256) { throw 'Package SHA-256 does not match release.json.' }
$appDirectory = Absolute-Directory $ApplicationDirectory
$targetHome = Absolute-Directory $DshHome
$profileDirectory = Join-Path (Join-Path $targetHome 'profiles') $Profile
$profileDirectory = Absolute-Directory $profileDirectory
$profileManifest = Read-Json (Join-Path $profileDirectory 'package.json')
$bundles = $profileManifest.dsh.profile.bundles
if ($bundles -isnot [Array] -or @($bundles | Where-Object { $_ -isnot [string] -or [string]::IsNullOrWhiteSpace($_) }).Count -gt 0 -or
  $bundles -notcontains '@deepseek-ai/dsh-base' -or $bundles -notcontains '@deepseek-ai/dsh-web-app') {
  throw 'The selected profile is not an initialized desktop Web profile. Open the application once first.'
}
if ($Target -eq 'official' -and $Profile -ne 'desktop') { throw 'Official Desktop owns only the desktop profile.' }
if ($Profile -match '^(?:node_modules|con|prn|aux|nul|com[1-9]|lpt[1-9])$') { throw 'The profile name is reserved by the runtime or Windows.' }
$applicationName = if ($Target -eq 'official') { 'DeepSeek Harness.exe' } else { 'DSH NEXT.exe' }
Assert-ApplicationStopped $appDirectory $applicationName

$previousHome = [Environment]::GetEnvironmentVariable('DSH_HOME', 'Process')
$previousNodeMode = [Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE', 'Process')
try {
  [Environment]::SetEnvironmentVariable('DSH_HOME', $targetHome, 'Process')
  [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', '1', 'Process')
  if ($Target -eq 'official') {
    $launcher = Join-Path $appDirectory 'resources/runtime/cli/bin/dsh.cmd'
    $command = Join-Path $appDirectory 'DeepSeek Harness.exe'
    $runtimeArchive = Join-Path $appDirectory 'resources/app.asar'
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf) -or -not (Test-Path -LiteralPath $command -PathType Leaf) -or
      -not (Test-Path -LiteralPath $runtimeArchive -PathType Leaf)) { throw 'The official Desktop executable, bundled CLI, or app.asar is missing.' }
    # Invoke the exact entry used by dsh.cmd without CMD reparsing package paths.
    $cli = Join-Path $runtimeArchive 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'
    $versionOutput = & $command --expose-internals $cli --version 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'The official Desktop CLI version probe failed.' }
    $runtimeVersion = ($versionOutput | Out-String).Trim()
    $arguments = @('--expose-internals', $cli, 'plugin', '--profile', 'desktop', 'add', $archive, '--ignore-scripts')
  } else {
    $appRoot = Join-Path $appDirectory 'resources/app'
    $appManifest = Read-Json (Join-Path $appRoot 'package.json')
    if ($appManifest.name -ne 'dsh-desktop-next' -or $release.nextVersions -notcontains $appManifest.version) { throw 'This DSH NEXT application version has not been validated for this release.' }
    $runtimeManifest = Read-Json (Join-Path $appRoot 'node_modules/@deepseek-ai/dsh/package.json')
    $bootManifest = Read-Json (Join-Path $appRoot 'node_modules/@deepseek-ai/dsh-app-boot/package.json')
    $runtimeVersion = $runtimeManifest.version
    if ($runtimeManifest.name -ne '@deepseek-ai/dsh' -or $bootManifest.name -ne '@deepseek-ai/dsh-app-boot' -or $bootManifest.version -ne $runtimeVersion) {
      throw 'The DSH NEXT runtime has inconsistent dsh and app-boot versions.'
    }
    $command = Join-Path $appDirectory 'DSH NEXT.exe'
    $pluginCli = Join-Path $appRoot 'lib/plugin-cli.js'
    if (-not (Test-Path -LiteralPath $command -PathType Leaf) -or -not (Test-Path -LiteralPath $pluginCli -PathType Leaf)) { throw 'The DSH NEXT executable or package-manager entry is missing.' }
    $arguments = @('--expose-internals', $pluginCli, $Profile, 'add', $archive, '--ignore-scripts')
  }
  if ($release.runtimeVersions -notcontains $runtimeVersion) { throw "Unsupported DSH runtime: $runtimeVersion. This release requires $($release.runtimeVersions -join ', ')." }

  Write-Host "Target: $Target | Runtime: $runtimeVersion | Profile: $profileDirectory"
  Write-Host "Package: $archive | Version: $($release.version) | SHA-256 verified"
  if ($ValidateOnly) {
    Write-Host 'Validation passed. The application is stopped. No profile was changed.'
    return
  }
  Assert-ApplicationStopped $appDirectory $applicationName
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $release.sha256) { throw 'Package SHA-256 changed after validation.' }
  & $command @arguments | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Desktop package installation failed with exit code $LASTEXITCODE. Check the application's package-manager diagnostics." }
  $installed = Read-Json (Join-Path $profileDirectory 'package.json')
  if ($installed.dsh.profile.bundles -notcontains 'dsh-openai-subscription') {
    throw 'The dependency was installed but the bundle is disabled. Enable dsh-openai-subscription in the application Plugins page, then restart.'
  }
  Write-Host 'Installed and enabled. Reopen the desktop application, then open Settings > OpenAI Subscription.'
} finally {
  [Environment]::SetEnvironmentVariable('DSH_HOME', $previousHome, 'Process')
  [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $previousNodeMode, 'Process')
}

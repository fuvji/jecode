# jetcode bootstrap for Windows 10 and 11 (x64 and ARM64).
#
#   irm https://raw.githubusercontent.com/fuvji/jetcode/main/installer/install.ps1 | iex
#
# Detection and layout:
#   - Reads the OS version, CPU architecture and AVX2 support.
#   - Reuses Bun when present; otherwise installs Bun for the current user.
#   - Clones or updates jetcode under %USERPROFILE%\.jetcode\src, builds the
#     CLI for this machine, and puts a jetcode.cmd shim in
#     %USERPROFILE%\.jetcode\bin.
#
# Everything stays in the user profile. Nothing is installed machine-wide.
#
# Optional environment variables:
#   JETCODE_HOME   install root (default: %USERPROFILE%\.jetcode)
#   JETCODE_REPO   git remote (default: https://github.com/fuvji/jetcode.git)
#   JETCODE_REF    branch or tag to check out
#
# Optional parameters (when run as a file):
#   -Desktop       also build the Electron desktop app
#   -Baseline      force the non-AVX2 build

param(
  [switch]$Desktop,
  [switch]$Baseline
)

$ErrorActionPreference = "Stop"

$Repo = if ($env:JETCODE_REPO) { $env:JETCODE_REPO } else { "https://github.com/fuvji/jetcode.git" }
$Ref = $env:JETCODE_REF
$HomeDir = if ($env:JETCODE_HOME) { $env:JETCODE_HOME } else { Join-Path $env:USERPROFILE ".jetcode" }
$Src = Join-Path $HomeDir "src"
$BinDir = Join-Path $HomeDir "bin"

function Say($message) { Write-Host $message -ForegroundColor Magenta }
function Ok($message) { Write-Host "  + $message" -ForegroundColor Green }
function Warn($message) { Write-Host "  ! $message" -ForegroundColor Yellow }
function Fail($message) {
  Write-Host "jetcode install: $message" -ForegroundColor Red
  exit 1
}

# ---------- 1. Detect ----------

$OS = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
$Arch = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
  "X64" { "x64" }
  "Arm64" { "arm64" }
  default { Fail "unsupported architecture: $([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture)" }
}

$Avx2 = $false
if ($Arch -eq "x64") {
  try { $Avx2 = [System.Runtime.Intrinsics.X86.Avx2]::IsSupported } catch { $Avx2 = $true }
}
if ($Baseline) { $Avx2 = $false }

Say "jetcode installer"
Ok "$OS"
Ok "$Arch · $(if ($Avx2) { 'AVX2 build' } else { 'baseline build' })"

# ---------- 2. Prepare ----------

foreach ($tool in @("git", "curl.exe")) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Fail "$tool is required. Install it (winget install Git.Git / curl), then rerun."
  }
}

$bunCommand = Get-Command bun -ErrorAction SilentlyContinue
$Bun = if ($bunCommand) { $bunCommand.Source } else { $null }
if (-not $Bun) {
  $candidate = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
  if (Test-Path $candidate) { $Bun = $candidate }
}

if (-not $Bun) {
  Say "Installing Bun for the current user…"
  try {
    Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression
  } catch {
    Fail "Bun install failed. Install Bun from https://bun.sh and rerun."
  }
  $candidate = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
  if (Test-Path $candidate) { $Bun = $candidate } else { Fail "Bun was not found after install." }
}
$env:Path = "$env:Path;$(Split-Path $Bun -Parent)"
Ok "bun $(& $Bun --version)"

# ---------- 3. Checkout ----------

if (Test-Path (Join-Path $Src ".git")) {
  Say "Updating $Src…"
  try {
    & git -C $Src fetch --depth 1 origin | Out-Null
    if ($Ref) { & git -C $Src checkout $Ref | Out-Null }
    & git -C $Src pull --ff-only | Out-Null
    Ok "checkout ready"
  } catch {
    Warn "update skipped (local changes or offline); building the current checkout"
  }
} else {
  Say "Cloning jetcode into $Src…"
  New-Item -ItemType Directory -Force -Path (Split-Path $Src -Parent) | Out-Null
  if ($Ref) {
    & git clone --depth 1 --branch $Ref $Repo $Src | Out-Null
  } else {
    & git clone --depth 1 $Repo $Src | Out-Null
  }
  if ($LASTEXITCODE -ne 0) { Fail "clone failed: $Repo" }
  Ok "cloned"
}

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

# ---------- 4. Build ----------

Say "Installing dependencies…"
Push-Location $Src
try {
  & $Bun install
  if ($LASTEXITCODE -ne 0) { Fail "dependency install failed" }

  Say "Building the jetcode CLI…"
  $buildArgs = @("--cwd", "packages/cli", "build", "--single")
  if (-not $Avx2) { $buildArgs += "--baseline" }
  & $Bun @buildArgs
  if ($LASTEXITCODE -ne 0) { Fail "CLI build failed" }

  $binary = Get-ChildItem (Join-Path $Src "packages\cli\dist") -Recurse -Filter "opencode.exe" -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $binary) { Fail "build finished but no CLI binary was found under packages\cli\dist" }
  Ok "built $($binary.FullName)"

  $shim = Join-Path $BinDir "jetcode.cmd"
  @(
    "@echo off",
    "`"$($binary.FullName)`" %*"
  ) | Set-Content -Path $shim -Encoding ASCII
  Ok "created $shim"

  if ($Desktop) {
    Say "Building the desktop app…"
    & $Bun --cwd packages/desktop build
    if ($LASTEXITCODE -ne 0) { Warn "desktop build failed; the CLI is still installed" }
  }
} finally {
  Pop-Location
}

# ---------- 5. PATH ----------

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$entries = @()
if ($userPath) { $entries = $userPath.Split(";", [System.StringSplitOptions]::RemoveEmptyEntries) }
if ($entries -notcontains $BinDir) {
  $next = (@($entries) + $BinDir) -join ";"
  [Environment]::SetEnvironmentVariable("Path", $next, "User")
  Ok "added $BinDir to your user PATH"
} else {
  Ok "$BinDir is already on your PATH"
}
$env:Path = "$env:Path;$BinDir"

Say "Done. Open a new terminal and run: jetcode --version"
Say "Then open a project and run: jetcode"

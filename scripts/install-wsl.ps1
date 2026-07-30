[CmdletBinding()]
param(
  [ValidateSet("all", "openclaw", "hermes")]
  [string]$Target = "all",
  [string]$Distribution = "Ubuntu-26.04",
  [switch]$Restart
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$wslRoot = (& wsl.exe -d $Distribution -- wslpath -a $root).Trim()
if (-not $wslRoot) {
  throw "WSL path conversion failed."
}

$scriptPath = "$wslRoot/scripts/install-wsl.sh"
$commandParts = @($scriptPath, "--$Target")
if ($Restart) {
  $commandParts += "--restart"
}

function ConvertTo-BashLiteral([string]$Value) {
  return "'" + $Value.Replace("'", "'""'""'") + "'"
}

$command = "exec " + (($commandParts | ForEach-Object { ConvertTo-BashLiteral $_ }) -join " ")
& wsl.exe -d $Distribution -- bash -lc $command
if ($LASTEXITCODE -ne 0) {
  throw "WSL installer exited with code $LASTEXITCODE."
}

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Target,
  [Parameter(Position = 1)]
  [string]$Command
)

if ($Command -eq "help" -or $Command -eq "--help" -or $Command -eq "-h") {
  Write-Output "The model router is shipped for macOS only."
  exit 0
}

Write-Error "codex-router: unsupported_platform"
exit 2

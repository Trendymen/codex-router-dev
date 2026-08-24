[CmdletBinding()]
param(
  [switch]$Help,
  [switch]$CheckoutInstall,
  [switch]$ForceDeps,
  [switch]$PrepareOnly,
  [switch]$MigrateKnown,
  [string]$Target,
  [string]$Providers,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)

if ($Help) {
  Write-Output "Usage: install.ps1"
  Write-Output "The model router is shipped for macOS only; use install.sh on macOS."
  exit 0
}

Write-Error "codex-router: unsupported_platform"
exit 2

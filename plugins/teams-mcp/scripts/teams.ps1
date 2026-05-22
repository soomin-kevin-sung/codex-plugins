[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$TeamsArgs
)

$ErrorActionPreference = "Stop"

$installer = Join-Path $PSScriptRoot "install-teams-cli.ps1"
$installJson = & $installer
$install = $installJson | ConvertFrom-Json

& $install.binaryPath @TeamsArgs
exit $LASTEXITCODE

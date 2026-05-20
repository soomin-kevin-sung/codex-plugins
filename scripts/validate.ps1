$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$marketplacePath = Join-Path $root ".agents\plugins\marketplace.json"
$pluginPath = Join-Path $root "plugins\jira"
$pluginManifestPath = Join-Path $pluginPath ".codex-plugin\plugin.json"
$mcpPath = Join-Path $pluginPath ".mcp.json"

foreach ($path in @($marketplacePath, $pluginManifestPath, $mcpPath)) {
    if (-not (Test-Path $path)) {
        throw "Missing required file: $path"
    }
}

$marketplace = Get-Content -Raw -Path $marketplacePath | ConvertFrom-Json
$plugin = Get-Content -Raw -Path $pluginManifestPath | ConvertFrom-Json
$mcp = Get-Content -Raw -Path $mcpPath | ConvertFrom-Json

if ($plugin.name -ne "jira") {
    throw "Unexpected plugin name: $($plugin.name)"
}

if ($plugin.mcpServers -ne "./.mcp.json") {
    throw "plugin.json must point mcpServers to ./.mcp.json"
}

if (-not $mcp.mcpServers.jira) {
    throw ".mcp.json must define mcpServers.jira"
}

if ($mcp.mcpServers.jira.command -ne "npx") {
    throw "Jira MCP command must be npx"
}

if (-not ($mcp.mcpServers.jira.args -contains "https://mcp.atlassian.com/v1/mcp/authv2")) {
    throw "Jira MCP args must include the Atlassian remote MCP URL"
}

if (-not ($marketplace.plugins | Where-Object { $_.name -eq "jira" })) {
    throw "marketplace.json must register the jira plugin"
}

Write-Host "Validation passed."
Write-Host "Marketplace: $marketplacePath"

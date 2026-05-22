$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$marketplacePath = Join-Path $root ".agents\plugins\marketplace.json"

if (-not (Test-Path $marketplacePath)) {
    throw "Missing required file: $marketplacePath"
}

$marketplace = Get-Content -Raw -Path $marketplacePath | ConvertFrom-Json
$expectedPlugins = @(
    @{
        Name = "jira-mcp"
        ServerName = "jira"
        ServerCheck = {
            param($server, $pluginPath)

            if ($server.command -ne "npx") {
                throw "Jira MCP command must be npx"
            }

            if (-not ($server.args -contains "https://mcp.atlassian.com/v1/mcp/authv2")) {
                throw "Jira MCP args must include the Atlassian remote MCP URL"
            }
        }
    },
    @{
        Name = "notion-mcp"
        ServerName = "notion"
        ServerCheck = {
            param($server, $pluginPath)

            if ($server.url -ne "https://mcp.notion.com/mcp") {
                throw "Notion MCP URL must be https://mcp.notion.com/mcp"
            }
        }
    },
    @{
        Name = "teams-mcp"
        ServerName = "teams"
        ServerCheck = {
            param($server, $pluginPath)

            if ($server.command -ne "node") {
                throw "Teams MCP command must be node"
            }

            if (-not ($server.args -contains "./mcp/server.js")) {
                throw "Teams MCP args must include ./mcp/server.js"
            }

            foreach ($relativePath in @(
                "mcp\server.js",
                "scripts\install-teams-cli.ps1",
                "scripts\teams.ps1",
                "tests\server.test.js"
            )) {
                $path = Join-Path $pluginPath $relativePath
                if (-not (Test-Path -LiteralPath $path)) {
                    throw "Missing Teams MCP support file: $path"
                }
            }
        }
    }
)

foreach ($expected in $expectedPlugins) {
    $name = $expected.Name
    $pluginPath = Join-Path $root "plugins\$name"
    $pluginManifestPath = Join-Path $pluginPath ".codex-plugin\plugin.json"
    $mcpPath = Join-Path $pluginPath ".mcp.json"

    foreach ($path in @($pluginManifestPath, $mcpPath)) {
        if (-not (Test-Path $path)) {
            throw "Missing required file: $path"
        }
    }

    $plugin = Get-Content -Raw -Path $pluginManifestPath | ConvertFrom-Json
    $mcp = Get-Content -Raw -Path $mcpPath | ConvertFrom-Json

    if ($plugin.name -ne $name) {
        throw "Unexpected plugin name in ${pluginManifestPath}: $($plugin.name)"
    }

    if ($plugin.mcpServers -ne "./.mcp.json") {
        throw "$name plugin.json must point mcpServers to ./.mcp.json"
    }

    if (-not $plugin.skills) {
        throw "$name plugin.json must define a skills path"
    }

    $skillsRelativePath = ([string]$plugin.skills).Replace("/", "\")
    $skillsPath = Join-Path $pluginPath $skillsRelativePath
    if (-not (Test-Path -LiteralPath $skillsPath -PathType Container)) {
        throw "$name plugin skills path does not exist: $skillsPath"
    }

    $skillFiles = Get-ChildItem -LiteralPath $skillsPath -Recurse -File -Filter "SKILL.md"
    if (-not $skillFiles) {
        throw "$name plugin skills path must contain at least one SKILL.md"
    }

    $serverName = $expected.ServerName
    $server = $mcp.mcpServers.$serverName

    if (-not $server) {
        throw "$mcpPath must define mcpServers.$serverName"
    }

    & $expected.ServerCheck $server $pluginPath

    $marketplaceEntry = $marketplace.plugins | Where-Object {
        $_.name -eq $name -and
        $_.source.source -eq "local" -and
        $_.source.path -eq "./plugins/$name" -and
        $_.policy.installation -eq "AVAILABLE" -and
        $_.policy.authentication -eq "ON_INSTALL" -and
        $_.category -eq "Productivity"
    }

    if (-not $marketplaceEntry) {
        throw "marketplace.json must register the $name plugin with the expected policy and path"
    }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is required to run Teams MCP tests"
}

& node --test (Join-Path $root "plugins\teams-mcp\tests\server.test.js")
if ($LASTEXITCODE -ne 0) {
    throw "Teams MCP tests failed"
}

Write-Host "Validation passed."
Write-Host "Marketplace: $marketplacePath"

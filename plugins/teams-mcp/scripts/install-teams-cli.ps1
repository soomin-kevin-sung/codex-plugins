[CmdletBinding()]
param(
    [switch]$Force,
    [string]$InstallRoot
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Net.Http

$isWindows = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
    [System.Runtime.InteropServices.OSPlatform]::Windows
)
$osArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture

if (-not $isWindows -or $osArchitecture -ne [System.Runtime.InteropServices.Architecture]::X64) {
    throw "teams-cli release install is currently supported only on Windows x86_64."
}

if (-not $InstallRoot) {
    if ($env:TEAMS_CLI_HOME) {
        $InstallRoot = $env:TEAMS_CLI_HOME
    } elseif ($env:LOCALAPPDATA) {
        $InstallRoot = Join-Path $env:LOCALAPPDATA "Codex\teams-cli"
    } else {
        throw "LOCALAPPDATA is not set. Set TEAMS_CLI_HOME to choose an install directory."
    }
}

$binDir = Join-Path $InstallRoot "bin"
$stateDir = Join-Path $InstallRoot "state"
$binaryPath = Join-Path $binDir "teams.exe"
$statePath = Join-Path $stateDir "release.json"
$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

$state = $null
if (Test-Path -LiteralPath $statePath) {
    try {
        $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    } catch {
        $state = $null
    }
}

function Test-CachedBinaryHash {
    param(
        [string]$Path,
        [object]$State,
        [string]$ExpectedSha256
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }

    $sha = $ExpectedSha256
    if (-not $sha -and $State -and $State.sha256) {
        $sha = [string]$State.sha256
    }

    if (-not $sha -or $sha -notmatch '^[a-fA-F0-9]{64}$') {
        return $false
    }

    $actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
    return $actualSha256 -eq $sha.ToLowerInvariant()
}

function Save-UrlWithLimit {
    param(
        [string]$Uri,
        [string]$Path,
        [Int64]$MaxBytes
    )

    $client = [System.Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds(120)

    try {
        $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $Uri)
        $request.Headers.UserAgent.ParseAdd("codex-teams-mcp")
        $response = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        $response.EnsureSuccessStatusCode() | Out-Null

        if ($response.Content.Headers.ContentLength -and $response.Content.Headers.ContentLength -gt $MaxBytes) {
            throw "Release asset exceeded $MaxBytes bytes."
        }

        $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $outputStream = [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $buffer = New-Object byte[] 81920
        [Int64]$total = 0

        try {
            while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $total += $read
                if ($total -gt $MaxBytes) {
                    throw "Release asset exceeded $MaxBytes bytes."
                }
                $outputStream.Write($buffer, 0, $read)
            }
        } finally {
            $outputStream.Dispose()
            $inputStream.Dispose()
            $response.Dispose()
        }
    } finally {
        $client.Dispose()
    }
}

function Write-JsonAtomic {
    param(
        [string]$Path,
        [object]$Value
    )

    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $tempPath = "$Path.$PID.$nowMs.tmp"
    try {
        $Value | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $tempPath -Encoding UTF8
        Move-Item -LiteralPath $tempPath -Destination $Path -Force
    } catch {
        Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
        throw
    }
}

if (-not $Force -and (Test-CachedBinaryHash -Path $binaryPath -State $state)) {
    [pscustomobject]@{
        binaryPath = $binaryPath
        source = "cache"
        installed = $false
        version = $state.version
        assetName = $state.assetName
    } | ConvertTo-Json -Depth 5
    return
}

$release = Invoke-RestMethod `
    -Uri "https://api.github.com/repos/soomin-kevin-sung/teams-cli/releases/latest" `
    -Headers @{ "User-Agent" = "codex-teams-mcp" } `
    -TimeoutSec 60

$asset = $release.assets |
    Where-Object { $_.name -match '^teams-v[^\\/]+-windows-x86_64\.exe$' -and $_.browser_download_url } |
    Select-Object -First 1

if (-not $asset) {
    throw "Latest teams-cli release does not contain a Windows x86_64 executable asset."
}

if (-not ($asset.digest -match '^sha256:([a-fA-F0-9]{64})$')) {
    throw "Release asset is missing a supported sha256 digest."
}

$sha256 = $Matches[1].ToLowerInvariant()
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$tempPath = "$binaryPath.$PID.$nowMs.download"

try {
    $maxBytes = 64 * 1024 * 1024
    Save-UrlWithLimit -Uri $asset.browser_download_url -Path $tempPath -MaxBytes $maxBytes
    $actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $tempPath).Hash.ToLowerInvariant()
    if ($actualSha256 -ne $sha256) {
        throw "Checksum mismatch for $($asset.name): expected $sha256, got $actualSha256."
    }
    Move-Item -LiteralPath $tempPath -Destination $binaryPath -Force
} catch {
    Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    throw
}

$nextState = [ordered]@{
    version = $release.tag_name
    assetName = $asset.name
    sha256 = $sha256
    releaseUrl = $release.html_url
    downloadUrl = $asset.browser_download_url
    installedAt = $nowMs
}
Write-JsonAtomic -Path $statePath -Value $nextState

[pscustomobject]@{
    binaryPath = $binaryPath
    source = "github_release"
    installed = $true
    version = $release.tag_name
    assetName = $asset.name
    releaseUrl = $release.html_url
    sha256 = $sha256
} | ConvertTo-Json -Depth 5

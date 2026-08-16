<#
.SYNOPSIS
    Starts the Tableau MCP App server and a cloudflared tunnel, then prints the
    URL to paste into ChatGPT.

.DESCRIPTION
    Replaces a five-step ritual that was previously done by hand in two windows:
    start node, start cloudflared, find the window that printed the hostname,
    append /mcp, and discover only after registering the connector that a
    credential or the viz URL was wrong.

    This script fails *before* spending a tunnel if the server's preflight finds
    a blocking problem, because a bad hostname or credential costs a
    delete-and-re-add of the ChatGPT connector to correct.

    Credentials are read from the environment and are neither written to disk nor
    echoed. Set them in this shell before running.

.PARAMETER TunnelName
    Use a pre-configured named tunnel instead of a quick tunnel. Requires
    -TunnelHostname. See "Named tunnels" in README.md - a named tunnel only
    yields a stable *public* hostname if you own a domain on Cloudflare.

.PARAMETER TunnelHostname
    The stable hostname routed to -TunnelName, e.g. tableau-mcp.example.com.

.PARAMETER NoTunnel
    Start only the server. Useful for local testing against 127.0.0.1.

.EXAMPLE
    .\run.ps1
    Quick tunnel. Hostname changes every run, so the ChatGPT connector must be
    deleted and re-added each time.

.EXAMPLE
    .\run.ps1 -TunnelName tableau-mcp -TunnelHostname tableau-mcp.example.com
    Stable hostname. The connector survives restarts.
#>
[CmdletBinding()]
param(
    [int]$Port = 8792,
    [string]$TunnelName,
    [string]$TunnelHostname,
    [switch]$EmbedDebug,
    [switch]$NoTunnel
)

$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
$logDir = Join-Path $appRoot 'outputs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$serverLog = Join-Path $logDir 'server.err.log'
$serverOut = Join-Path $logDir 'server.out.log'
$tunnelLog = Join-Path $logDir 'tunnel.err.log'
$tunnelOut = Join-Path $logDir 'tunnel.out.log'
$urlFile = Join-Path $logDir 'tunnel-url.txt'

$started = @()

function Resolve-Cloudflared {
    # winget installs cloudflared outside the default shell PATH - the same trap
    # Node hit on this machine. Check PATH first, then the known install location.
    $onPath = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    $known = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
    if (Test-Path $known) { return $known }
    throw "cloudflared not found. Install with: winget install --id Cloudflare.cloudflared"
}

function Wait-ForHealth {
    param([string]$Url, [int]$TimeoutSeconds = 30)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            # -SkipHttpErrorCheck is not on 5.1, so a 503 lands in the catch and
            # its body has to be read off the exception response.
            $raw = (Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5).Content
            return $raw | ConvertFrom-Json
        } catch {
            $resp = $_.Exception.Response
            if ($resp) {
                $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
                $body = $reader.ReadToEnd()
                if ($body) { return $body | ConvertFrom-Json }
            }
            Start-Sleep -Milliseconds 500
        }
    }
    return $null
}

function Wait-ForQuickTunnelUrl {
    param([string]$LogPath, [int]$TimeoutSeconds = 45)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $LogPath) {
            $match = Select-String -Path $LogPath -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' `
                -AllMatches -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($match) { return $match.Matches[0].Value }
        }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

try {
    if ($EmbedDebug) {
        $env:EMBED_DEBUG = '1'
        Write-Host 'EMBED_DEBUG=1 - on-screen diagnostic panel forced on. Not for a demo.' -ForegroundColor Yellow
        Write-Host '  (probe JSON in the chat is a separate switch, EMBED_PROBE_MESSAGES.)' -ForegroundColor DarkGray
    }
    else {
        # Cleared, not merely left unset. Running `.\run.ps1 -EmbedDebug` directly
        # in a PowerShell session sets EMBED_DEBUG on *that session*, where it
        # outlives the run - so the next `.\run.ps1` with no switch would silently
        # start with the panel on. That is a demo landmine: you find out on camera.
        # Same for the probe messages, which put JSON in the transcript.
        $env:EMBED_DEBUG = $null
        $env:EMBED_PROBE_MESSAGES = $null
    }
    # Deliberately NOT cleared: state-by-message is how on-screen state reaches
    # the model at all (see DECISIONS, 2026-08-15). Clearing it would give a
    # clean transcript and a dashboard the model cannot see.
    $env:MCP_TRANSPORT = 'http'
    $env:PORT = "$Port"

    Write-Host "Starting server on 127.0.0.1:$Port ..." -ForegroundColor Cyan
    $server = Start-Process -FilePath 'node' -ArgumentList 'src/server.js' `
        -WorkingDirectory $appRoot -PassThru -NoNewWindow `
        -RedirectStandardError $serverLog -RedirectStandardOutput $serverOut
    $started += $server

    $health = Wait-ForHealth -Url "http://127.0.0.1:$Port/healthz"
    if (-not $health) {
        Write-Host "Server did not become healthy. Last output:" -ForegroundColor Red
        if (Test-Path $serverLog) { Get-Content $serverLog -Tail 40 }
        throw 'Server failed to start.'
    }

    Write-Host ''
    Write-Host "  viz  : $($health.viz)"
    Write-Host "  auth : $($health.auth)"
    Write-Host "  preflight: $($health.preflight.status)"

    foreach ($f in $health.preflight.findings) {
        $color = switch ($f.status) {
            'FAIL' { 'Red' }
            'WARN' { 'Yellow' }
            'INCONCLUSIVE' { 'Yellow' }
            default { 'DarkGray' }
        }
        Write-Host "    [$($f.status)] $($f.label)" -ForegroundColor $color
        if ($f.detail) { Write-Host "        $($f.detail)" -ForegroundColor DarkGray }
    }
    Write-Host ''

    if (-not $health.ok) {
        # Stopping here is the whole point: every one of these otherwise appears
        # inside ChatGPT as an opaque auth-failed, after the connector is already
        # registered against a tunnel that is about to be thrown away.
        throw 'Preflight found a blocking problem. Fix it before registering the connector.'
    }

    if ($NoTunnel) {
        Write-Host "Server only (-NoTunnel). Endpoint: http://127.0.0.1:$Port/mcp" -ForegroundColor Green
    }
    else {
        $cloudflared = Resolve-Cloudflared

        if ($TunnelName) {
            if (-not $TunnelHostname) {
                throw '-TunnelName requires -TunnelHostname (the hostname routed to that tunnel).'
            }
            Write-Host "Starting named tunnel '$TunnelName' ..." -ForegroundColor Cyan
            $tunnelArgs = @('tunnel', 'run', '--url', "http://127.0.0.1:$Port", $TunnelName)
            $publicUrl = "https://$TunnelHostname"
        }
        else {
            Write-Host 'Starting quick tunnel ...' -ForegroundColor Cyan
            $tunnelArgs = @('tunnel', '--url', "http://127.0.0.1:$Port")
            $publicUrl = $null
        }

        $tunnel = Start-Process -FilePath $cloudflared -ArgumentList $tunnelArgs `
            -WorkingDirectory $appRoot -PassThru -NoNewWindow `
            -RedirectStandardError $tunnelLog -RedirectStandardOutput $tunnelOut
        $started += $tunnel

        if (-not $publicUrl) {
            $publicUrl = Wait-ForQuickTunnelUrl -LogPath $tunnelLog
            if (-not $publicUrl) {
                Write-Host 'Could not read the quick tunnel hostname. Tunnel log:' -ForegroundColor Red
                if (Test-Path $tunnelLog) { Get-Content $tunnelLog -Tail 40 }
                throw 'Tunnel did not report a hostname.'
            }
        }

        $mcpUrl = "$publicUrl/mcp"
        Set-Content -Path $urlFile -Value $mcpUrl -Encoding utf8

        Write-Host ''
        Write-Host '  Register this in ChatGPT (Connectors, auth: None):' -ForegroundColor Green
        Write-Host "      $mcpUrl" -ForegroundColor White
        Write-Host ''
        if (-not $TunnelName) {
            Write-Host '  Quick tunnel: this hostname dies with the process, so the ChatGPT' -ForegroundColor DarkYellow
            Write-Host '  connector must be deleted and re-added. See "Named tunnels" in README.md.' -ForegroundColor DarkYellow
            Write-Host ''
        }
        Write-Host "  Also saved to: $urlFile" -ForegroundColor DarkGray
    }

    Write-Host "  Logs: $serverLog" -ForegroundColor DarkGray
    Write-Host ''
    Write-Host 'Running. Press Ctrl+C to stop both processes.' -ForegroundColor Cyan

    while ($true) {
        foreach ($p in $started) {
            if ($p.HasExited) { throw "Process $($p.ProcessName) (pid $($p.Id)) exited unexpectedly." }
        }
        Start-Sleep -Seconds 2
    }
}
finally {
    # Leaving a stray cloudflared behind is how a later run silently binds a
    # second tunnel to the same port.
    foreach ($p in $started) {
        if ($p -and -not $p.HasExited) {
            Write-Host "Stopping $($p.ProcessName) (pid $($p.Id)) ..." -ForegroundColor DarkGray
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        }
    }
}

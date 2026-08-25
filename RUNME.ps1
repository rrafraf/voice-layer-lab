[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$url = 'http://127.0.0.1:4317/'
$serverProcess = $null

function Write-Step([string]$message) {
    Write-Host "`n==> $message" -ForegroundColor Cyan
}

function Test-VoiceLab {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2
        return $response.StatusCode -eq 200 -and $response.Content.Contains('Voice Layer')
    }
    catch {
        return $false
    }
}

Set-Location -LiteralPath $projectRoot

try {
    Write-Step 'Checking Node.js and npm'
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $null = Get-Command npm.cmd -ErrorAction Stop

    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot '.env.local'))) {
        throw 'Missing .env.local. Add GEMINI_API_KEY before running Voice Layer.'
    }

    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) {
        Write-Step 'Installing dependencies (first run only)'
        & npm.cmd install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
    }

    Write-Step 'Building Voice Layer'
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE" }

    if (Test-VoiceLab) {
        Write-Step 'Voice Layer is already running'
        Start-Process $url
        Write-Host 'The existing server was left running.' -ForegroundColor Green
        Read-Host 'Press Enter to close this window'
        exit 0
    }

    $portOwner = Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue
    if ($portOwner) {
        throw "Port 4317 is already used by another process (PID $($portOwner.OwningProcess))."
    }

    Write-Step 'Starting the local server'
    $env:VOICE_UI_OPEN = '0'
    $serverProcess = Start-Process `
        -FilePath $node `
        -ArgumentList 'dist/src/server.js' `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -PassThru

    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline -and -not (Test-VoiceLab)) {
        if ($serverProcess.HasExited) {
            throw "Voice Layer server exited early with code $($serverProcess.ExitCode)."
        }
        Start-Sleep -Milliseconds 300
    }
    if (-not (Test-VoiceLab)) { throw 'Voice Layer did not become ready within 15 seconds.' }

    Write-Step 'Opening Voice Layer'
    Start-Process $url
    Write-Host "Ready at $url" -ForegroundColor Green
    Write-Host 'Keep this window open while using the app.'
    $null = Read-Host 'Press Enter here to stop Voice Layer'
}
catch {
    Write-Host "`nVoice Layer could not start:`n$($_.Exception.Message)" -ForegroundColor Red
    $null = Read-Host 'Press Enter to close'
    exit 1
}
finally {
    if ($serverProcess -and -not $serverProcess.HasExited) {
        Write-Step 'Stopping Voice Layer'
        Stop-Process -Id $serverProcess.Id -ErrorAction SilentlyContinue
        $serverProcess.WaitForExit(3000)
    }
}


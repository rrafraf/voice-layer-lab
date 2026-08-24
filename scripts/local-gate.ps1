[CmdletBinding()]
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

function Write-Step([string]$message) {
    Write-Host "`n==> $message" -ForegroundColor Cyan
}

function Invoke-Checked([string]$file, [string[]]$arguments) {
    & $file @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$file $($arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

Set-Location -LiteralPath $projectRoot

Write-Step 'Checking local safety ignores'
$gitignore = Get-Content -LiteralPath (Join-Path $projectRoot '.gitignore') -Raw
foreach ($required in @('node_modules/', 'dist/', '.env.local', 'logs/', 'runs/')) {
    if (-not $gitignore.Contains($required)) {
        throw ".gitignore must include $required before pushing."
    }
}

if (Test-Path -LiteralPath (Join-Path $projectRoot '.git')) {
    Write-Step 'Checking that secrets are not tracked'
    $trackedSecrets = & git ls-files -- '.env' '.env.local' '*.pem' '*.key' '*credentials*' 2>$null
    if ($trackedSecrets) {
        throw "Refusing to continue because secret-looking files are tracked: $($trackedSecrets -join ', ')"
    }
}

if (-not $SkipBuild) {
    Write-Step 'Running project checks'
    Invoke-Checked 'npm.cmd' @('run', 'check')
}

Write-Step 'Local gate passed'

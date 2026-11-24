# Windows PowerShell: installs claude-memory with Node.js >= 22.18.
# Set $env:NODE to a node.exe path when the default `node` is older. All arguments go to install.mjs (see --help).
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 [--no-live] [--uninstall] ...
$ErrorActionPreference = 'Stop'
$node = if ($env:NODE) { $env:NODE } else { 'node' }
if (-not (Get-Command $node -ErrorAction SilentlyContinue)) {
    Write-Error 'Node.js >= 22.18 is required: https://nodejs.org (or set $env:NODE to node.exe)'
    exit 1
}
& $node (Join-Path $PSScriptRoot 'install.mjs') @args
exit $LASTEXITCODE

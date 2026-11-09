param(
    [switch]$SkipNodeCheck,
    [switch]$Force,
    [switch]$Docker,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'
if ($Help) {
    Write-Host 'Usage: .\setup.ps1 [-SkipNodeCheck] [-Force] [-Docker]'
    Write-Host 'Installs locked npm and Python dependencies, then checks types, tests, and build.'
    Write-Host 'Requires Node.js 22.13+ (24 LTS recommended), npm, and uv.'
    Write-Host '-Force refreshes downloads while preserving the lockfiles.'
    exit 0
}

Push-Location -LiteralPath $PSScriptRoot
try {
    foreach ($spcCommand in @('node', 'npm', 'uv')) {
        if (-not (Get-Command $spcCommand -ErrorAction SilentlyContinue)) {
            throw "$spcCommand is required. See SETUP.md. Install uv on Windows with: winget install --id astral-sh.uv -e"
        }
    }
    if (-not $SkipNodeCheck) {
        node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (!((major === 22 && minor >= 13) || major === 24 || major >= 26)) { console.error('Use Node.js 22.13+, 24 LTS, or 26+.'); process.exit(1); }"
        if ($LASTEXITCODE -ne 0) { throw 'Unsupported Node.js version.' }
    }
    Write-Host 'Installing frontend dependencies from package-lock.json...'
    if ($Force) { npm ci --prefer-online } else { npm ci }
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    Write-Host 'Installing the gateway dependencies (uv manages Python 3.12)...'
    uv sync --frozen --python 3.12 --project services/dspy-gateway
    if ($LASTEXITCODE -ne 0) { throw 'Gateway installation failed.' }
    foreach ($spcCheck in @('typecheck', 'test', 'build')) {
        npm run $spcCheck
        if ($LASTEXITCODE -ne 0) { throw "npm run $spcCheck failed." }
    }
    if ($Docker) {
        docker build -t spc-analysis-tool:local .
        if ($LASTEXITCODE -ne 0) { throw 'Docker build failed.' }
        Write-Host 'Run locally: docker run --rm -p 8080:8080 spc-analysis-tool:local'
    }
    Write-Host 'Setup complete. Configure AI_API_KEY, AI_API_URL, and AI_MODEL in .env, then run npm run dev.'
} catch {
    Write-Error $_
    exit 1
} finally {
    Pop-Location
}

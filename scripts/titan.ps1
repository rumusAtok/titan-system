<#
.SYNOPSIS
  Operates the local TITAN development stack.

.DESCRIPTION
  One entry point for setup, start, health check, tests and shutdown.
  Works in Windows PowerShell 5.1 and PowerShell 7.

.PARAMETER Command
  setup    Check prerequisites, create .env, install Node dependencies
  up       Build and start the selected profiles, wait until healthy, seed demo data
  status   Show the health of every service as reported by the API gateway
  seed     Load the synthetic demonstration data (safe to repeat)
  test     Run unit tests (in a container) and the integration tests
  down     Stop the stack (data volumes are kept)
  destroy  Stop the stack AND delete all local data volumes (asks for confirmation)

.PARAMETER Profiles
  Compose profiles for "up" / "down". Default: core, iot.
  Available: core iot analytics ai observability dr-lab

.EXAMPLE
  ./scripts/titan.ps1 setup
  ./scripts/titan.ps1 up
  ./scripts/titan.ps1 up -Profiles core,iot,analytics,ai,observability
  ./scripts/titan.ps1 status
  ./scripts/titan.ps1 down
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('setup', 'up', 'status', 'seed', 'test', 'down', 'destroy')]
  [string]$Command,

  [string[]]$Profiles = @('core', 'iot')
)

# Native tools write progress to stderr; that must not abort the script (PowerShell 5.1).
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$allProfiles = @('core', 'iot', 'analytics', 'ai', 'observability', 'dr-lab')
foreach ($p in $Profiles) {
  if ($allProfiles -notcontains $p) { Write-Error "Unknown profile '$p'. Available: $($allProfiles -join ', ')"; exit 2 }
}
$profileArgs = @()
foreach ($p in $Profiles) { $profileArgs += @('--profile', $p) }

function Test-Tool([string]$name, [string]$versionArg = '--version') {
  $found = Get-Command $name -ErrorAction SilentlyContinue
  if (-not $found) { Write-Host "  [missing] $name" -ForegroundColor Red; return $false }
  $version = (& $name $versionArg 2>$null | Select-Object -First 1)
  Write-Host "  [ok]      $name  $version"
  return $true
}

function Assert-Docker {
  docker info --format '{{.ServerVersion}}' *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'The Docker daemon is not running. Start Docker Desktop and try again.' -ForegroundColor Red
    exit 1
  }
}

function Wait-Healthy([int]$timeoutSeconds = 420) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $rows = docker compose @profileArgs ps --format '{{.Service}}|{{.Health}}|{{.State}}'
    $waiting = @($rows | Where-Object { $_ -and ($_ -notmatch '\|healthy\|') -and ($_ -notmatch '\|\|running$') })
    if ($waiting.Count -eq 0) { return $true }
    Write-Host ("  waiting for: " + (($waiting | ForEach-Object { ($_ -split '\|')[0] }) -join ', '))
    Start-Sleep -Seconds 6
  }
  return $false
}

switch ($Command) {
  'setup' {
    Write-Host 'Checking prerequisites'
    $ok = (Test-Tool 'git') -and (Test-Tool 'node') -and (Test-Tool 'npm') -and (Test-Tool 'docker')
    if (-not $ok) { Write-Host 'Install the missing tools, then run setup again.' -ForegroundColor Red; exit 1 }
    $major = [int]((node --version) -replace '^v(\d+)\..*', '$1')
    if ($major -lt 22) { Write-Host "Node.js 22.12 or newer is required (found $(node --version))." -ForegroundColor Red; exit 1 }
    Assert-Docker
    if (-not (Test-Path '.env')) {
      Copy-Item '.env.example' '.env'
      Write-Host 'Created .env from .env.example (development-only values).'
    } else {
      Write-Host '.env already exists; left unchanged.'
    }
    Write-Host 'Installing Node dependencies'
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host ''
    Write-Host 'Setup complete. Next: ./scripts/titan.ps1 up' -ForegroundColor Green
  }

  'up' {
    Assert-Docker
    if (-not (Test-Path '.env')) { Write-Host 'No .env file. Run: ./scripts/titan.ps1 setup' -ForegroundColor Red; exit 1 }
    Write-Host "Building and starting profiles: $($Profiles -join ', ')"
    docker compose @profileArgs up -d --build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host 'Waiting for services to become healthy (first start takes a few minutes)'
    if (-not (Wait-Healthy)) { Write-Host 'Some services did not become healthy. Run: docker compose ps' -ForegroundColor Red; exit 1 }
    Write-Host 'Seeding synthetic demonstration data'
    node scripts/seed.mjs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host ''
    Write-Host 'TITAN is running.' -ForegroundColor Green
    Write-Host '  Web command center  http://localhost:3000'
    Write-Host '  API gateway         http://localhost:8080'
    Write-Host '  Identity (Keycloak) http://localhost:8081'
    Write-Host '  Demo users are listed in README.md; the shared demo password is DEMO_USER_PASSWORD in .env'
  }

  'status' {
    Assert-Docker
    node scripts/status.mjs
    exit $LASTEXITCODE
  }

  'seed' {
    node scripts/seed.mjs
    exit $LASTEXITCODE
  }

  'test' {
    Assert-Docker
    Write-Host 'Unit tests (Node services, in a Linux container)'
    docker build -q -f infrastructure/docker/node-service.Dockerfile --target unit-test . | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Host 'Unit tests FAILED. Re-run with details: npm run test:unit:docker' -ForegroundColor Red
      exit 1
    }
    Write-Host '  passed'
    foreach ($svc in @('data-pipeline-service', 'ai-gateway-service')) {
      Write-Host "Unit tests ($svc)"
      docker build -q -f infrastructure/docker/python-service.Dockerfile --build-arg "SERVICE_PATH=services/$svc" --target unit-test . | Out-Null
      if ($LASTEXITCODE -ne 0) { Write-Host "Unit tests of $svc FAILED." -ForegroundColor Red; exit 1 }
      Write-Host '  passed'
    }
    Write-Host 'Integration, security and contract tests (against the running stack)'
    npm run test:integration
    exit $LASTEXITCODE
  }

  'down' {
    Assert-Docker
    # Stop every profile, whatever was started; data volumes are kept.
    $everything = @()
    foreach ($p in $allProfiles + 'ai-model') { $everything += @('--profile', $p) }
    docker compose @everything down
    Write-Host 'Stopped. Data volumes were kept; start again with: ./scripts/titan.ps1 up'
  }

  'destroy' {
    Assert-Docker
    Write-Host 'This deletes ALL local TITAN data: databases, event streams, the analytical lake and Keycloak state.' -ForegroundColor Yellow
    $answer = Read-Host 'Type DELETE to continue'
    if ($answer -ne 'DELETE') { Write-Host 'Cancelled. Nothing was removed.'; exit 0 }
    $everything = @()
    foreach ($p in $allProfiles + 'ai-model') { $everything += @('--profile', $p) }
    docker compose @everything down --volumes
    Write-Host 'Stack stopped and local data volumes removed.'
  }
}

<#
.SYNOPSIS
  Runs the browser tests (Playwright) against the running local stack.

.DESCRIPTION
  The tests run inside the official Playwright container, attached to the
  compose network, so no browser has to be installed on the workstation.
  Requires: docker compose --profile core --profile iot --profile analytics --profile ai up -d ; npm run seed

.EXAMPLE
  ./scripts/test-e2e.ps1
  ./scripts/test-e2e.ps1 -Grep "navigation"
#>
param([string]$Grep = "")

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repo ".env"
$password = (Get-Content $envFile | Where-Object { $_ -match '^DEMO_USER_PASSWORD=' }) -replace '^DEMO_USER_PASSWORD=', ''
if (-not $password) { throw "DEMO_USER_PASSWORD not found in .env" }

$grepArgs = @()
if ($Grep) { $grepArgs = @("--grep", $Grep) }

# Native tools write progress to stderr; do not treat that as a failure (Windows PowerShell 5.1).
$ErrorActionPreference = "Continue"
docker image inspect mcr.microsoft.com/playwright:v1.65.0-noble *> $null
if ($LASTEXITCODE -ne 0) { docker pull --quiet mcr.microsoft.com/playwright:v1.65.0-noble | Out-Null }

docker run --rm --init --ipc=host --network titan `
  -e TITAN_E2E_FORWARD=1 -e "DEMO_USER_PASSWORD=$password" -e CI=1 `
  -v "${repo}\tests\e2e:/e2e" -v titan-e2e-node-modules:/e2e/node_modules -w /e2e `
  mcr.microsoft.com/playwright:v1.65.0-noble `
  sh -c "npm install --no-audit --no-fund --loglevel=error && npx playwright test $($grepArgs -join ' ')"
exit $LASTEXITCODE

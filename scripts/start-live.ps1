param(
  [string]$ContainerName = "luminary-stage1a-pg",
  [int]$DbPort = 55433,
  [int]$ApiPort = 4000,
  [int]$FrontendPort = 5173
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$server = Join-Path $root "luminary-server"
$frontend = Join-Path $root "luminary-frontend-project"

function Invoke-Checked {
  param(
    [string]$Description,
    [scriptblock]$Command
  )

  $output = & $Command 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed.`n$output"
  }
  return $output
}

Invoke-Checked "Docker readiness check" { docker info --format "{{.ServerVersion}}" } | Out-Null

$existing = Invoke-Checked "Docker container lookup" { docker ps -a --filter "name=^/$ContainerName$" --format "{{.Names}}" }
if (-not $existing) {
  Invoke-Checked "Postgres container create" { docker run -d --name $ContainerName -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=luminary -p "${DbPort}:5432" postgres:16 } | Out-Null
} else {
  Invoke-Checked "Postgres container start" { docker start $ContainerName } | Out-Null
}

$ready = $false
for ($attempt = 1; $attempt -le 30; $attempt++) {
  $probe = & docker exec $ContainerName pg_isready -U postgres -d luminary 2>&1
  if ($LASTEXITCODE -eq 0) {
    $ready = $true
    break
  }
  Start-Sleep -Seconds 1
}
if (-not $ready) {
  throw "Postgres container '$ContainerName' did not become ready on localhost:$DbPort."
}

$env:DATABASE_URL = "postgres://postgres:dev@localhost:$DbPort/luminary"
Push-Location $server
node --import tsx scripts\migrate.ts
if ($LASTEXITCODE -ne 0) { throw "Database migration failed." }
Invoke-Checked "App role password setup" { docker exec $ContainerName psql -U postgres -d luminary -c "ALTER ROLE luminary_app LOGIN PASSWORD 'apptest';" } | Out-Null
$practiceCount = Invoke-Checked "Practice seed count lookup" { docker exec $ContainerName psql -U postgres -d luminary -tAc "SELECT count(*) FROM luminary.practice;" }
if ([int]$practiceCount.Trim() -eq 0) {
  Invoke-Checked "Seed file copy" { docker cp (Join-Path $server "db\verify\seed.sql") "${ContainerName}:/tmp/luminary-seed.sql" } | Out-Null
  Invoke-Checked "Database seed" { docker exec $ContainerName psql -U postgres -d luminary -f /tmp/luminary-seed.sql } | Out-Null
}
node --import tsx scripts\seed-test-roles.ts
if ($LASTEXITCODE -ne 0) { throw "Test role seed failed." }
Pop-Location

$apiOrigins = "http://localhost:$FrontendPort,http://127.0.0.1:$FrontendPort"
Start-Process -FilePath powershell.exe -ArgumentList @(
  "-NoProfile",
  "-Command",
  "`$env:DATABASE_URL='postgres://luminary_app:apptest@localhost:$DbPort/luminary'; `$env:NODE_ID='cloud'; `$env:PORT='$ApiPort'; `$env:WEB_ORIGINS='$apiOrigins'; Set-Location '$server'; node --import tsx src\main.ts *> api-dev.combined.log"
) -WorkingDirectory $server -WindowStyle Hidden

Start-Sleep -Seconds 3

Start-Process -FilePath npm.cmd -ArgumentList @(
  "run",
  "dev",
  "--",
  "--host",
  "127.0.0.1",
  "--port",
  "$FrontendPort",
  "--strictPort"
) -WorkingDirectory $frontend -WindowStyle Hidden -RedirectStandardOutput (Join-Path $frontend "vite-live.log") -RedirectStandardError (Join-Path $frontend "vite-live.err.log")

Write-Host "API:      http://127.0.0.1:$ApiPort"
Write-Host "Frontend: http://127.0.0.1:$FrontendPort/index.html"

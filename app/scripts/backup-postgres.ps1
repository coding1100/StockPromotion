param(
  [string]$ContainerName = "stockpromo-postgres",
  [string]$DbUser = "postgres",
  [string]$DbName = "stockpromo",
  [string]$OutputDir = ".\\backups"
)

$ErrorActionPreference = "Stop"

if (!(Test-Path -LiteralPath $OutputDir)) {
  New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupFile = Join-Path $OutputDir "stockpromo-$timestamp.dump"

Write-Host "Creating backup at $backupFile"
docker exec $ContainerName pg_dump -U $DbUser -d $DbName -Fc > $backupFile

if (!(Test-Path -LiteralPath $backupFile)) {
  throw "Backup file was not created."
}

$size = (Get-Item -LiteralPath $backupFile).Length
Write-Host "Backup complete. Size: $size bytes"

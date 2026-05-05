param(
  [Parameter(Mandatory = $true)]
  [string]$BackupFile,
  [string]$ContainerName = "stockpromo-postgres",
  [string]$DbUser = "postgres",
  [string]$DbName = "stockpromo",
  [switch]$DropExisting
)

$ErrorActionPreference = "Stop"

if (!(Test-Path -LiteralPath $BackupFile)) {
  throw "Backup file not found: $BackupFile"
}

if ($DropExisting) {
  Write-Host "Dropping existing public schema..."
  docker exec $ContainerName psql -U $DbUser -d $DbName -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"
}

$containerBackupPath = "/tmp/restore.dump"
Write-Host "Copying backup into container..."
docker cp $BackupFile "$ContainerName`:$containerBackupPath"

Write-Host "Restoring backup..."
docker exec $ContainerName pg_restore -U $DbUser -d $DbName --clean --if-exists $containerBackupPath

Write-Host "Cleaning temp file..."
docker exec $ContainerName rm -f $containerBackupPath

Write-Host "Restore complete."

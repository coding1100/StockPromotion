param(
  [string]$ContainerName = "stockpromo-postgres",
  [string]$DbUser = "postgres",
  [string]$DbName = "stockpromo"
)

$ErrorActionPreference = "Stop"

Write-Host "Running restore verification queries..."
docker exec $ContainerName psql -U $DbUser -d $DbName -c "SELECT 'SourceEvent' AS table_name, COUNT(*) AS total FROM \"SourceEvent\";"
docker exec $ContainerName psql -U $DbUser -d $DbName -c "SELECT 'TrendTopic' AS table_name, COUNT(*) AS total FROM \"TrendTopic\";"
docker exec $ContainerName psql -U $DbUser -d $DbName -c "SELECT 'ContentDraft' AS table_name, COUNT(*) AS total FROM \"ContentDraft\";"
docker exec $ContainerName psql -U $DbUser -d $DbName -c "SELECT 'PublishJob' AS table_name, COUNT(*) AS total FROM \"PublishJob\";"
docker exec $ContainerName psql -U $DbUser -d $DbName -c "SELECT 'AuditEvent' AS table_name, COUNT(*) AS total FROM \"AuditEvent\";"

Write-Host "Verification queries completed."

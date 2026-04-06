param(
  [Parameter(Mandatory = $true)]
  [string]$FromIso,
  [Parameter(Mandatory = $true)]
  [string]$ToIso,
  [string]$Platform = "",
  [string]$BaseUrl = "http://localhost:3000/api",
  [string]$ApiKey = ""
)

$ErrorActionPreference = "Stop"

$headers = @{}
if ($ApiKey) {
  $headers["x-api-key"] = $ApiKey
}

$body = @{
  fromIso = $FromIso
  toIso = $ToIso
}
if ($Platform) {
  $body["platform"] = $Platform
}

$uri = "$BaseUrl/orchestration/publish/replay-window"
Write-Host "Calling $uri"
$response = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body ($body | ConvertTo-Json) -ContentType "application/json"
$response | ConvertTo-Json -Depth 10

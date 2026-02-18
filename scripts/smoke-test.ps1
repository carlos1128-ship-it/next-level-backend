param(
  [string]$BaseUrl = "http://localhost:3333/api",
  [string]$Email = "admin@empresa-demo.com",
  [string]$Password = "senha123"
)

$ErrorActionPreference = "Stop"

function Invoke-Api {
  param(
    [string]$Method,
    [string]$Url,
    [string]$Token = "",
    [object]$Body = $null
  )

  $headers = @{ "Content-Type" = "application/json" }
  if ($Token) { $headers["Authorization"] = "Bearer $Token" }

  if ($Body -ne $null) {
    $json = $Body | ConvertTo-Json -Depth 10
    return Invoke-RestMethod -Method $Method -Uri $Url -Headers $headers -Body $json
  }

  return Invoke-RestMethod -Method $Method -Uri $Url -Headers $headers
}

Write-Host "== Smoke Test NEXT LEVEL AI =="
Write-Host "BaseUrl: $BaseUrl"

try {
  $login = Invoke-Api -Method "POST" -Url "$BaseUrl/auth/login" -Body @{
    email = $Email
    password = $Password
  }
} catch {
  Write-Host "Falha no login com usuário seed. Tentando registro..."
  $suffix = Get-Random -Minimum 1000 -Maximum 9999
  $register = Invoke-Api -Method "POST" -Url "$BaseUrl/auth/register" -Body @{
    email = "owner$suffix@nextlevel.local"
    password = "senha123"
    companyName = "Empresa Smoke $suffix"
    companySlug = "empresa-smoke-$suffix"
    name = "Owner Smoke"
  }
  $login = $register
}

if (-not $login.accessToken) {
  throw "Token JWT não retornado em auth"
}

$token = $login.accessToken
Write-Host "Auth OK"

$sale = Invoke-Api -Method "POST" -Url "$BaseUrl/sales" -Token $token -Body @{
  amount = 129.9
  productName = "Plano Pro"
  category = "SaaS"
  occurredAt = (Get-Date).ToString("o")
}
Write-Host "Create sale OK: $($sale.id)"

$dashboard = Invoke-Api -Method "GET" -Url "$BaseUrl/sales/aggregates" -Token $token
Write-Host "Dashboard OK: today=$($dashboard.today) month=$($dashboard.month)"

$insights = Invoke-Api -Method "GET" -Url "$BaseUrl/insights" -Token $token
Write-Host "Insights OK: itens=$($insights.Count)"

$chat = Invoke-Api -Method "POST" -Url "$BaseUrl/chat" -Token $token -Body @{
  message = "Me dê um resumo rápido da operação."
}
Write-Host "Chat OK: reply length=$($chat.reply.Length)"

Write-Host "Smoke test concluído com sucesso."

param(
  [string]$BaseUrl = "http://localhost:3333/api"
)

$ErrorActionPreference = "Stop"

$backend = Start-Process -FilePath node -ArgumentList "dist/main.js" -WorkingDirectory (Resolve-Path "$PSScriptRoot\..") -PassThru

try {
  Start-Sleep -Seconds 4

  $corsHeaders = @{
    Origin = "https://next-level-front.vercel.app"
    "Access-Control-Request-Method" = "POST"
    "Access-Control-Request-Headers" = "Content-Type,Authorization"
  }
  $corsResponse = Invoke-WebRequest -Method Options -Uri "$BaseUrl/auth/login" -Headers $corsHeaders

  $suffix = Get-Random -Minimum 100000 -Maximum 999999
  $email = "sync$suffix@nextlevel.local"
  $password = "senha123"

  $registerBody = @{
    email = $email
    password = $password
    companyName = "Empresa Sync $suffix"
    companySlug = "empresa-sync-$suffix"
    name = "Sync User"
  } | ConvertTo-Json

  $register = Invoke-RestMethod -Method Post -Uri "$BaseUrl/auth/register" -ContentType "application/json" -Body $registerBody
  $token = $register.accessToken
  if (-not $token) {
    throw "Registro sem token"
  }

  $companyId = $register.user.companyId
  if (-not $companyId) {
    throw "companyId undefined apos registro"
  }

  $authHeaders = @{ Authorization = "Bearer $token" }

  $companyBody = @{ name = "Empresa Extra $suffix"; sector = "SaaS" } | ConvertTo-Json
  $company = Invoke-RestMethod -Method Post -Uri "$BaseUrl/companies" -Headers $authHeaders -ContentType "application/json" -Body $companyBody

  $chatBody = @{ companyId = $companyId; message = "Resumo financeiro para teste integrado" } | ConvertTo-Json
  $chat = Invoke-RestMethod -Method Post -Uri "$BaseUrl/chat" -Headers $authHeaders -ContentType "application/json" -Body $chatBody

  $checkScriptTemplate = @'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const userId = '__USER_ID__';
  const messages = await prisma.aiChatMessage.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 2
  });
  const missingCompany = messages.some((m) => !m.companyId);
  console.log(JSON.stringify({ count: messages.length, missingCompany }));
  await prisma.$disconnect();
})().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
'@

  $checkScript = $checkScriptTemplate.Replace("__USER_ID__", $register.user.id)

  $dbCheckRaw = $checkScript | node
  $dbCheck = $dbCheckRaw | ConvertFrom-Json

  if ($dbCheck.count -lt 2) {
    throw "Nao foram persistidas mensagens de chat"
  }

  if ($dbCheck.missingCompany -eq $true) {
    throw "Mensagem salva com companyId vazio"
  }

  [PSCustomObject]@{
    corsStatus = $corsResponse.StatusCode
    corsAllowOrigin = $corsResponse.Headers["Access-Control-Allow-Origin"]
    createdCompanyId = $company.id
    chatSource = $chat.source
    chatHasMessage = [bool]$chat.message
    savedMessages = $dbCheck.count
  } | ConvertTo-Json -Depth 5
}
finally {
  if ($backend -and -not $backend.HasExited) {
    Stop-Process -Id $backend.Id -Force
  }
}

# Configuracao do Redis para Producao (Render.com)
# 
# PROBLEMA IDENTIFICADO:
# Os logs mostram: "IMPORTANT! Eviction policy is allkeys-lru. It should be 'noeviction'"
# 
# IMPACTO:
# - Com a politica 'allkeys-lru', o Redis pode descartar chaves arbitrarias quando atinge o limite de memoria
# - Isso pode causar perda de sessoes do WhatsApp, jobs do BullMQ e dados criticos
# 
# SOLUCAO:
# 1. Para servicos Redis gerenciados (Render, AWS, etc), configurar via painel/admin
# 2. Para Redis local via Docker, usar o comando: redis-server --maxmemory-policy noeviction
# 3. No Render.com: Ir ao dashboard do Redis > Settings > Eviction Policy > noeviction

# Documentacao oficial:
# https://redis.io/docs/reference/clients/
# https://render.com/docs/redis

CONFIGURACAO_RENDER:
  - Acessar painel do Redis no Render
  - Settings > Eviction Policy
  - Selecionar: noeviction
  
# Se estiver usando Redis local via docker-compose:
DOCKER_COMPOSE_EXEMPLO:
  redis:
    image: redis:7-alpine
    command: redis-server --maxmemory-policy noeviction
    
# Verificacao via CLI:
# CONFIG GET maxmemory-policy
# Deve retornar: noeviction

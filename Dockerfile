FROM node:20-bookworm-slim AS deps
WORKDIR /app

# Instala as dependências necessárias para o Chromium rodar no Linux
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libxss1 \
    chromium \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate --schema prisma/schema.prisma

FROM node:20-bookworm-slim AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3333
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update && apt-get install -y \
    openssl \
    postgresql-client \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libxss1 \
    chromium \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/scripts ./scripts

EXPOSE 3333

CMD ["node", "dist/main.js"]

# ─── Build stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY client/package.json ./client/
COPY shared/package.json ./shared/

RUN npm ci

COPY . .
RUN npm run build

# ─── Production stage ─────────────────────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app

# Node build deps + Python + pip for TTS service
RUN apk add --no-cache python3 py3-pip make g++

# Node server deps
COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY shared/package.json ./shared/
RUN npm ci --workspace=server --workspace=shared --omit=dev

# Built Node app
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/shared ./shared

# Python TTS service
COPY tts-service/requirements.txt ./tts-service/
RUN pip3 install --no-cache-dir --break-system-packages -r tts-service/requirements.txt
COPY tts-service/tts_server.py ./tts-service/

# Startup script
COPY start.sh ./start.sh
RUN chmod +x ./start.sh

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["sh", "/app/start.sh"]

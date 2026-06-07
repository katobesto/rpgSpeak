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

# Native module build deps (better-sqlite3)
RUN apk add --no-cache python3 make g++

# Node server deps
COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY shared/package.json ./shared/
RUN npm ci --workspace=server --workspace=shared --omit=dev

# Built Node app
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/shared ./shared

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "/app/server/dist/index.js"]

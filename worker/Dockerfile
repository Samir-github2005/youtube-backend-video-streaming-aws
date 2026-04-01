# ── Stage 1: deps ──────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json .
RUN npm install --production

# ── Stage 2: runtime ────────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

# Install FFmpeg (Alpine package)
RUN apk add --no-cache ffmpeg

# Copy deps and source
COPY --from=deps /app/node_modules ./node_modules
COPY . .

CMD ["node", "index.js"]

FROM node:20-slim AS base
# Prisma needs OpenSSL at build & runtime
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npx prisma generate && npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate
COPY --from=build /app/dist ./dist
# Runtime-mutable org config lives at /app/config/org.json (seed committed to the
# repo). Mount a volume here so projects created via /project create survive a
# redeploy — otherwise a new image ships the seed and reverts them.
COPY config ./config
VOLUME ["/app/config"]
# Apply migrations on start, then launch the bot.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]

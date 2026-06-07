# ── Stage 1: install dependencies ─────────────────────────────────────────────
FROM node:24-slim AS deps

# Install pnpm (same major as the workspace uses)
RUN npm install -g pnpm@10

WORKDIR /app

# Copy workspace manifest files so pnpm can resolve catalog: versions
COPY pnpm-workspace.yaml ./
COPY pnpm-lock.yaml ./
COPY package.json ./

# Copy only the scripts package (the one that runs the bot)
COPY scripts/package.json ./scripts/

# Install the scripts package and its deps (frozen for reproducibility)
RUN pnpm --filter @workspace/scripts install --frozen-lockfile

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:24-slim

RUN npm install -g pnpm@10

WORKDIR /app

# Workspace root config
COPY pnpm-workspace.yaml ./
COPY package.json ./

# Installed node_modules from deps stage
COPY --from=deps /app/node_modules          ./node_modules
COPY --from=deps /app/scripts/node_modules  ./scripts/node_modules

# Bot source
COPY scripts/package.json  ./scripts/
COPY scripts/src/           ./scripts/src/

# Render injects PORT automatically; fallback to 8080 for local / Docker run
ENV PORT=8080
EXPOSE 8080

# tsx runs TypeScript directly — no compilation step needed
CMD ["scripts/node_modules/.bin/tsx", "scripts/src/backup-bot.ts"]

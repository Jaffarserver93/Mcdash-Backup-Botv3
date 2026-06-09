#!/usr/bin/env bash
set -e

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
CYAN="\033[36m"
RESET="\033[0m"

echo -e "${BOLD}${CYAN}"
echo "  ╔══════════════════════════════════════╗"
echo "  ║     MCDash Backup Bot — Launcher     ║"
echo "  ╚══════════════════════════════════════╝"
echo -e "${RESET}"

# ── 1. Node.js ────────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo -e "${YELLOW}Node.js not found. Installing via nvm...${RESET}"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  nvm install 20
  nvm use 20
else
  echo -e "${GREEN}✓ Node.js $(node -v)${RESET}"
fi

# ── 2. pnpm ───────────────────────────────────────────────────────────────────
if ! command -v pnpm &>/dev/null; then
  echo -e "${YELLOW}pnpm not found. Installing...${RESET}"
  npm install -g pnpm
else
  echo -e "${GREEN}✓ pnpm $(pnpm -v)${RESET}"
fi

# ── 3. .env file ──────────────────────────────────────────────────────────────
ENV_FILE="$(dirname "$0")/.env"

if [ -f "$ENV_FILE" ]; then
  echo -e "${GREEN}✓ Loading $ENV_FILE${RESET}"
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
else
  echo -e "${YELLOW}No .env file found — let's set it up now.${RESET}"
  echo

  prompt_var() {
    local KEY="$1"
    local HINT="$2"
    local current
    current=$(eval echo "\${$KEY:-}")
    if [ -z "$current" ]; then
      echo -e "${CYAN}$HINT${RESET}"
      read -rp "  $KEY: " val
      export "$KEY"="$val"
      echo "$KEY=$val" >> "$ENV_FILE"
    fi
  }

  touch "$ENV_FILE"
  prompt_var TELEGRAM_API_ID    "Telegram API ID (from https://my.telegram.org)"
  prompt_var TELEGRAM_API_HASH  "Telegram API Hash (from https://my.telegram.org)"
  prompt_var TELEGRAM_PHONE     "Your phone number with country code (e.g. +918317570365)"
  prompt_var MCDASH_URL         "MCDash panel URL (e.g. http://sgp2.bytenut.cc:11913)"
  prompt_var MCDASH_TOKEN       "MCDash API token"
  prompt_var BACKUP_INTERVAL_SEC "Backup interval in seconds (e.g. 300 = every 5 minutes)"
  echo -e "${GREEN}✓ .env created${RESET}"
fi

# ── 4. Install dependencies ───────────────────────────────────────────────────
echo
echo -e "${BOLD}Installing dependencies...${RESET}"
cd "$(dirname "$0")"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
echo -e "${GREEN}✓ Dependencies ready${RESET}"

# ── 5. Run the bot ────────────────────────────────────────────────────────────
echo
echo -e "${BOLD}Starting backup bot...${RESET}"
echo -e "${YELLOW}  If a Telegram OTP is needed, it will appear below — just type it and press Enter.${RESET}"
echo -e "${YELLOW}  After first login the session is saved; future runs skip OTP automatically.${RESET}"
echo
exec pnpm --filter @workspace/scripts run backup-bot

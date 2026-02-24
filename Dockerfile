# =============================================================================
# SportsClaw — Trojan Horse Container (Phase 4)
#
# A single container with Node.js (engine) + Python 3 (sports-skills).
# Developers can run the agent, CLI commands, or chat listeners out of the box.
#
# Build:
#   docker build -t sportsclaw .
#
# Run (one-shot query):
#   docker run --rm -e ANTHROPIC_API_KEY=sk-... sportsclaw "Who won the Super Bowl?"
#
# Run (add a sport schema):
#   docker run --rm sportsclaw add nfl
#
# Run (Discord listener):
#   docker run --rm -e ANTHROPIC_API_KEY=sk-... -e DISCORD_BOT_TOKEN=... sportsclaw listen discord
#
# Run (Telegram listener):
#   docker run --rm -e ANTHROPIC_API_KEY=sk-... -e TELEGRAM_BOT_TOKEN=... sportsclaw listen telegram
# =============================================================================

FROM node:20-slim AS base

# Install Python 3 and pip into the same image
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip python3-venv && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---------------------------------------------------------------------------
# Stage 1: Install Node.js dependencies and build TypeScript
# ---------------------------------------------------------------------------

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && \
    npm install discord.js

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# ---------------------------------------------------------------------------
# Stage 2: Install Python sports-skills package
# ---------------------------------------------------------------------------

RUN pip3 install --break-system-packages sports-skills 2>/dev/null || \
    echo "[sportsclaw] Warning: sports-skills not found on PyPI yet. Install manually."

# ---------------------------------------------------------------------------
# Runtime configuration
# ---------------------------------------------------------------------------

# Schema storage inside the container
ENV SPORTSCLAW_SCHEMA_DIR=/app/.sportsclaw/schemas
RUN mkdir -p /app/.sportsclaw/schemas

# ---------------------------------------------------------------------------
# Bootstrap: pre-load all 14 default sport schemas into the image
# ---------------------------------------------------------------------------

RUN node dist/index.js init --verbose 2>&1 || \
    echo "[sportsclaw] Warning: schema bootstrap incomplete. Some skills may need manual setup."

# The entrypoint is the sportsclaw CLI
ENTRYPOINT ["node", "dist/index.js"]

# Default: show help
CMD ["--help"]

# =============================================================================
# sportsclaw-relay — Headless HTTP API Container
#
# Extends the base SportsClaw container with an HTTP relay server that exposes
# the engine as a REST API. Inspired by the machina-cockpit architecture.
#
# Architecture:
#   HTTP client → relay_server.py (aiohttp) → sportsclaw CLI → LLM API
#                                                └→ Python bridge → sports-skills
#
# Build:
#   docker build -t sportsclaw-relay -f docker/relay/Dockerfile .
#
# Run:
#   docker run -d \
#     -e ANTHROPIC_API_KEY=sk-... \
#     -p 8080:8080 \
#     -v sportsclaw-memory:/data/memory \
#     sportsclaw-relay
#
# Endpoints:
#   GET  /health                — Service health check
#   GET  /api/skills            — List installed sport schemas
#   POST /api/query             — Execute a one-shot sports query (streaming NDJSON)
#   POST /api/query/sync        — Execute a one-shot query (buffered JSON response)
# =============================================================================

FROM node:20-slim AS base

# --- System dependencies -----------------------------------------------------
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# --- Python virtual environment ----------------------------------------------
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Build-time assertion: require Python 3.10+
RUN python3 -c "import sys; assert sys.version_info >= (3, 10), f'Python too old: {sys.version_info}'"

# --- Python packages: sports data + relay server -----------------------------
RUN pip install --no-cache-dir sports-skills aiohttp

WORKDIR /app

# --- Node.js dependencies ----------------------------------------------------
COPY package.json package-lock.json ./
RUN npm ci --include=optional

# --- Build TypeScript ---------------------------------------------------------
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# --- Prune dev dependencies after build --------------------------------------
RUN npm prune --omit=dev

# --- Bootstrap default sport schemas -----------------------------------------
ENV SPORTSCLAW_SCHEMA_DIR=/app/.sportsclaw/schemas
RUN mkdir -p /app/.sportsclaw/schemas && \
    node dist/index.js init --all --verbose 2>&1 || \
    echo "[sportsclaw-relay] Warning: schema bootstrap incomplete."

# --- Relay server & entrypoint ------------------------------------------------
COPY docker/relay/relay_server.py /opt/sportsclaw/relay_server.py
COPY docker/relay/entrypoint.sh /opt/sportsclaw/entrypoint.sh
RUN chmod +x /opt/sportsclaw/entrypoint.sh

# --- Persistent memory volume ------------------------------------------------
ENV SPORTSCLAW_MEMORY_DIR=/data/memory
RUN mkdir -p /data/memory
VOLUME /data/memory

# --- Runtime defaults (overridable) -------------------------------------------
ENV RELAY_PORT=8080
ENV SPORTSCLAW_PROVIDER=anthropic
ENV PYTHON_PATH=/opt/venv/bin/python3

EXPOSE 8080

ENTRYPOINT ["/opt/sportsclaw/entrypoint.sh"]
CMD ["relay"]

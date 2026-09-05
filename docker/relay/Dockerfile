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
#   POST /api/highlights/jobs                     — Create a typed highlights job
#   GET  /api/highlights/jobs/{job_id}            — Job status
#   POST /api/highlights/jobs/{job_id}/cancel     — Cancel a job
#   GET  /api/highlights/jobs/{job_id}/artifacts  — Manifest + clip paths
# =============================================================================

FROM node:20-slim AS base

# --- System dependencies -----------------------------------------------------
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv curl ffmpeg tini && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# --- Python virtual environment ----------------------------------------------
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Build-time assertion: require Python 3.10+
RUN python3 -c "import sys; assert sys.version_info >= (3, 10), f'Python too old: {sys.version_info}'"

# --- Python packages: sports data + relay server -----------------------------
# sports-skills is pinned exactly: an unpinned install floats to whatever PyPI
# serves at build time, so two builds of the same commit could ship different
# tool catalogs. Override with --build-arg SPORTS_SKILLS_VERSION=x.y.z.
ARG SPORTS_SKILLS_VERSION=0.31.0
RUN pip install --no-cache-dir "sports-skills==${SPORTS_SKILLS_VERSION}" aiohttp

# Build-time assertion: the resolver must have installed the exact pin, so a
# substituted or cached wheel fails the build instead of shipping silently.
RUN python3 -c "import importlib.metadata as md; got = md.version('sports-skills'); want = '${SPORTS_SKILLS_VERSION}'; assert got == want, f'sports-skills mismatch: installed {got}, expected {want}'"

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
# Fails closed: an image with missing or partial schemas is not shippable, so a
# failed bootstrap must fail the build rather than log a warning and continue.
# The env name is case-sensitive and intentionally lowercase-prefixed: the engine
# reads `process.env.sportsclaw_SCHEMA_DIR` (src/schema.ts). An uppercase spelling
# is silently ignored, and the bootstrap below would write to
# /root/.sportsclaw/schemas — outside the runtime schema dir.
ENV sportsclaw_SCHEMA_DIR=/app/.sportsclaw/schemas
RUN mkdir -p /app/.sportsclaw/schemas
RUN node dist/index.js init --all --verbose

# --- Relay server & entrypoint ------------------------------------------------
COPY docker/relay/relay_server.py /opt/sportsclaw/relay_server.py
COPY docker/relay/query_runtime.py /opt/sportsclaw/query_runtime.py
COPY docker/relay/skills_catalog.py /opt/sportsclaw/skills_catalog.py
COPY docker/relay/highlights_jobs.py /opt/sportsclaw/highlights_jobs.py
COPY docker/relay/entrypoint.sh /opt/sportsclaw/entrypoint.sh
RUN chmod +x /opt/sportsclaw/entrypoint.sh

# --- Persistent memory volume ------------------------------------------------
ENV SPORTSCLAW_MEMORY_DIR=/data/memory
ENV SPORTSCLAW_AGENTS_DIR=/data/memory/native-agents
RUN mkdir -p /data/memory/native-agents
VOLUME /data/memory

# --- Highlights job workspace (overridable) -----------------------------------
# Jobs get isolated workspaces under HIGHLIGHTS_JOBS_ROOT; input media must
# resolve under the allowlisted HIGHLIGHTS_MEDIA_ROOT.
ENV HIGHLIGHTS_JOBS_ROOT=/data/highlights-jobs
ENV HIGHLIGHTS_MEDIA_ROOT=/data/media
RUN mkdir -p /data/highlights-jobs /data/media

# --- Runtime defaults (overridable) -------------------------------------------
ENV RELAY_PORT=8080
ARG SPORTSCLAW_BUILD_REVISION=unknown
ENV SPORTSCLAW_BUILD_REVISION=${SPORTSCLAW_BUILD_REVISION}
ENV SPORTSCLAW_PROVIDER=anthropic
ENV PYTHON_PATH=/opt/venv/bin/python3
ENV PYTHONDONTWRITEBYTECODE=1

EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/sportsclaw/entrypoint.sh"]
CMD ["relay"]

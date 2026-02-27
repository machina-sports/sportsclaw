#!/usr/bin/env bash
set -e

# ============================================================
# sportsclaw-relay entrypoint
# Handles both relay server and direct CLI modes
# ============================================================

log() { echo "[sportsclaw-relay] $*"; }

# --- Verify Python + sports-skills -------------------------------------------
if python3 -c "import sports_skills" 2>/dev/null; then
    SKILLS_VERSION=$(python3 -c "from sports_skills import __version__; print(__version__)" 2>/dev/null || echo "unknown")
    log "sports-skills ${SKILLS_VERSION} OK"
else
    log "WARNING: sports-skills not importable. Data tools may fail."
fi

# --- Verify SportsClaw engine -------------------------------------------------
if [ -f /app/dist/index.js ]; then
    ENGINE_VERSION=$(node -e "const p=require('/app/package.json'); console.log(p.version)" 2>/dev/null || echo "unknown")
    log "sportsclaw-engine v${ENGINE_VERSION} OK"
else
    log "ERROR: /app/dist/index.js not found"
    exit 1
fi

# --- Refresh schemas if sports-skills was upgraded ----------------------------
log "Checking schema freshness..."
node /app/dist/index.js init --all 2>/dev/null || log "Schema refresh skipped (non-critical)"

# --- Route to the right mode --------------------------------------------------
case "${1:-relay}" in
    relay)
        log "Starting HTTP relay on port ${RELAY_PORT:-8080}"
        exec python3 /opt/sportsclaw/relay_server.py
        ;;
    cli)
        # Direct CLI mode: pass remaining args to sportsclaw
        shift
        exec node /app/dist/index.js "$@"
        ;;
    listen)
        # Listener mode: discord or telegram
        shift
        exec node /app/dist/index.js listen "$@"
        ;;
    *)
        # Treat as a one-shot query
        exec node /app/dist/index.js "$@"
        ;;
esac

#!/usr/bin/env bash
# =============================================================================
# SportsClaw Relay — User Provisioner
#
# Creates a Kustomize overlay for a new user from the example template.
#
# Usage:
#   ./provision.sh <username> <provider> <skills> [api_key]
#
# Examples:
#   ./provision.sh fernando google football,nba,f1
#   ./provision.sh adidas anthropic football,betting sk-ant-...
#   ./provision.sh demo openai nfl,nba,betting sk-...
#
# After provisioning:
#   kubectl apply -k docker/relay/k8s/overlays/<username>
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OVERLAYS_DIR="${SCRIPT_DIR}/overlays"
EXAMPLE_DIR="${OVERLAYS_DIR}/example"

# --- Args --------------------------------------------------------------------

USERNAME="${1:-}"
PROVIDER="${2:-}"
SKILLS="${3:-}"
API_KEY="${4:-}"

if [[ -z "$USERNAME" || -z "$PROVIDER" || -z "$SKILLS" ]]; then
    echo "Usage: $0 <username> <provider> <skills> [api_key]"
    echo ""
    echo "  username   Unique user identifier (e.g., fernando, adidas)"
    echo "  provider   LLM provider: google | anthropic | openai"
    echo "  skills     Comma-separated skills (e.g., football,nba,betting)"
    echo "  api_key    Optional API key (can also be set later in secrets.env)"
    echo ""
    echo "Available skills:"
    echo "  football, nfl, nba, nhl, mlb, wnba, tennis, cfb, cbb,"
    echo "  golf, f1, kalshi, polymarket, news, betting, markets"
    exit 1
fi

# Validate provider
if [[ "$PROVIDER" != "google" && "$PROVIDER" != "anthropic" && "$PROVIDER" != "openai" ]]; then
    echo "Error: provider must be one of: google, anthropic, openai"
    exit 1
fi

# --- Create overlay ----------------------------------------------------------

USER_DIR="${OVERLAYS_DIR}/${USERNAME}"

if [[ -d "$USER_DIR" ]]; then
    echo "Error: overlay '${USERNAME}' already exists at ${USER_DIR}"
    echo "To recreate, first remove it: rm -rf ${USER_DIR}"
    exit 1
fi

echo "[provision] Creating overlay for '${USERNAME}'..."
cp -r "$EXAMPLE_DIR" "$USER_DIR"

# --- Customize kustomization.yaml -------------------------------------------

sed -i.bak "s/namePrefix: example-/namePrefix: ${USERNAME}-/" "${USER_DIR}/kustomization.yaml"
sed -i.bak "s/sportsclaw-user: example/sportsclaw-user: ${USERNAME}/" "${USER_DIR}/kustomization.yaml"
rm -f "${USER_DIR}/kustomization.yaml.bak"

# --- Customize config.env ---------------------------------------------------

sed -i.bak "s/^SPORTSCLAW_SKILLS=.*/SPORTSCLAW_SKILLS=${SKILLS}/" "${USER_DIR}/config.env"
sed -i.bak "s/^SPORTSCLAW_PROVIDER=.*/SPORTSCLAW_PROVIDER=${PROVIDER}/" "${USER_DIR}/config.env"
rm -f "${USER_DIR}/config.env.bak"

# --- Customize secrets.env --------------------------------------------------

if [[ -n "$API_KEY" ]]; then
    case "$PROVIDER" in
        google)
            sed -i.bak "s/^GOOGLE_GENERATIVE_AI_API_KEY=.*/GOOGLE_GENERATIVE_AI_API_KEY=${API_KEY}/" "${USER_DIR}/secrets.env"
            ;;
        anthropic)
            sed -i.bak "s/^# ANTHROPIC_API_KEY=.*/ANTHROPIC_API_KEY=${API_KEY}/" "${USER_DIR}/secrets.env"
            ;;
        openai)
            sed -i.bak "s/^# OPENAI_API_KEY=.*/OPENAI_API_KEY=${API_KEY}/" "${USER_DIR}/secrets.env"
            ;;
    esac
    rm -f "${USER_DIR}/secrets.env.bak"
fi

# --- Summary -----------------------------------------------------------------

echo "[provision] Overlay created: ${USER_DIR}"
echo ""
echo "  User:     ${USERNAME}"
echo "  Provider: ${PROVIDER}"
echo "  Skills:   ${SKILLS}"
echo "  API Key:  ${API_KEY:+set}${API_KEY:-NOT SET (edit secrets.env)}"
echo ""
echo "Deploy:"
echo "  kubectl apply -k ${USER_DIR}"
echo ""
echo "Tear down:"
echo "  kubectl delete -k ${USER_DIR}"

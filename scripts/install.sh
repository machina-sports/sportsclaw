#!/usr/bin/env bash

# sportsclaw Auto-Installer
# Example usage: curl -fsSL https://sportsclaw.gg/install.sh | bash

set -e

# --- Colors & Styling ---
BOLD='\033[1m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "\n🦞 ${BOLD}Installing sportsclaw...${NC}\n"

# 1. Dependency Checks
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Error: Node.js is required but not installed.${NC}"
    echo -e "   Install options:"
    echo -e "   • macOS (Homebrew): ${BOLD}brew install node${NC}"
    echo -e "   • nvm:              ${BOLD}nvm install 22${NC}"
    echo -e "   • Download:         https://nodejs.org"
    exit 1
fi

# Check Node.js version (>= 18 required)
NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo -e "${RED}❌ Error: Node.js v18+ is required but found $(node -v).${NC}"
    echo -e "   Upgrade options:"
    echo -e "   • macOS (Homebrew): ${BOLD}brew install node${NC}"
    echo -e "   • nvm:              ${BOLD}nvm install 22${NC}"
    echo -e "   • Download:         https://nodejs.org"
    exit 1
fi

if ! command -v npm &> /dev/null; then
    echo -e "${RED}❌ Error: npm is required but not installed.${NC}"
    exit 1
fi

if ! command -v python3 &> /dev/null; then
    echo -e "${RED}❌ Error: Python 3 is required but not installed.${NC}"
    echo "Please install Python (3.9+) from https://python.org"
    exit 1
fi

# Prefer Homebrew Python on macOS when available to avoid mixing system Python packages
PYTHON_BIN="$(command -v python3)"
if [ -x "/opt/homebrew/bin/python3" ]; then
    PYTHON_BIN="/opt/homebrew/bin/python3"
fi
echo -e "${BLUE}📦 Node.js $(node -v) — npm $(npm -v)${NC}"
echo -e "${BLUE}🐍 Python:  ${PYTHON_BIN}${NC}\n"

# 2. Install Node Package (Engine) + PM2 (Daemon Manager)
echo -e "${BLUE}📦 Installing TypeScript Execution Engine + PM2...${NC}"

# Detect if sudo is needed for global npm install
NPM_PREFIX="$(npm prefix -g 2>/dev/null)"
SUDO=""
if [ -n "$NPM_PREFIX" ] && [ ! -w "${NPM_PREFIX}/lib" ]; then
    echo -e "${YELLOW}⚠️  Global npm directory requires elevated permissions, using sudo...${NC}"
    SUDO="sudo"
fi

$SUDO npm install -g sportsclaw-engine-core@latest pm2@latest || {
    echo -e "${RED}❌ Failed to install Node packages.${NC}"
    echo -e "   If you see permission errors, try: ${BOLD}sudo npm install -g sportsclaw-engine-core@latest pm2@latest${NC}"
    exit 1
}
echo -e "${GREEN}✓ Engine + PM2 installed.${NC}\n"

# 3. Install Python Package (Data Skills)
echo -e "${BLUE}🐍 Installing Python Data Skills...${NC}"
# Use standard pip, handle external-managed-environments gracefully where possible
if "${PYTHON_BIN}" -m pip --version &> /dev/null; then
    # Some environments (like modern macOS/Ubuntu) block system-wide pip installs.
    # We try standard first, then fallback to --break-system-packages (safe for pure python libs like ours), then --user
    "${PYTHON_BIN}" -m pip install --upgrade sports-skills 2>/dev/null || \
    "${PYTHON_BIN}" -m pip install --upgrade sports-skills --break-system-packages 2>/dev/null || \
    "${PYTHON_BIN}" -m pip install --upgrade sports-skills --user || {
        echo -e "${RED}❌ Failed to install Python package.${NC}"
        exit 1
    }
else
    echo -e "${YELLOW}⚠️ Warning: 'pip' not found for ${PYTHON_BIN}. You may need to install sports-skills manually:${NC}"
    echo "${PYTHON_BIN} -m ensurepip && ${PYTHON_BIN} -m pip install --upgrade sports-skills"
fi
echo -e "${GREEN}✓ Skills installed.${NC}\n"

# 4. Bootstrap Default Schemas
echo -e "${BLUE}⚙️  Bootstrapping agent memory...${NC}"
PYTHON_PATH="${PYTHON_BIN}" sportsclaw init > /dev/null 2>&1 || true
echo -e "${GREEN}✓ Agent primed.${NC}\n"

# 5. Success
echo -e "------------------------------------------------------"
echo -e "${BOLD}${GREEN}✅ Installation Complete!${NC}"
echo -e "------------------------------------------------------"
echo -e "To configure your LLM and run your first query, type:\n"
echo -e "  ${BOLD}sportsclaw${NC}\n"

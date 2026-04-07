#!/bin/bash
set -e

# PATH: setup.sh
# Forensic Latency Analyzer — idempotent startup script.
#
# WHY THE PORT RELEASE IS NEEDED:
#   npm run dev calls this script. Running it while the server is still up
#   causes EADDRINUSE on port 3000 (Express) and 24678 (Vite HMR websocket).
#   release_port() kills the occupant and waits for the socket to close
#   before the rest of the script tries to bind.
#
# WHY || true ON fuser:
#   fuser exits 1 when nothing is listening on the port. Without || true,
#   set -e would abort the script on a clean first run where both ports are free.
#
# WHY exec npx tsx server.ts (not node ... or npx ts-node ...):
#   Confirmed from package.json: tsx is the devDependency used to run server.ts.
#   exec replaces this bash process with tsx so Ctrl-C kills the server directly
#   rather than leaving an orphaned node process holding port 3000.

APP_PORT=3000
HMR_PORT=24678

# Environment checks (preserved from original)
command -v python3 >/dev/null 2>&1 || { echo "Error: python3 required but not found in PATH."; exit 1; }
command -v npm    >/dev/null 2>&1 || { echo "Error: npm required but not found in PATH."; exit 1; }

echo "[SETUP] Initiating cold-start recovery..."

# ─── Step 0: Release ports ────────────────────────────────────────────────────
release_port() {
    local port="$1"
    if fuser "${port}/tcp" >/dev/null 2>&1; then
        echo "[SETUP] Port ${port} occupied — terminating occupant..."
        fuser -k "${port}/tcp" || true
        sleep 1
        echo "[SETUP] Port ${port} released."
    else
        echo "[SETUP] Port ${port} is free."
    fi
}

release_port "${APP_PORT}"
release_port "${HMR_PORT}"

# ─── Step 1: Update from GitHub ───────────────────────────────────────────────
if [ -d ".git" ]; then
    echo "[SETUP] Checking for updates from GitHub..."
    git pull origin main || echo "[WARNING] Git pull failed, proceeding with current version."
fi

# ─── Step 2: Install Node.js dependencies ─────────────────────────────────────
echo "[SETUP] Installing Node.js dependencies..."
npm install --no-audit --no-fund

# ─── Step 3: Build frontend assets ────────────────────────────────────────────
echo "[SETUP] Compiling frontend assets..."
npm run build

# ─── Step 4: Verify forensic tools ────────────────────────────────────────────
echo "[SETUP] Verifying system forensic tools..."
python3 forensic_latency_probe_v13.py --module DEPS

# ─── Step 5: Start server ─────────────────────────────────────────────────────
echo "[SETUP] Initialization complete. Starting server..."
exec npx tsx server.ts

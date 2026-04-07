#!/bin/bash
# =============================================================================
# setup.sh - Cold-start recovery and update script
# =============================================================================

echo "[SETUP] Initiating cold-start recovery..."

# 1. Update from GitHub (if applicable)
if [ -d ".git" ]; then
    echo "[SETUP] Checking for updates from GitHub..."
    git pull origin main || echo "[WARNING] Git pull failed, proceeding with current version."
fi

# 2. Install Node.js dependencies
echo "[SETUP] Installing Node.js dependencies..."
npm install --no-audit --no-fund

# 3. Build frontend assets
echo "[SETUP] Compiling frontend assets..."
npm run build

# 4. Install system forensic tools
echo "[SETUP] Verifying system forensic tools..."
python3 forensic_latency_probe_v13.py --module DEPS

echo "[SETUP] Initialization complete. Starting server..."
exec npx tsx server.ts

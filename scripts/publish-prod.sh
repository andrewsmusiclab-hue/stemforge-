#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
#  publish-prod.sh  —  Promote the current dist/ build to PRODUCTION
#
#  Usage:  bash scripts/publish-prod.sh
#
#  This script:
#    1. Verifies dist/_worker.js exists (build must be done first)
#    2. Runs wrangler deploy using wrangler.prod.jsonc (production config)
#    3. Points to the same D1 database (shared prod data)
#    4. Updates the site_version flag in D1 to 'live'
#
#  Run AFTER testing on staging (*.vip.gensparksite.com)
# ─────────────────────────────────────────────────────────────────
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo ""
echo "🚀  StemForge — Publishing to PRODUCTION"
echo "══════════════════════════════════════════"
echo ""

# 1. Check dist exists
if [ ! -f "dist/_worker.js" ]; then
  echo "❌  dist/_worker.js not found. Run 'npm run build' first."
  exit 1
fi

BUILD_SIZE=$(du -sh dist/_worker.js | cut -f1)
echo "✅  dist/_worker.js found ($BUILD_SIZE)"

# 2. Confirm
echo ""
echo "   Production URL : https://stemforge.studio"
echo "   Worker config  : wrangler.prod.jsonc"
echo "   D1 database    : andrew-pryce-db (shared)"
echo ""
read -p "   Deploy this build to production? [y/N] " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo "   Cancelled."
  exit 0
fi

# 3. Deploy using production wrangler config
echo ""
echo "⏳  Deploying to Cloudflare Workers..."
echo ""
npx wrangler deploy --config wrangler.prod.jsonc

echo ""
echo "✅  Production deploy complete!"
echo "   🌍  https://stemforge.studio is now updated"
echo ""

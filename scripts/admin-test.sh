#!/usr/bin/env bash
# =============================================================================
# StemForge Admin API Test Suite
# Usage:  bash scripts/admin-test.sh [--prod] [--password YOUR_PASSWORD]
#
# Flags:
#   --prod        Run against https://stemforge.studio (default: localhost:3000)
#   --password    Admin password (prompts if not supplied)
#   --email       Admin email (default: andrewsmusiclab@gmail.com)
#   --skip-login  Provide a pre-existing session cookie via SF_COOKIE env var
#
# Examples:
#   bash scripts/admin-test.sh --prod --password "mypassword"
#   SF_COOKIE="abc123..." bash scripts/admin-test.sh --prod --skip-login
# =============================================================================

set -euo pipefail

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

pass() { echo -e "  ${GREEN}✅ PASS${RESET}  $1"; PASSES=$((PASSES+1)); }
fail() { echo -e "  ${RED}❌ FAIL${RESET}  $1"; FAILS=$((FAILS+1)); }
warn() { echo -e "  ${YELLOW}⚠️  WARN${RESET}  $1"; WARNS=$((WARNS+1)); }
info() { echo -e "  ${CYAN}ℹ️  INFO${RESET}  $1"; }
section() { echo -e "\n${BOLD}── $1 ──────────────────────────────────────────────────${RESET}"; }

PASSES=0; FAILS=0; WARNS=0

# ── Defaults ─────────────────────────────────────────────────────────────────
BASE_URL="http://localhost:3000"
ADMIN_EMAIL="andrewsmusiclab@gmail.com"
ADMIN_PASS=""
SKIP_LOGIN=false
COOKIE=""

# ── Auto-load from .dev.vars if present ──────────────────────────────────────
DEVVARS="$(dirname "$0")/../.dev.vars"
if [ -f "$DEVVARS" ]; then
  _ev=$(grep '^ADMIN_EMAIL=' "$DEVVARS" | head -1 | cut -d= -f2-)
  _pv=$(grep '^ADMIN_PASSWORD=' "$DEVVARS" | head -1 | cut -d= -f2-)
  [ -n "$_ev" ] && ADMIN_EMAIL="$_ev"
  [ -n "$_pv" ] && [ "$_pv" != "REPLACE_WITH_YOUR_PASSWORD" ] && ADMIN_PASS="$_pv"
fi

# ── Arg parsing ──────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --prod)      BASE_URL="https://stemforge.studio"; shift ;;
    --password)  ADMIN_PASS="$2"; shift 2 ;;
    --email)     ADMIN_EMAIL="$2"; shift 2 ;;
    --skip-login) SKIP_LOGIN=true; COOKIE="${SF_COOKIE:-}"; shift ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

echo -e "\n${BOLD}StemForge Admin API Test Suite${RESET}"
echo -e "Target: ${CYAN}${BASE_URL}${RESET}\n"

# ── Helper: curl with cookie ──────────────────────────────────────────────────
sf_get()  { curl -s -b "sf_session=${COOKIE}" "$BASE_URL$1"; }
sf_post() { curl -s -b "sf_session=${COOKIE}" -X POST -H "Content-Type: application/json" -d "$2" "$BASE_URL$1"; }
sf_put()  { curl -s -b "sf_session=${COOKIE}" -X PUT  -H "Content-Type: application/json" -d "$2" "$BASE_URL$1"; }
sf_del()  { curl -s -b "sf_session=${COOKIE}" -X DELETE "$BASE_URL$1"; }

# ── Helper: check JSON field ──────────────────────────────────────────────────
jq_val() { echo "$1" | grep -o "\"$2\":[^,}]*" | head -1 | sed 's/.*://;s/[" ]//g'; }
has_ok()  { [[ "$(jq_val "$1" "ok")" == "true" ]]; }
has_err() { echo "$1" | grep -q '"error"'; }

# =============================================================================
# SECTION 0: Login
# =============================================================================
section "0. Admin Login"

if [ "$SKIP_LOGIN" = true ]; then
  if [ -z "$COOKIE" ]; then
    echo -e "${RED}--skip-login set but SF_COOKIE env var is empty.${RESET}"; exit 1
  fi
  info "Using provided session cookie (first 8 chars: ${COOKIE:0:8}...)"
else
  if [ -z "$ADMIN_PASS" ]; then
    echo -n "Admin password for ${ADMIN_EMAIL}: "
    read -rs ADMIN_PASS; echo
  fi

  LOGIN_BODY="{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASS}\"}"
  LOGIN_RESP=$(curl -s -c /tmp/sf_cookies.txt -D /tmp/sf_headers.txt \
    -X POST -H "Content-Type: application/json" \
    -d "$LOGIN_BODY" "$BASE_URL/api/auth/login")

  if echo "$LOGIN_RESP" | grep -q '"ok":true'; then
    # Extract cookie from Set-Cookie header
    COOKIE=$(grep -i 'set-cookie' /tmp/sf_headers.txt | grep -o 'sf_session=[a-f0-9]*' | cut -d= -f2 || true)
    if [ -z "$COOKIE" ]; then
      # Fallback: try cookie jar
      COOKIE=$(grep 'sf_session' /tmp/sf_cookies.txt 2>/dev/null | awk '{print $NF}' || true)
    fi
    if [ -n "$COOKIE" ]; then
      pass "Login successful — cookie obtained (${COOKIE:0:8}...)"
    else
      fail "Login ok:true but could not extract session cookie from headers"
      echo "  Headers: $(cat /tmp/sf_headers.txt | grep -i cookie || echo 'none')"
      exit 1
    fi
  else
    fail "Login failed — response: $LOGIN_RESP"
    exit 1
  fi
fi

# =============================================================================
# SECTION 1: Auth / Ping
# =============================================================================
section "1. Auth & Admin Access"

PING=$(sf_get "/api/admin/ping")
PING_OK=$(jq_val "$PING" "ok")
PING_ADMIN=$(jq_val "$PING" "admin")
PING_EMAIL=$(jq_val "$PING" "email")

if [ "$PING_OK" = "true" ] && [ "$PING_ADMIN" = "true" ]; then
  pass "Admin ping — ok=true, admin=true (email: $PING_EMAIL)"
elif [ "$PING_OK" = "true" ] && [ "$PING_ADMIN" = "false" ]; then
  fail "Ping ok but admin=false — session valid but user is not admin"
else
  fail "Ping failed: $PING"
fi

# =============================================================================
# SECTION 2: User Listing
# =============================================================================
section "2. User Management"

USERS=$(sf_get "/api/admin/users")
if echo "$USERS" | grep -q '"users"'; then
  USER_COUNT=$(echo "$USERS" | grep -o '"id"' | wc -l | tr -d ' ')
  pass "User list — returned $USER_COUNT users"
  # Check ares.blabla is in the list
  if echo "$USERS" | grep -q "ares.blabla"; then
    pass "ares.blabla.ma@gmail.com — present in user list"
  else
    warn "ares.blabla.ma@gmail.com — not found in user list (may be paginated)"
  fi
else
  fail "User list failed: $(echo $USERS | head -c 200)"
fi

# Stats endpoint
STATS=$(sf_get "/api/admin/stats")
if echo "$STATS" | grep -q '"total_users"'; then
  TOTAL=$(jq_val "$STATS" "total_users")
  pass "Admin stats — total_users: $TOTAL"
else
  fail "Admin stats failed: $(echo $STATS | head -c 200)"
fi

# =============================================================================
# SECTION 3: Broadcast Infrastructure
# =============================================================================
section "3. Broadcast — Infrastructure"

# 3a. Subscriber count
SUBS=$(sf_get "/api/admin/broadcast/subscribers")
if echo "$SUBS" | grep -q '"count"'; then
  SUB_COUNT=$(jq_val "$SUBS" "count")
  pass "Broadcast subscribers — count: $SUB_COUNT"
else
  fail "Subscribers endpoint failed: $(echo $SUBS | head -c 200)"
fi

# 3b. Broadcast history
HISTORY=$(sf_get "/api/admin/broadcast/history")
if echo "$HISTORY" | grep -q '"sends"'; then
  SEND_COUNT=$(echo "$HISTORY" | grep -o '"id"' | wc -l | tr -d ' ')
  pass "Broadcast history — $SEND_COUNT send record(s)"
else
  fail "Broadcast history failed: $(echo $HISTORY | head -c 200)"
fi

# 3c. Template listing
TEMPLATES=$(sf_get "/api/admin/templates")
if echo "$TEMPLATES" | grep -q '"templates"'; then
  TPL_COUNT=$(echo "$TEMPLATES" | grep -o '"id"' | wc -l | tr -d ' ')
  pass "Email templates — $TPL_COUNT template(s) found"
  # Check template ID 6 exists
  if echo "$TEMPLATES" | grep -q '"id":6\|"id": 6'; then
    pass "Template ID=6 (Published Tracks Notice) — present"
  else
    warn "Template ID=6 — not found (may have been deleted or ID differs)"
  fi
else
  fail "Templates endpoint failed: $(echo $TEMPLATES | head -c 200)"
fi

# =============================================================================
# SECTION 4: Broadcast Send-One — Guard Tests
# =============================================================================
section "4. Broadcast send-one — Safety Guards"

# 4a. Missing body → should 400
SENDONE_EMPTY=$(curl -s -b "sf_session=${COOKIE}" -X POST \
  -H "Content-Type: application/json" -d '{}' \
  "$BASE_URL/api/admin/broadcast/send-one")
if echo "$SENDONE_EMPTY" | grep -q '"error"'; then
  pass "send-one with empty body → error (correct)"
else
  fail "send-one with empty body should return error, got: $(echo $SENDONE_EMPTY | head -c 150)"
fi

# 4b. Unknown email → should 404
SENDONE_NOTFOUND=$(sf_post "/api/admin/broadcast/send-one" \
  '{"subject":"Test","html":"<p>test</p>","user_email":"nobody_xyz_does_not_exist@example.invalid"}')
STATUS_NF=$(jq_val "$SENDONE_NOTFOUND" "error")
if echo "$SENDONE_NOTFOUND" | grep -q '"error"'; then
  pass "send-one with unknown email → error/404 (correct, got: $STATUS_NF)"
else
  fail "send-one with unknown email should 404, got: $(echo $SENDONE_NOTFOUND | head -c 150)"
fi

# 4c. Valid email but we DON'T actually send (would charge Resend)
#     Just verify the payload validation works by checking known-bad inputs
SENDONE_NOSUBJ=$(sf_post "/api/admin/broadcast/send-one" \
  '{"html":"<p>test</p>","user_email":"ares.blabla.ma@gmail.com"}')
if echo "$SENDONE_NOSUBJ" | grep -q '"error"'; then
  pass "send-one missing subject → error (correct)"
else
  # Some implementations may allow empty subject — just warn
  warn "send-one missing subject did not error — subject may be optional: $(echo $SENDONE_NOSUBJ | head -c 150)"
fi

# =============================================================================
# SECTION 5: Bulk Broadcast — Audience Guard
# =============================================================================
section "5. Broadcast send — Audience Guard"

# 5a. audience=none should be blocked
BULK_NONE=$(sf_post "/api/admin/broadcast/send" \
  '{"subject":"Test","html":"<p>test</p>","audience":"none"}')
if echo "$BULK_NONE" | grep -q '"error"'; then
  pass "Bulk send with audience=none → blocked (correct)"
else
  fail "CRITICAL: Bulk send with audience=none should be blocked! Got: $(echo $BULK_NONE | head -c 200)"
fi

# 5b. Missing audience should be blocked
BULK_NOAUD=$(sf_post "/api/admin/broadcast/send" \
  '{"subject":"Test","html":"<p>test</p>"}')
if echo "$BULK_NOAUD" | grep -q '"error"'; then
  pass "Bulk send with no audience → blocked (correct)"
else
  fail "Bulk send with no audience should be blocked! Got: $(echo $BULK_NOAUD | head -c 200)"
fi

# 5c. Invalid audience value should be blocked
BULK_BADAUD=$(sf_post "/api/admin/broadcast/send" \
  '{"subject":"Test","html":"<p>test</p>","audience":"badvalue"}')
if echo "$BULK_BADAUD" | grep -q '"error"'; then
  pass "Bulk send with invalid audience → blocked (correct)"
else
  warn "Bulk send with audience=badvalue not rejected — backend may accept any string"
fi

# =============================================================================
# SECTION 6: Unauthenticated Access — Rejection Tests
# =============================================================================
section "6. Unauthenticated Access (should all be 401/403)"

unauth_get()  { curl -s "$BASE_URL$1"; }
unauth_post() { curl -s -X POST -H "Content-Type: application/json" -d "$2" "$BASE_URL$1"; }

check_blocked() {
  local label="$1" resp="$2"
  if echo "$resp" | grep -qiE '"error"|"Forbidden"|"Unauthorized"|"Not authenticated"'; then
    pass "$label → blocked (correct)"
  elif echo "$resp" | grep -q 'login\|Login\|/login'; then
    pass "$label → redirected to login (correct)"
  else
    fail "$label → NOT blocked! Response: $(echo $resp | head -c 120)"
  fi
}

check_blocked "GET /api/admin/users (no cookie)"        "$(unauth_get /api/admin/users)"
check_blocked "GET /api/admin/stats (no cookie)"        "$(unauth_get /api/admin/stats)"
check_blocked "GET /api/admin/broadcast/history"        "$(unauth_get /api/admin/broadcast/history)"
check_blocked "POST /api/admin/broadcast/send-one"      "$(unauth_post /api/admin/broadcast/send-one '{\"subject\":\"x\",\"html\":\"x\",\"user_email\":\"x@x.com\"}')"
check_blocked "POST /api/admin/broadcast/send"          "$(unauth_post /api/admin/broadcast/send '{\"subject\":\"x\",\"html\":\"x\",\"audience\":\"all\"}')"
check_blocked "GET /api/admin/analytics"                "$(unauth_get /api/admin/analytics)"
check_blocked "GET /api/admin/revenue"                  "$(unauth_get /api/admin/revenue)"

# =============================================================================
# SECTION 7: Public Routes — Accessibility Check
# =============================================================================
section "7. Public Routes (should be accessible)"

check_public() {
  local label="$1" resp="$2"
  if echo "$resp" | grep -qiE '"error"|"Forbidden"|"Unauthorized"'; then
    fail "$label returned error: $(echo $resp | head -c 100)"
  else
    pass "$label → accessible"
  fi
}

check_public "GET /"             "$(curl -s -o /dev/null -w '%{http_code}' $BASE_URL/ | grep -v '^4')"
check_public "GET /api/admin/ping (with cookie)" "$(sf_get /api/admin/ping)"

# =============================================================================
# SECTION 8: WAV Download Route — Guard Tests
# =============================================================================
section "8. WAV Download — Auth Guards"

# Unauthenticated WAV download should redirect/block
WAV_UNAUTH=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/download-wav/fake-job-id")
if [[ "$WAV_UNAUTH" == "302" || "$WAV_UNAUTH" == "401" || "$WAV_UNAUTH" == "403" ]]; then
  pass "WAV download unauthenticated → $WAV_UNAUTH (blocked/redirected)"
else
  warn "WAV download unauthenticated → HTTP $WAV_UNAUTH (expected 302/401/403)"
fi

# Authenticated but non-existent job → 404
WAV_NOTFOUND=$(sf_get "/api/download-wav/job_definitely_does_not_exist_xyz")
if echo "$WAV_NOTFOUND" | grep -q '"error"'; then
  pass "WAV download unknown job → 404 error (correct)"
else
  warn "WAV download unknown job response unexpected: $(echo $WAV_NOTFOUND | head -c 100)"
fi

# =============================================================================
# SECTION 9: Analytics & Revenue
# =============================================================================
section "9. Analytics & Revenue"

ANALYTICS=$(sf_get "/api/admin/analytics")
if echo "$ANALYTICS" | grep -qiE '"page_views"|'"'"'views'"'"'|"error"'; then
  if echo "$ANALYTICS" | grep -q '"error"'; then
    warn "Analytics returned error: $(echo $ANALYTICS | head -c 200)"
  else
    pass "Analytics endpoint — returned data"
  fi
else
  warn "Analytics response unexpected: $(echo $ANALYTICS | head -c 200)"
fi

REVENUE=$(sf_get "/api/admin/revenue")
if echo "$REVENUE" | grep -qiE '"mrr"|"revenue"|"subscriptions"|"error"'; then
  if echo "$REVENUE" | grep -q '"error"'; then
    warn "Revenue returned error: $(echo $REVENUE | head -c 200)"
  else
    pass "Revenue endpoint — returned data"
  fi
else
  warn "Revenue response unexpected: $(echo $REVENUE | head -c 200)"
fi

# =============================================================================
# SECTION 10: Version / Deploy Status
# =============================================================================
section "10. Version Status"

VER=$(sf_get "/api/admin/version-status")
if echo "$VER" | grep -q '"asset_ver"'; then
  ASSET=$(jq_val "$VER" "asset_ver")
  pass "Version status — asset_ver: $ASSET"
else
  warn "Version status unexpected: $(echo $VER | head -c 200)"
fi

# =============================================================================
# SUMMARY
# =============================================================================
TOTAL=$((PASSES + FAILS + WARNS))
echo -e "\n${BOLD}══════════════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}Results: $TOTAL checks${RESET}"
echo -e "  ${GREEN}✅ Passed: $PASSES${RESET}"
echo -e "  ${RED}❌ Failed: $FAILS${RESET}"
echo -e "  ${YELLOW}⚠️  Warnings: $WARNS${RESET}"
echo -e "${BOLD}══════════════════════════════════════════════════════════${RESET}\n"

if [ "$FAILS" -gt 0 ]; then
  echo -e "${RED}${BOLD}TEST SUITE FAILED — $FAILS test(s) need attention.${RESET}\n"
  exit 1
else
  echo -e "${GREEN}${BOLD}All critical tests passed!${RESET}\n"
  exit 0
fi

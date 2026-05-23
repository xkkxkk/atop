#!/bin/bash
# ============================================================
# ATOP Smoke Test Script
# Usage: ./smoke_test.sh [BASE_URL] [EMAIL] [PASSWORD]
# Example: ./smoke_test.sh http://localhost:8080 admin@atop.local '#PassW0rd'
# ============================================================

BASE_URL="${1:-http://localhost:8080}"
EMAIL="${2:-admin@atop.local}"
PASSWORD="${3:-#PassW0rd}"
COOKIE_JAR="${TMPDIR:-/tmp}/atop-smoke-cookie-$$.txt"

PASS=0
FAIL=0
ERRORS=()

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

cleanup() {
  rm -f "$COOKIE_JAR"
}
trap cleanup EXIT

log_pass() { echo -e "${GREEN}✓${NC} $1"; ((PASS++)); }
log_fail() { echo -e "${RED}✗${NC} $1"; ((FAIL++)); ERRORS+=("$1"); }
log_info() { echo -e "${YELLOW}•${NC} $1"; }

call() {
  local method=$1 path=$2 data=$3 token=$4
  local args=(-s -X "$method" "$BASE_URL$path" -H "Content-Type: application/json" -c "$COOKIE_JAR" -b "$COOKIE_JAR")

  if [ -n "$token" ]; then
    args+=(-H "Authorization: Bearer $token")
  fi
  if [ -n "$data" ]; then
    args+=(-d "$data")
  fi

  curl "${args[@]}"
}

check() {
  local name=$1 response=$2 expected=$3
  if echo "$response" | grep -q "$expected"; then
    log_pass "$name"
  else
    log_fail "$name (got: $(echo "$response" | head -c 120))"
  fi
}

echo ""
echo "============================================================"
echo " ATOP Smoke Test - $BASE_URL"
echo "============================================================"
echo ""

log_info "1. Health Check"
resp=$(curl -s "$BASE_URL/health")
check "GET /health" "$resp" '"status":"ok"'

log_info "2. Auth"
resp=$(call POST /api/auth/login "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "")
check "POST /api/auth/login" "$resp" 'accessToken'
TOKEN=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['accessToken'])" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  log_fail "Could not extract access token; remaining tests may fail"
else
  log_pass "Access token extracted"
fi

resp=$(call POST /api/auth/refresh '{}' "")
check "POST /api/auth/refresh" "$resp" 'accessToken'

log_info "3. Dimension Dict"
resp=$(call GET /api/dimension-dict "" "$TOKEN")
check "GET /api/dimension-dict" "$resp" '"code":"OK"'

resp=$(call POST /api/dimension-dict '{"dimension":"project","value":"SMOKE_TEST_PROJECT","displayName":"Smoke Test","sortOrder":99}' "$TOKEN")
check "POST /api/dimension-dict (create)" "$resp" 'SMOKE_TEST_PROJECT'
DIM_ID=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['id'])" 2>/dev/null)

if [ -n "$DIM_ID" ]; then
  resp=$(call PUT /api/dimension-dict/$DIM_ID '{"displayName":"Smoke Test Updated"}' "$TOKEN")
  check "PUT /api/dimension-dict/:id (update)" "$resp" 'OK'

  resp=$(call DELETE /api/dimension-dict/$DIM_ID "" "$TOKEN")
  check "DELETE /api/dimension-dict/:id" "$resp" 'OK'
fi

log_info "4. Global Vars"
resp=$(call GET /api/settings/vars "" "$TOKEN")
check "GET /api/settings/vars" "$resp" '"code":"OK"'

resp=$(call POST /api/settings/vars '{"key":"SMOKE_TEST_VAR","value":"smoke_value","scope":"system"}' "$TOKEN")
check "POST /api/settings/vars (create)" "$resp" 'SMOKE_TEST_VAR'
VAR_ID=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['id'])" 2>/dev/null)

if [ -n "$VAR_ID" ]; then
  resp=$(call PUT /api/settings/vars/$VAR_ID '{"value":"updated_value"}' "$TOKEN")
  check "PUT /api/settings/vars/:id (update)" "$resp" 'OK'
  resp=$(call DELETE /api/settings/vars/$VAR_ID "" "$TOKEN")
  check "DELETE /api/settings/vars/:id" "$resp" 'OK'
fi

log_info "5. Shared Libs"
resp=$(call GET /api/shared-libs "" "$TOKEN")
check "GET /api/shared-libs" "$resp" '"code":"OK"'

resp=$(call POST /api/shared-libs '{"name":"smoke_test_lib","lang":"sh","scope":"system","content":"#!/bin/bash\necho smoke","description":"Smoke test lib"}' "$TOKEN")
check "POST /api/shared-libs (create)" "$resp" 'smoke_test_lib'
LIB_ID=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['id'])" 2>/dev/null)

if [ -n "$LIB_ID" ]; then
  resp=$(call GET /api/shared-libs/$LIB_ID "" "$TOKEN")
  check "GET /api/shared-libs/:id" "$resp" 'smoke_test_lib'

  resp=$(call PUT /api/shared-libs/$LIB_ID '{"content":"#!/bin/bash\necho updated","description":"Updated"}' "$TOKEN")
  check "PUT /api/shared-libs/:id (update)" "$resp" 'OK'

  resp=$(call GET /api/shared-libs/$LIB_ID/versions "" "$TOKEN")
  check "GET /api/shared-libs/:id/versions" "$resp" '"code":"OK"'

  resp=$(call DELETE /api/shared-libs/$LIB_ID "" "$TOKEN")
  check "DELETE /api/shared-libs/:id" "$resp" 'OK'
fi

log_info "6. Test Sets"
resp=$(call GET /api/test-sets "" "$TOKEN")
check "GET /api/test-sets" "$resp" '"code":"OK"'

resp=$(call POST /api/test-sets '{"name":"smoke_testset","project":"V3_SOFTWARE_master","environment":"ubuntu","product":"CMODEL","agentLabel":"V3_CMODEL","status":"enabled","configJson":{"setup":{"downloads":[],"preScript":""},"execCmds":[{"cmdLabel":"run","dockerMode":"none","envVars":[],"cmd":"echo smoke test","failPolicy":"block"}],"teardown":{"cleanWorkspace":true,"keepArtifacts":[],"stopDocker":false},"reports":[]}}' "$TOKEN")
check "POST /api/test-sets (create)" "$resp" 'smoke_testset'
TS_ID=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['id'])" 2>/dev/null)

if [ -n "$TS_ID" ]; then
  resp=$(call GET /api/test-sets/$TS_ID "" "$TOKEN")
  check "GET /api/test-sets/:id" "$resp" 'smoke_testset'

  resp=$(call PUT /api/test-sets/$TS_ID/status '{"status":"disabled"}' "$TOKEN")
  check "PUT /api/test-sets/:id/status" "$resp" 'disabled'

  resp=$(call GET /api/test-sets/$TS_ID/preview-json "" "$TOKEN")
  check "GET /api/test-sets/:id/preview-json" "$resp" 'agent_label'

  resp=$(call POST /api/test-sets/$TS_ID/clone "" "$TOKEN")
  check "POST /api/test-sets/:id/clone" "$resp" 'smoke_testset'
  CLONE_ID=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['id'])" 2>/dev/null)

  if [ -n "$CLONE_ID" ]; then
    call DELETE /api/test-sets/$CLONE_ID "" "$TOKEN" > /dev/null
  fi

  resp=$(call DELETE /api/test-sets/$TS_ID "" "$TOKEN")
  check "DELETE /api/test-sets/:id" "$resp" 'OK'
fi

log_info "7. Jenkins Instances"
resp=$(call GET /api/settings/jenkins "" "$TOKEN")
check "GET /api/settings/jenkins" "$resp" '"code":"OK"'

log_info "8. Pipelines"
resp=$(call GET /api/pipelines "" "$TOKEN")
check "GET /api/pipelines" "$resp" '"code":"OK"'

resp=$(call POST /api/pipelines '{"name":"smoke_pipeline","project":"V3_SOFTWARE_master","triggerType":"manual","jenkinsBindings":[],"params":[]}' "$TOKEN")
check "POST /api/pipelines (create)" "$resp" 'smoke_pipeline'
PL_ID=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['id'])" 2>/dev/null)

if [ -n "$PL_ID" ]; then
  resp=$(call GET /api/pipelines/$PL_ID "" "$TOKEN")
  check "GET /api/pipelines/:id" "$resp" 'smoke_pipeline'

  resp=$(call PUT /api/pipelines/$PL_ID '{"name":"smoke_pipeline_updated","project":"V3_SOFTWARE_master","triggerType":"manual","jenkinsBindings":[],"params":[]}' "$TOKEN")
  check "PUT /api/pipelines/:id (update)" "$resp" 'OK'

  resp=$(call DELETE /api/pipelines/$PL_ID "" "$TOKEN")
  check "DELETE /api/pipelines/:id" "$resp" 'OK'
fi

log_info "9. Users"
resp=$(call GET /api/admin/users "" "$TOKEN")
check "GET /api/admin/users" "$resp" '"code":"OK"'

resp=$(call POST /api/admin/users '{"username":"smoke_user","email":"smoke@test.com","roles":["member"],"projects":[]}' "$TOKEN")
check "POST /api/admin/users (create)" "$resp" 'smoke_user'
USER_ID=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['id'])" 2>/dev/null)

if [ -n "$USER_ID" ]; then
  resp=$(call PUT /api/admin/users/$USER_ID/status '{"status":"disabled"}' "$TOKEN")
  check "PUT /api/admin/users/:id/status" "$resp" 'disabled'
fi

log_info "10. Audit Logs"
resp=$(call GET /api/admin/audit "" "$TOKEN")
check "GET /api/admin/audit" "$resp" '"code":"OK"'

log_info "11. Logout"
resp=$(call POST /api/auth/logout "" "$TOKEN")
check "POST /api/auth/logout" "$resp" 'OK'

echo ""
echo "============================================================"
echo " Results: ${GREEN}${PASS} passed${NC}  ${RED}${FAIL} failed${NC}"
echo "============================================================"

if [ ${#ERRORS[@]} -gt 0 ]; then
  echo -e "\n${RED}Failed tests:${NC}"
  for e in "${ERRORS[@]}"; do
    echo "  - $e"
  done
fi

echo ""
[ $FAIL -eq 0 ] && exit 0 || exit 1

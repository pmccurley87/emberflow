#!/usr/bin/env bash
# Pack-smoke: prove a real `npm install` of the emberflow tarball works
# end-to-end — as a DUAL-LANGUAGE matrix, because the two consumer languages
# take different runtimes:
#
#   JS variant  — plain-JS config (emberflow.config.mjs). Runs entirely on
#                 `node dist/server/*.js`, with NO tsx installed at all. tsx is
#                 an OPTIONAL peer dep, so a JS consumer's install must not pull
#                 it — we assert it is not even resolvable.
#   TS variant  — TypeScript config (emberflow.config.ts). The consumer adds
#                 `tsx` + `typescript` as dev deps and the runner boots the TS
#                 sources under tsx.
#
# Both variants npm-pack the package, install the tarball into a fresh throwaway
# temp project, run `emberflow init`, exercise `test`/`doctor` in-process, then
# boot `emberflow dev` headlessly and assert the studio + API respond AND that
# the runner ran in the runtime we expected (via EMBERFLOW_DEBUG_RUNTIME). This
# exercises files/bin/exports/shebang the way a consumer's `npm install` does —
# unlike any in-repo test.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PORT_JS=8140
PORT_TS=8141
TARBALL=""
declare -a TMP_DIRS=()
RUNNER_PID=""

cleanup() {
  local status=$?
  if [[ -n "$RUNNER_PID" ]] && kill -0 "$RUNNER_PID" 2>/dev/null; then
    pkill -P "$RUNNER_PID" 2>/dev/null || true
    kill "$RUNNER_PID" 2>/dev/null || true
    wait "$RUNNER_PID" 2>/dev/null || true
  fi
  # `emberflow dev` spawns the express server as a deep grandchild, so killing
  # RUNNER_PID + its direct children can leave the listener alive for a moment.
  # Kill whatever still holds either variant's port so it's dead BEFORE we delete
  # its flowsDir (otherwise a late /workflows request scandir's a removed dir).
  local port held
  for port in "$PORT_JS" "$PORT_TS"; do
    held=$(lsof -ti :"$port" -sTCP:LISTEN 2>/dev/null || true)
    if [[ -n "$held" ]]; then
      kill $held 2>/dev/null || true
      sleep 1
    fi
  done
  local d
  for d in "${TMP_DIRS[@]}"; do
    [[ -n "$d" && -d "$d" ]] && rm -rf "$d"
  done
  if [[ -n "$TARBALL" && -f "$REPO_ROOT/$TARBALL" ]]; then
    rm -f "$REPO_ROOT/$TARBALL"
  fi
  exit "$status"
}
trap cleanup EXIT

fail() { echo "[smoke] FAIL: $*" >&2; exit 1; }

# Boot `emberflow dev` in a temp project, wait for health, and assert the studio
# + API respond AND that the runner chose the runtime we expected. The expected
# runtime is read straight from the bin's EMBERFLOW_DEBUG_RUNTIME trace line
# (see bin/emberflow.mjs) — the authoritative record of the node-vs-tsx decision.
#   $1 temp project dir   $2 port   $3 expected runnerMode ('node' | 'tsx')
boot_and_assert() {
  local tmp="$1" port="$2" expect_mode="$3"
  local log="$tmp/dev.log"
  echo "[smoke] booting emberflow dev on port $port (expect runnerMode=$expect_mode)..."
  (
    cd "$tmp"
    EMBERFLOW_DEBUG_RUNTIME=1 EMBERFLOW_RUNNER_PORT="$port" npx emberflow dev --port "$port" >"$log" 2>&1 &
    echo $! > "$tmp/runner.pid"
  )
  RUNNER_PID=$(cat "$tmp/runner.pid")

  local ok=0 i
  for i in $(seq 1 30); do
    if curl -s -o /dev/null -f "http://127.0.0.1:$port/healthz"; then
      ok=1
      break
    fi
    sleep 1
  done
  if [[ "$ok" -ne 1 ]]; then
    echo "---- dev.log ----" >&2; cat "$log" >&2; echo "---- end dev.log ----" >&2
    fail "runner never became healthy on port $port"
  fi

  # The bin prints exactly one runtime trace at startup, to stderr (captured in
  # the log). It is a JSON blob — grep the runnerMode field out of it.
  local dbg
  dbg=$(grep -m1 '\[emberflow\] runtime ' "$log" || true)
  [[ -n "$dbg" ]] || { cat "$log" >&2; fail "no EMBERFLOW_DEBUG_RUNTIME trace line in dev.log"; }
  case "$expect_mode" in
    node) [[ "$dbg" == *'"runnerMode":"node"'* ]] || fail "expected runnerMode 'node', got: $dbg" ;;
    tsx)  [[ "$dbg" == *'"runnerMode":"tsx"'* ]] || fail "expected runnerMode 'tsx', got: $dbg" ;;
    *)    fail "unknown expected mode: $expect_mode" ;;
  esac
  echo "[smoke] runtime trace: $dbg"

  local nodes_body root_body
  nodes_body=$(curl -s "http://127.0.0.1:$port/api/nodes")
  [[ "$nodes_body" == *"nodes"* ]] || fail "/api/nodes did not contain 'nodes': $nodes_body"
  root_body=$(curl -s "http://127.0.0.1:$port/")
  [[ "$root_body" == *'id="root"'* ]] || fail "/ did not contain id=\"root\""
}

# Kill the runner booted by boot_and_assert and free its port, so the next
# variant starts clean.
kill_runner() {
  local port="$1" held
  if [[ -n "$RUNNER_PID" ]] && kill -0 "$RUNNER_PID" 2>/dev/null; then
    pkill -P "$RUNNER_PID" 2>/dev/null || true
    kill "$RUNNER_PID" 2>/dev/null || true
    wait "$RUNNER_PID" 2>/dev/null || true
  fi
  held=$(lsof -ti :"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [[ -n "$held" ]]; then
    kill $held 2>/dev/null || true
    sleep 1
  fi
  RUNNER_PID=""
}

# ---------------------------------------------------------------------------
# Shared: build a FRESH dist + studio, then pack. `build:lib` is explicit (not
# left to prepack) so a stale `dist/` from an earlier build can never sneak into
# the tarball and mask a compile regression the JS runner would hit.
# ---------------------------------------------------------------------------
echo "[smoke] building studio-dist + lib dist (fresh, so the tarball isn't stale)..."
npm run build:studio
npm run build:lib

echo "[smoke] packing tarball..."
TARBALL=$(npm pack --silent | tail -1)
echo "[smoke] tarball: $TARBALL"
tar tzf "$TARBALL" | grep -q 'package/dist/server/index.js' \
  || fail "tarball is missing dist/server/index.js — the JS runner has nothing to run"
tar tzf "$TARBALL" | grep -q 'package/dist/bin/commands.js' \
  || fail "tarball is missing dist/bin/commands.js"

# ===========================================================================
echo ""
echo "==================== VARIANT 1/2: JS (plain Node, no tsx) ===================="
# ===========================================================================
TMP_JS=$(mktemp -d); TMP_DIRS+=("$TMP_JS")
echo "[smoke][js] installing tarball into $TMP_JS ..."
(
  cd "$TMP_JS"
  npm init -y >/dev/null
  npm i --silent "$REPO_ROOT/$TARBALL"
)

echo "[smoke][js] asserting tsx is NOT resolvable from the temp project..."
# tsx is an OPTIONAL peer dep. A plain-JS consumer install must not pull it in.
# If this resolves, the optional-peer-dep move regressed (tsx crept back into
# the hard dep tree). Run with cwd=temp so the resolver uses the temp project's
# module paths.
if ( cd "$TMP_JS" && node -e "require.resolve('tsx')" ) 2>/dev/null; then
  fail "tsx IS resolvable from a JS consumer install — the optional-peer-dep move regressed"
fi

echo "[smoke][js] running emberflow init --js --local --no-launch --yes..."
# --no-launch: init otherwise launches `emberflow dev` itself and never returns.
# --local: install skills into the repo (don't touch \$HOME). --js: scaffold the
# plain-JS config explicitly rather than depend on the non-TTY default.
(cd "$TMP_JS" && npx emberflow init --js --local --no-launch --yes)

[[ -f "$TMP_JS/emberflow.config.mjs" ]] || fail "emberflow.config.mjs was not created"
[[ ! -f "$TMP_JS/emberflow.config.ts" ]] || fail "unexpected emberflow.config.ts in the JS variant"
grep -qF "language: 'javascript'" "$TMP_JS/emberflow.config.mjs" \
  || fail "emberflow.config.mjs missing language: 'javascript'"
grep -qF "@param {import('@xdelivered/emberflow').NodeRegistry}" "$TMP_JS/emberflow.config.mjs" \
  || fail "emberflow.config.mjs missing the JSDoc registry type"
[[ -f "$TMP_JS/emberflow/apis/default/hello.json" ]] || fail "emberflow/apis/default/hello.json was not created"
[[ -f "$TMP_JS/emberflow/apis/default/hello.scenarios.json" ]] || fail "hello.scenarios.json was not created"
[[ -f "$TMP_JS/.claude/skills/emberflow-basics/SKILL.md" ]] || fail ".claude/skills/emberflow-basics/SKILL.md was not created"

echo "[smoke][js] running emberflow test default/hello..."
(cd "$TMP_JS" && npx emberflow test default/hello) || fail "emberflow test default/hello exited non-zero"
echo "[smoke][js] running emberflow doctor default/hello..."
(cd "$TMP_JS" && npx emberflow doctor default/hello) || fail "emberflow doctor default/hello exited non-zero"

boot_and_assert "$TMP_JS" "$PORT_JS" node
kill_runner "$PORT_JS"
echo "SMOKE OK (js)"

# ===========================================================================
echo ""
echo "==================== VARIANT 2/2: TS (under tsx) ===================="
# ===========================================================================
TMP_TS=$(mktemp -d); TMP_DIRS+=("$TMP_TS")
echo "[smoke][ts] installing tarball + tsx + typescript into $TMP_TS ..."
(
  cd "$TMP_TS"
  npm init -y >/dev/null
  npm i --silent "$REPO_ROOT/$TARBALL"
  npm i -D --silent tsx typescript
)

echo "[smoke][ts] asserting tsx IS resolvable now (the consumer installed it)..."
( cd "$TMP_TS" && node -e "require.resolve('tsx')" ) 2>/dev/null \
  || fail "tsx should resolve after 'npm i -D tsx' but does not"

echo "[smoke][ts] running emberflow init --ts --local --no-launch --yes..."
(cd "$TMP_TS" && npx emberflow init --ts --local --no-launch --yes)

[[ -f "$TMP_TS/emberflow.config.ts" ]] || fail "emberflow.config.ts was not created"
[[ ! -f "$TMP_TS/emberflow.config.mjs" ]] || fail "unexpected emberflow.config.mjs in the TS variant"
[[ -f "$TMP_TS/tsconfig.json" ]] || fail "tsconfig.json was not created"
grep -qF "language: 'typescript'" "$TMP_TS/emberflow.config.ts" \
  || fail "emberflow.config.ts missing language: 'typescript'"
[[ -f "$TMP_TS/emberflow/apis/default/hello.json" ]] || fail "emberflow/apis/default/hello.json was not created"
[[ -f "$TMP_TS/emberflow/apis/default/hello.scenarios.json" ]] || fail "hello.scenarios.json was not created"
[[ -f "$TMP_TS/.claude/skills/emberflow-basics/SKILL.md" ]] || fail ".claude/skills/emberflow-basics/SKILL.md was not created"

echo "[smoke][ts] running emberflow test default/hello..."
(cd "$TMP_TS" && npx emberflow test default/hello) || fail "emberflow test default/hello exited non-zero"
echo "[smoke][ts] running emberflow doctor default/hello..."
(cd "$TMP_TS" && npx emberflow doctor default/hello) || fail "emberflow doctor default/hello exited non-zero"

boot_and_assert "$TMP_TS" "$PORT_TS" tsx
kill_runner "$PORT_TS"
echo "SMOKE OK (ts)"

echo ""
echo "SMOKE OK"

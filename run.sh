#!/usr/bin/env bash
#
# run.sh — start Emberflow for local DEVELOPMENT OF EMBERFLOW ITSELF.
#
# Boots two processes with studio HMR and streams both logs here:
#   • Vite dev server   → http://localhost:5173  (the studio, hot-reloads on edit)
#   • Runner (server)   → http://127.0.0.1:8092  (executes flows, holds env secrets)
#
# Open the studio at http://localhost:5173 (it proxies /api to the runner). This
# script opens it for you once both are ready.
#
# NOTE: to just USE Emberflow in a project, prefer the single-process command:
#   npx emberflow dev            (one process on :8092, opens the browser)
# run.sh is for hacking on the studio source, where you want Vite HMR.
#
#   ./run.sh              # normal workspace
#   ./run.sh --project    # project mode (examples/demo-project)
#
# Ctrl-C stops both.

set -uo pipefail
cd "$(dirname "$0")"

VITE_PORT=5173
RUNNER_PORT=8092
# Vite 8 binds to `localhost` (IPv6 ::1), so advertise localhost, not 127.0.0.1.
STUDIO_URL="http://localhost:${VITE_PORT}"

SERVER_SCRIPT="server"
# --project <dir>  → run the runner against that project (its emberflow/apis).
# --project        → the bundled examples/demo-project (back-compat).
if [[ "${1:-}" == "--project" ]]; then
  if [[ -n "${2:-}" && -d "$2" ]]; then
    export EMBERFLOW_PROJECT="$(cd "$2" && pwd)"
    echo "▶ project mode: $EMBERFLOW_PROJECT"
  else
    SERVER_SCRIPT="dev:project"
    echo "▶ project mode: examples/demo-project"
  fi
fi

# Install deps on first run.
if [[ ! -d node_modules ]]; then
  echo "▶ installing dependencies..."
  npm install
fi

# Free the ports if a previous run left something behind.
for port in "$VITE_PORT" "$RUNNER_PORT"; do
  if lsof -ti ":$port" >/dev/null 2>&1; then
    echo "▶ freeing port ${port}..."
    lsof -ti ":$port" | xargs kill 2>/dev/null || true
  fi
done

pids=()

# npm spawns children (tsx→node, vite→esbuild); killing the npm wrapper alone
# orphans them. Walk the tree and kill depth-first so nothing survives Ctrl-C.
kill_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

cleaned=0
cleanup() {
  [[ "$cleaned" == 1 ]] && return
  cleaned=1
  echo ""
  echo "▶ stopping..."
  # "${pids[@]}" on an empty array is an unbound-variable error under set -u in
  # bash 3.2 (macOS default), so only iterate when at least one pid was started.
  if [[ ${#pids[@]} -gt 0 ]]; then
    for pid in "${pids[@]}"; do
      kill_tree "$pid"
    done
  fi
  # Belt and braces: free the ports even if a grandchild slipped the tree walk.
  lsof -ti ":$VITE_PORT" ":$RUNNER_PORT" 2>/dev/null | xargs kill 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "▶ runner  → http://127.0.0.1:$RUNNER_PORT"
if [[ -n "${EMBERFLOW_PROJECT:-}" ]]; then
  # Exclude the project dir from tsx's file watcher. The runner hot-reloads the
  # project's registerNodes IN-PROCESS; a tsx reboot on a config edit (the agent
  # authoring a node mid-build) would kill the in-flight agent run.
  npx tsx watch --ignore "$EMBERFLOW_PROJECT/**" server/index.ts &
else
  npm run "$SERVER_SCRIPT" &
fi
pids+=($!)

echo "▶ studio  → $STUDIO_URL"
npm run dev &
pids+=($!)

# Wait until BOTH are actually serving before declaring ready / opening a browser.
open_browser() {
  case "$(uname -s)" in
    Darwin) open "$1" 2>/dev/null || true ;;
    Linux)  xdg-open "$1" 2>/dev/null || true ;;
    *)      : ;;
  esac
}

ready=0
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${RUNNER_PORT}/healthz" >/dev/null 2>&1 \
     && curl -sf "${STUDIO_URL}/" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done

echo ""
if [[ "$ready" == 1 ]]; then
  echo "▶ ready — opening $STUDIO_URL"
  open_browser "$STUDIO_URL"
else
  echo "▶ started, but one service was slow to answer — open $STUDIO_URL manually."
fi
echo "▶ Ctrl-C to stop."

# Block until interrupted; the EXIT/INT trap stops both children.
wait

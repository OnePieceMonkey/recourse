#!/bin/sh
# Internal services on localhost, the web app on $PORT (the only public port).
set -e
cd /app
(cd apps/facilitator && PORT=4020 node --import tsx src/server.ts) &
# Wait until Recourse answers before the services that register with it start.
i=0; until node -e "fetch('http://127.0.0.1:4020/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; do i=$((i+1)); [ $i -gt 60 ] && break; sleep 1; done
(cd apps/publisher-demo && PORT=4030 node --import tsx src/main.ts) &
sleep 4
# First boot without a stored agent identity: create one and print what to store.
if [ -z "$RECOURSE_AGENT_STATE" ] && [ ! -f "$RECOURSE_DATA_DIR/agent.json" ]; then
  (cd apps/agent && node --import tsx src/main.ts setup) || true
  echo "[deploy] store $RECOURSE_DATA_DIR/agent.json as secret agent-state to keep this identity"
fi
(cd apps/agent && PORT=4040 node --import tsx src/main.ts serve) &
cd apps/web && exec node_modules/.bin/next start --port "${PORT:-8080}" --hostname 0.0.0.0

#!/bin/sh
# Internal services on localhost, web app on $PORT. Seeds the demo owner once per
# container start when no agent state exists (PGlite lives in /tmp unless DATABASE_URL is set).
set -e
cd /app
(cd apps/facilitator && PORT=4020 node --import tsx src/server.ts) &
sleep 3
(cd apps/publisher-demo && PORT=4030 PUBLISHER_PUBLIC_URL=http://127.0.0.1:4030 node --import tsx src/main.ts) &
sleep 3
[ -f "$RECOURSE_DATA_DIR/agent.json" ] || (cd apps/agent && node --import tsx src/main.ts setup)
(cd apps/agent && PORT=4040 node --import tsx src/main.ts serve) &
cd apps/web && exec node_modules/.bin/next start --port "${PORT:-8080}" --hostname 0.0.0.0

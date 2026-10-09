# One container for the hosted demo: Recourse, the demo publishers, the agent
# server and the web app. Only the web app listens publicly; it proxies the rest.
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @recourse/web build

FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY --from=build /app /app
ENV NODE_ENV=production \
    RECOURSE_DATA_DIR=/tmp/recourse-data \
    RECOURSE_FACILITATOR_URL=http://127.0.0.1:4020 \
    RECOURSE_CATALOG_URL=http://127.0.0.1:4030/catalog \
    RECOURSE_AGENT_URL=http://127.0.0.1:4040
EXPOSE 8080
CMD ["sh", "deploy/start.sh"]

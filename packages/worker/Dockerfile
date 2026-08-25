FROM node:22-slim
LABEL org.opencontainers.image.source="https://github.com/opslane/opslane"
LABEL org.opencontainers.image.description="Opslane worker service"

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates patch \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r opslane && useradd -r -g opslane opslane

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY shared/package.json shared/
COPY packages/agent-core/package.json packages/agent-core/
COPY packages/sdk/package.json packages/sdk/
COPY packages/worker/package.json packages/worker/

RUN corepack enable pnpm && pnpm install --frozen-lockfile

COPY shared/ shared/
COPY packages/agent-core/ packages/agent-core/
COPY packages/sdk/ packages/sdk/
COPY packages/worker/ packages/worker/

RUN pnpm --filter @opslane/shared build && \
    pnpm --filter @opslane/agent-core build && \
    pnpm --filter @opslane/sdk build && \
    pnpm --filter @opslane/worker build

RUN chown -R opslane:opslane /app
USER opslane

WORKDIR /app/packages/worker
CMD ["node", "dist/index.js"]

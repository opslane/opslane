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

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN pnpm --filter @opslane/worker exec playwright-core install --with-deps chromium \
    && chmod -R a+rX /ms-playwright

COPY shared/ shared/
COPY packages/agent-core/ packages/agent-core/
COPY packages/sdk/ packages/sdk/
COPY packages/worker/ packages/worker/

RUN pnpm --filter @opslane/shared build && \
    pnpm --filter @opslane/agent-core build && \
    pnpm --filter @opslane/sdk build && \
    pnpm --filter @opslane/worker build

# Runtime writes use OS temp directories; application code and dependencies
# only need to be readable. Avoid recursively changing the ownership of the
# pnpm store (and the bundled browser) in every image build.
# COPY preserves source file modes: on a build host with a restrictive umask,
# copied files arrive 600 root-only and the non-root worker cannot read them
# (Node reports the unreadable package.json as ERR_MODULE_NOT_FOUND). Make the
# copied source trees world-readable; chmod -R does not follow the pnpm-store
# symlinks under each package's node_modules, so this stays cheap.
RUN chmod -R a+rX /app/shared /app/packages && \
    chown -R opslane:opslane /app/packages/worker/dist
USER opslane

WORKDIR /app/packages/worker
CMD ["node", "dist/index.js"]

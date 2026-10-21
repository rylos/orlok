# Orlok app image: API server, background workers and the built web app in one process (R-PRD-1).
# Build from the repository root:
#   docker build -t orlok .
#
# Debian (glibc) rather than Alpine: every native dependency (@napi-rs/canvas, @node-rs/argon2)
# ships prebuilt glibc binaries, ONNX Runtime and Tesseract run as WebAssembly, and glibc is the
# primary target of these packages. Nothing is compiled during the build.

ARG NODE_IMAGE=node:22-trixie-slim

FROM ${NODE_IMAGE} AS pnpm
RUN npm install -g pnpm@11.26.0 && npm cache clean --force
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

# Build: all dependencies, then server bundle (dist/index.mjs + dist/embeddings-worker.mjs) and web.
FROM pnpm AS build
RUN pnpm install --frozen-lockfile --filter @orlok/server... --filter @orlok/web...
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/web apps/web
RUN pnpm --filter @orlok/server build && pnpm --filter @orlok/web build

# Runtime dependencies only (the workspace package is bundled into the server).
FROM pnpm AS prod-deps
RUN pnpm install --frozen-lockfile --prod --filter @orlok/server...

# Built-in embedding model (models:fetch), pinned revision verified by SHA-256. The network is
# needed here only; the running server never downloads anything.
FROM ${NODE_IMAGE} AS models
WORKDIR /repo/apps/server
COPY apps/server/scripts/fetch-models.mjs scripts/
COPY apps/server/src/embeddings-local/models.json src/embeddings-local/
RUN node scripts/fetch-models.mjs

FROM ${NODE_IMAGE}
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
  && groupadd -g 10001 orlok \
  && useradd -u 10001 -g orlok -d /nonexistent -M -s /usr/sbin/nologin orlok

WORKDIR /app
# Everything stays owned by root and read-only for the orlok user.
COPY --from=prod-deps /repo/node_modules node_modules
COPY --from=prod-deps /repo/packages/shared packages/shared
COPY --from=prod-deps /repo/apps/server/node_modules apps/server/node_modules
COPY apps/server/package.json apps/server/
COPY apps/server/drizzle apps/server/drizzle
COPY --from=build /repo/apps/server/dist apps/server/dist
COPY --from=build /repo/apps/web/dist apps/web/dist
COPY --from=models /repo/apps/server/models apps/server/models
# The license travels with every copy (BSL 1.1).
COPY LICENSE ./
LABEL org.opencontainers.image.licenses="BUSL-1.1"

# OCR language data comes from @tesseract.js-data/{eng,ita} in node_modules; the OCR engine
# links it into the temp dir, the only place the server writes to.
ENV NODE_ENV=production \
    PORT=3000 \
    ORLOK_WEB_DIR=/app/apps/web/dist \
    ORLOK_MODELS_DIR=/app/apps/server/models \
    TMPDIR=/tmp
USER orlok
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/apps/server/dist/index.mjs"]

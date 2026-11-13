# syntax=docker/dockerfile:1.7
# One Dockerfile for every Node.js service. Each service is still its own
# image (and its own deployable unit): build with
#   --build-arg SERVICE_PATH=services/case-service
# The dependency and compile stages are shared through the build cache.

FROM node:26-alpine AS manifests
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages packages
COPY services services
COPY apps/gateway apps/gateway
# Keep only package manifests so the dependency layer is re-used until a
# manifest actually changes.
RUN mkdir /out \
 && find . -name package.json -not -path '*/node_modules/*' \
    | while read -r f; do mkdir -p "/out/$(dirname "$f")" && cp "$f" "/out/$f"; done \
 && cp package-lock.json /out/

FROM node:26-alpine AS deps
WORKDIR /repo
COPY --from=manifests /out/ ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# Unit tests in a clean Linux environment:
#   docker build -f infrastructure/docker/node-service.Dockerfile --target unit-test --progress=plain .
FROM deps AS unit-test
COPY tsconfig.base.json tsconfig.build.json tsconfig.json vitest.config.ts ./
COPY packages packages
COPY services services
COPY apps/gateway apps/gateway
RUN npx tsc -b tsconfig.build.json && npx vitest run --config vitest.config.ts

FROM deps AS build
COPY tsconfig.base.json tsconfig.build.json ./
COPY packages packages
COPY services services
COPY apps/gateway apps/gateway
RUN npx tsc -b tsconfig.build.json \
 && npm prune --omit=dev --no-audit --no-fund

FROM node:26-alpine AS runtime
ARG SERVICE_PATH
ENV NODE_ENV=production \
    PORT=3000 \
    UV_THREADPOOL_SIZE=32
# UV_THREADPOOL_SIZE: hostname lookups run on libuv's thread pool (default 4).
# Slow lookups for an unavailable dependency must not starve lookups for
# healthy ones, so the pool is sized well above the number of dependencies.
WORKDIR /repo
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/${SERVICE_PATH} ./${SERVICE_PATH}
WORKDIR /repo/${SERVICE_PATH}
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=6 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/health/live || exit 1
CMD ["node", "dist/main.js"]

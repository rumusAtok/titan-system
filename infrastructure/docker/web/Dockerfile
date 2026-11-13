# syntax=docker/dockerfile:1.7
# TITAN command center: Next.js static export served by unprivileged nginx.
# Build context: repository root.
FROM node:26-alpine AS build
WORKDIR /app
COPY apps/web/package.json apps/web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY apps/web ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.29-alpine AS runtime
USER root
COPY infrastructure/docker/web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY infrastructure/docker/web/15-titan-config.envsh /docker-entrypoint.d/15-titan-config.envsh
COPY --from=build /app/out /usr/share/nginx/html
# config.js is rewritten from the environment when the container starts.
RUN chmod 755 /docker-entrypoint.d/15-titan-config.envsh \
 && chown nginx:nginx /usr/share/nginx/html/config.js
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

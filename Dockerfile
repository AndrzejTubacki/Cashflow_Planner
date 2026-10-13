FROM node:22-bookworm-slim AS base

WORKDIR /app
ENV PORT=3000

FROM base AS production-deps

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Put the runtime target first so legacy builders do not install browser-test
# dependencies when verifying or explicitly building the production image.
FROM base AS runtime

COPY --from=production-deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV LOGS_DIR=/app/logs
ENV TMPDIR=/app/data/tmp
ENV SQLITE_TMPDIR=/app/data/tmp
# COPY preserves host permissions; make root-owned application files readable
# and directories traversable by the runtime user even from a private checkout.
RUN chmod -R a+rX /app
# Named volumes inherit these owners; a fresh bind mount is fixed up by
# docker-entrypoint.sh at container start instead, since it's created by
# Docker as root:root before this build-time step ever runs.
RUN mkdir -p /app/data/tmp /app/logs /app/backups && chown -R node:node /app/data /app/logs /app/backups
# Deliberately stays root here: docker-entrypoint.sh needs root to chown a
# fresh bind-mounted volume, then drops privileges to node via setpriv before
# exec-ing the app. See scripts/docker-entrypoint.sh.
EXPOSE 3000
VOLUME ["/app/data", "/app/logs"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["sh", "/app/scripts/docker-entrypoint.sh"]
CMD ["node", "server.mjs"]

FROM base AS test-deps

COPY package*.json ./
RUN npm ci
RUN npx playwright install --with-deps chromium

FROM base AS test

COPY --from=test-deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=test
ENV DATA_DIR=/app/data
ENV LOGS_DIR=/app/logs
EXPOSE 3000

CMD ["npm", "test"]

# A plain docker build still produces the production image.
FROM runtime AS final

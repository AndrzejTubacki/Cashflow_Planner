FROM node:22-bookworm-slim AS base

WORKDIR /app
ENV PORT=3000

FROM base AS production-deps

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

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

FROM base AS runtime

COPY --from=production-deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV LOGS_DIR=/app/logs
EXPOSE 3000
VOLUME ["/app/data", "/app/logs"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]

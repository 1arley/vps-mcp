# syntax=docker/dockerfile:1.7

FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS dependencies
ENV NODE_ENV=production \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS mcp-runtime
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io postgresql-client ca-certificates git curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies --chown=root:root /app/node_modules ./node_modules
COPY --chown=root:root --chmod=0555 server.js ./server.js
COPY --chown=root:root --chmod=0555 docker-client.js ./docker-client.js
COPY --chown=root:root --chmod=0555 ops-tools.js ./ops-tools.js
COPY --chown=root:root --chmod=0444 ops-allowlist.json ./ops-allowlist.json
COPY --chown=root:root --chmod=0444 package.json ./package.json
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz',{signal:AbortSignal.timeout(2000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]

# Financial Monitoring, as a container.
#
# The application is unchanged by being here: it is still one long-lived Node process writing
# to one SQLite file. What changes is where that file lives - on a mounted volume that
# survives restarts and redeploys, rather than on the office PC's disk.
#
# The volume is the whole point. Without one, every deploy would start with an empty database
# and the records would be gone, which is why this app cannot go on a serverless host.

FROM node:24-slim

# SQLite is built into Node 24; nothing else is compiled, so no build toolchain is needed.
# tini reaps the backup child processes the service spawns and forwards signals properly.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a code change does not re-install them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY scripts ./scripts

# The data directory is the mount point for the persistent volume. Anything written anywhere
# else in this image is lost on the next deploy.
ENV FR_DATA_DIR=/data \
    FR_HOST=0.0.0.0 \
    FR_TRUST_PROXY=1 \
    FR_BACKUP_EVERY_MINUTES=60 \
    NODE_ENV=production

# Run as the unprivileged user the base image already provides, and give it the volume.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 3403

# Healthy once the service answers. docker compose holds Caddy back until then.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.FR_PORT || process.env.PORT || 3403) + '/').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# The platform terminates TLS and forwards; the process itself only ever speaks HTTP.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.mjs"]

# society-chat — Node 22 slim, society-live on :8787
# Secrets: pass via compose env_file (.env). Never bake keys into the image.
FROM node:22-slim

WORKDIR /app

# Non-root user; data dir must be writable (compose mounts ./data)
RUN groupadd --system society \
  && useradd --system --gid society --home-dir /app --shell /usr/sbin/nologin society \
  && mkdir -p /app/data \
  && chown -R society:society /app

# Install deps first for layer cache (tsx is a runtime dependency)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App sources (see .dockerignore — no .env, no node_modules, no host data)
COPY --chown=society:society . .

USER society

ENV NODE_ENV=production \
    SOCIETY_OBSERVE_HOST=0.0.0.0 \
    SOCIETY_OBSERVE_PORT=8787 \
    SOCIETY_SANDBOX_MODE=docker \
    SOCIETY_OBSERVE_ALLOW_REMOTE_SAY=1 \
    SOCIETY_MAX_TICKS=0

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "society-live"]

# Cloud Agent workbench: Node web server + Codex CLI + Claude Code CLI in one image.
FROM node:22-bookworm-slim

# Tools the agent commonly needs for coding and document work.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl tini python3 python3-pip python3-venv poppler-utils ripgrep procps \
 && rm -rf /var/lib/apt/lists/*

ARG CODEX_VERSION=0.169.0
ARG CLAUDE_CODE_VERSION=2.1.326
RUN npm install -g @openai/codex@${CODEX_VERSION} @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Run as the image's non-root "node" user: the container is the agent's sandbox, and
# Claude Code refuses to skip permission prompts as root.
RUN mkdir -p /data && chown -R node:node /data
USER node
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["tini", "--"]
CMD ["node", "src/server.js"]

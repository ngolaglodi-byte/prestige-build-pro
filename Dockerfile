FROM node:20-alpine
RUN apk add --no-cache docker-cli
RUN apk add --no-cache python3 make g++
# Install Claude Code CLI for server-side project generation
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY server.js .
COPY src/ ./src/
COPY public/ ./public/
COPY templates/ ./templates/
COPY scripts/ ./scripts/
RUN mkdir -p /data /tmp/previews /tmp/pb-builds
ENV PORT=3000
ENV DB_PATH=/data/prestige-pro.db
ENV PREVIEWS_DIR=/tmp/previews
ENV BUILDS_DIR=/tmp/pb-builds
ENV SITES_DIR=/data/sites
# ANTHROPIC_API_KEY is injected at runtime via Coolify environment variables
# Claude Code reads it automatically from the environment
# Memory limit for the main server process (Claude Code spawns as separate process)
ENV NODE_OPTIONS="--max-old-space-size=512"
EXPOSE 3000
# Health check every 30 seconds
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1
CMD ["node", "server.js"]

FROM node:20-alpine
RUN apk add --no-cache docker-cli
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY server.js .
COPY src/ ./src/
COPY public/ ./public/
COPY scripts/ ./scripts/
RUN mkdir -p /data /tmp/previews /tmp/pb-builds
ENV PORT=3000
ENV DB_PATH=/data/prestige-pro.db
ENV PREVIEWS_DIR=/tmp/previews
ENV BUILDS_DIR=/tmp/pb-builds
ENV SITES_DIR=/data/sites
# CORRECTION 5: Limit Node.js memory to prevent crashes
ENV NODE_OPTIONS="--max-old-space-size=256"
EXPOSE 3000
# Health check every 30 seconds
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1
CMD ["node", "server.js"]

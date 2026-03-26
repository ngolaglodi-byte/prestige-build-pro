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
EXPOSE 3000
CMD ["node", "server.js"]

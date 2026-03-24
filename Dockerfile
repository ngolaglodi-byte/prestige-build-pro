FROM node:20-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY server.js .
COPY public/ ./public/
RUN mkdir -p /data
ENV PORT=3000
ENV DB_PATH=/data/prestige-pro.db
EXPOSE 3000
CMD ["node", "server.js"]

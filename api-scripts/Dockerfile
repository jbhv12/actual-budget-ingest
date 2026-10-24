FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./

EXPOSE 5007
HEALTHCHECK --interval=10s --timeout=5s --start-period=120s --retries=3 \
  CMD wget -qO- http://localhost:5007/accounts >/dev/null 2>&1 || exit 1
CMD ["node", "server.js"]

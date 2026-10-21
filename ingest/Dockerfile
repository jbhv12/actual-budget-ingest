FROM node:22-alpine

RUN apk add --no-cache qpdf

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY banks.yaml ./banks.yaml

CMD ["node", "src/ingest-watch.js"]

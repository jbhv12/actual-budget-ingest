FROM node:22-alpine

RUN apk add --no-cache qpdf

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY banks.yaml ./banks.yaml
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x /app/entrypoint.sh

CMD ["/app/entrypoint.sh"]

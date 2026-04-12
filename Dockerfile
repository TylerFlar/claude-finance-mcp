FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

RUN npx playwright install chromium --with-deps

ENV MCP_TRANSPORT=http
ENV MCP_PORT=3100
ENV TOKEN_DIR=/data/tokens
ENV BROWSER_DATA_DIR=/data/browser
ENV HEADLESS=true

EXPOSE 3100
VOLUME ["/data/tokens", "/data/browser"]

CMD ["node", "dist/index.js"]

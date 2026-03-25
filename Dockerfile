FROM node:20-alpine

WORKDIR /app

ARG SNAIL_BUILD_COMMIT=""

ENV NODE_ENV=production \
    SNAIL_BUILD_COMMIT=${SNAIL_BUILD_COMMIT}

RUN apk add --no-cache docker-cli

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit

COPY auto_register.js ./
COPY public ./public
COPY scripts ./scripts
COPY src ./src

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"

CMD ["node", "src/server.js"]

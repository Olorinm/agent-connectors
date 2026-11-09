FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && npm rebuild @larksuite/cli --ignore-scripts=false
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund
# agent-browser's package carries every platform's binary (about 116 MB); keep only this image's, executable.
ARG TARGETARCH
RUN arch=$([ "$TARGETARCH" = "arm64" ] && echo arm64 || echo x64) \
    && find node_modules -path '*/agent-browser/bin/agent-browser-*' ! -name "agent-browser-linux-$arch" ! -name '*.js' -delete \
    && find node_modules -path "*/agent-browser/bin/agent-browser-linux-$arch" -exec chmod 0755 {} +

FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE NOTICE ./
ENV NODE_ENV=production
USER node
EXPOSE 18100
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve", "--config", "/etc/agent-connectors/connectors.json"]

ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG NEXT_DEPLOYMENT_ID
ENV NEXT_STANDALONE=1
RUN NEXT_DEPLOYMENT_ID="${NEXT_DEPLOYMENT_ID:-$(node -p 'require("node:crypto").randomUUID()')}" npm run build

FROM base AS production-dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM base AS migrate
ENV NODE_ENV=production
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY db ./db
USER node
CMD ["node", "db/migrate.mjs"]

FROM base AS runner
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# These files are read at runtime, outside the JS bundle.
COPY --from=build /app/src/assets/fonts ./src/assets/fonts
COPY --from=build /app/node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm ./node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm
RUN mkdir -p .next/cache .data/storage && chown node:node .next/cache .data/storage
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "server.js"]

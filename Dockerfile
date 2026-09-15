FROM node:24.17.0-bookworm-slim AS dolphin-build
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY native/dolphin/fetch.py native/dolphin/worker.cpp /native/
RUN python3 /native/fetch.py /opt/dolphin \
    && g++ -O2 -std=c++17 /native/worker.cpp -I /opt/dolphin -L /opt/dolphin/lib \
       -lsherpa-onnx-c-api -Wl,-rpath,'$ORIGIN/lib' -o /opt/dolphin/worker
COPY native/dolphin/licenses /opt/dolphin/licenses

FROM node:24.17.0-bookworm-slim AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN npm install --global pnpm@11.3.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts/smoke-runtime.mjs ./scripts/
RUN pnpm build && pnpm smoke:runtime && pnpm prune --prod

FROM node:24.17.0-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=dolphin-build /opt/dolphin /opt/dolphin
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/scripts ./scripts

RUN install -d -m 700 -o node -g node /data
USER node
VOLUME ["/data"]

CMD ["node", "dist/index.js"]

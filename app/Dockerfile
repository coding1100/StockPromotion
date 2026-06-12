FROM node:22-bookworm-slim AS builder
WORKDIR /usr/src/app

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig*.json ./
COPY nest-cli.json ./
COPY src ./src
RUN npm run build

# Must match the `playwright` npm version in package.json / package-lock.json.
FROM mcr.microsoft.com/playwright:v1.58.2-noble AS runtime
WORKDIR /usr/src/app

ENV NODE_ENV=production

# Virtual display + VNC tools so Chrome can run headed and be viewed via noVNC.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       xvfb \
       x11vnc \
       novnc \
       python3-websockify \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Install Firefox (used for Discord UI automation — less fingerprinted than Chromium).
RUN npx playwright install firefox

# Install the exact Chromium revision required by the playwright package in node_modules.
RUN npx playwright install chromium

# Install patchright's patched Chromium. patchright is a Playwright fork that
# patches CDP-level detection vectors (Runtime.enable etc.) which the JS stealth
# plugin cannot address. Its Chromium binary is separate from Playwright's.
RUN npx patchright install chromium --with-deps 2>&1 | tail -5 || true

COPY --from=builder /usr/src/app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /usr/src/app/node_modules/@prisma ./node_modules/@prisma
COPY prisma ./prisma
COPY --from=builder /usr/src/app/dist ./dist
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# 3000 = app API, 6080 = noVNC web viewer
EXPOSE 3000 6080
CMD ["./entrypoint.sh"]

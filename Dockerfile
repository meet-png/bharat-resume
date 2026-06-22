# Bharat Resume — production image.
# The app renders resume PDFs and scrapes Naukri with Puppeteer, which needs a
# real Chromium plus its shared libraries at runtime. We install the distro
# Chromium, tell Puppeteer to skip its own browser download, and point it at the
# system binary via PUPPETEER_EXECUTABLE_PATH (puppeteer.launch() honors it, so
# no code change is needed).
FROM node:20-bookworm-slim

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

# chromium + the libs it dlopen()s, fonts so the PDF has real glyphs (incl. ₹),
# and dumb-init to reap the child processes Chromium spawns.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      fonts-noto-core \
      ca-certificates \
      dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install prod deps first for layer caching. Puppeteer's postinstall browser
# download is skipped by the ENV above, so npm ci stays fast and small.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Drop privileges — the base image ships an unprivileged 'node' user.
USER node

EXPOSE 3000

# dumb-init as PID 1 so SIGTERM from Railway cleanly stops node + Chromium.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]

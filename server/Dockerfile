# node:22-slim (Debian, glibc) rather than alpine: better-sqlite3 ships
# prebuilt binaries for glibc, so this avoids needing a C++ toolchain in the
# image (see README's Windows/Visual-Studio note for the same underlying issue).
FROM node:22-slim

WORKDIR /app

# better-sqlite3 has no prebuilt binary for every base-image/arch combo, so it
# falls back to building from source (node-gyp) - these are that fallback's
# only requirements, removed again in the same layer to keep the image small.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]

FROM node:22-bookworm-slim

# Build tools for node-pty's native addon, plus the Docker CLI (client only) so
# ptyd can launch sibling run-containers against the mounted host docker socket.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates curl \
  && curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.3.1.tgz \
     | tar xz --strip-components=1 -C /usr/local/bin docker/docker \
  && apt-get purge -y curl && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV PORT=8081
EXPOSE 8081
CMD ["node", "server.js"]

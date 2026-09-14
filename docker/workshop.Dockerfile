FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 chromium ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --prefix /opt/tools playwright-core@1.58.2
ENV NODE_PATH=/opt/tools/node_modules
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV HOME=/tmp
WORKDIR /workspace
USER node
CMD ["sleep", "infinity"]

FROM node:22.23.3-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY deploy ./deploy
COPY tsconfig*.json ./
RUN pnpm run build
ENV PORT=3000 DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["node", "dist/server.mjs"]

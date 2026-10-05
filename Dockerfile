FROM oven/bun:1.3.6
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY public ./public
RUN bun run build
COPY tsconfig*.json ./
ENV PORT=3000 DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["bun", "src/server.ts"]

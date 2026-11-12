FROM node:24-bookworm-slim
WORKDIR /app
RUN npm install --global pnpm@10.11.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY src ./src
COPY scripts ./scripts
USER node
ENV NODE_ENV=production
CMD ["node", "src/bot.js"]

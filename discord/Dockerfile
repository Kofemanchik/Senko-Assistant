# Senko Assistant · Discord-бот в контейнере (любой хостинг с Docker или VPS)
#   docker build -t senko-bot .
#   docker run -d --name senko-bot --restart unless-stopped --env-file .env senko-bot
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
CMD ["node", "bot.js"]

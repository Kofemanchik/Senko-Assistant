// pm2: бот работает постоянно и перезапускается при сбое и после перезагрузки сервера.
//   npm i -g pm2
//   pm2 start ecosystem.config.js
//   pm2 save && pm2 startup   (команду, которую выведет pm2 startup, выполнить один раз)
module.exports = {
  apps: [
    {
      name: "senko-bot",
      script: "bot.js",
      cwd: __dirname,
      autorestart: true,
      restart_delay: 5000,
      max_memory_restart: "300M",
      env: { NODE_ENV: "production" },
    },
  ],
};

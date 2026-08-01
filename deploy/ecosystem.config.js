// Конфиг для PM2 — менеджера процессов, который держит сервер запущенным
// в фоне, сам перезапускает его при падении и после перезагрузки сервера.
//
// Установка и запуск (один раз на VPS):
//   npm install -g pm2
//   cd MyTube/server && npm install
//   pm2 start ../deploy/ecosystem.config.js
//   pm2 save
//   pm2 startup     <-- выполнит команду, которую напечатает pm2, чтобы
//                        сайт поднимался сам после перезагрузки сервера
//
// Полезные команды:
//   pm2 status            — статус процесса
//   pm2 logs mytube        — логи в реальном времени
//   pm2 restart mytube     — перезапуск (например, после обновления кода)
//   pm2 monit              — использование CPU/памяти

module.exports = {
  apps: [
    {
      name: "mytube",
      script: "./server/server.js",
      cwd: __dirname + "/..",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        TRUST_PROXY: "1"
      },
      max_memory_restart: "500M",
      autorestart: true,
      restart_delay: 3000
    }
  ]
};

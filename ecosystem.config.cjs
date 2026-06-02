module.exports = {
  apps: [
    {
      name: "symphony-orchestrator",
      script: "/Users/zhiwei/Documents/symphony/scripts/symphony-daemon.sh",
      cwd: "/Users/zhiwei/Documents/symphony/elixir",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 10000,
      watch: false,
      env: {
        // Loaded by symphony-daemon.sh from elixir/.env
      },
      // pm2 logs
      output: "/Users/zhiwei/Documents/symphony/elixir/logs/pm2-stdout.log",
      error: "/Users/zhiwei/Documents/symphony/elixir/logs/pm2-stderr.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
      max_restarts_per_min: 5,
      kill_timeout: 10000,
      listen_timeout: 15000,
    },
  ],
};

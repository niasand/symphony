module.exports = {
  apps: [
    {
      name: 'symphony-miniagent',
      cwd: '/Users/zhiwei/Documents/symphony/elixir',
      script: '/Users/zhiwei/Documents/symphony/scripts/symphony-miniagent-daemon.sh',
      interpreter: 'bash',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
      }
    },
  ]
};

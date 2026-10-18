module.exports = {
  apps: [
    {
      name: 'unieconnect-backend',
      cwd: __dirname,
      script: '.current/dist/server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      listen_timeout: 10000,
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};



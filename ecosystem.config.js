module.exports = {
  apps: [
    {
      name: 'unieconnect-backend',
      script: 'dist/server.js', // adjust if entry point changes
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};



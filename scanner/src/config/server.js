function getServerConfig() {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    enableBackgroundTasks: process.env.ENABLE_BACKGROUND_TASKS === '1' || process.env.ENABLE_BACKGROUND_TASKS === 'true',
    serveStatic: process.env.SERVE_STATIC !== '0' && process.env.SERVE_STATIC !== 'false',
    dryRun: process.env.SCAN_DRY_RUN === '1' || process.env.SCAN_DRY_RUN === 'true'
  };
}

module.exports = {
  getServerConfig
};

import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { logger } from './lib/logger.js';
import { ensureBucket } from './lib/storage.js';

const app = createApp();
ensureBucket()
  .then((where) => logger.info(`file storage: ${where}`))
  .catch((err) => logger.warn({ err: err?.message }, 'file storage is not reachable; photo uploads and exports will fail'));

const server = app.listen(config.PORT, () => logger.info(`CityFix API listening on :${config.PORT}`));

const shutdown = () => {
  logger.info('shutting down');
  server.close(() => pool.end().then(() => process.exit(0)));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

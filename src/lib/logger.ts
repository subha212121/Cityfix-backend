import { pino } from 'pino';
import { config, isTest } from '../config.js';

export const logger = pino({
  level: isTest ? 'silent' : config.LOG_LEVEL,
  redact: ['req.headers.authorization', '*.password', '*.password_hash', '*.refresh_token', '*.token'],
});

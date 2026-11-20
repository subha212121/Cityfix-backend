import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import { config, isTest } from './config.js';
import { logger } from './lib/logger.js';
import { readToken } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { authRouter } from './modules/auth/routes.js';
import { meRouter } from './modules/me/routes.js';
import { uploadsRouter } from './modules/uploads/routes.js';
import { filesRouter } from './modules/uploads/files.js';
import { aiRouter, incidentsRouter } from './modules/incidents/routes.js';
import { mapRouter } from './modules/map/routes.js';
import { chatRouter } from './modules/chat/routes.js';
import { notificationsRouter } from './modules/notifications/routes.js';
import { dashboardsRouter } from './modules/dashboards/routes.js';
import { adminRouter } from './modules/admin/routes.js';
import { exportsRouter } from './modules/exports/routes.js';
import { healthCheck, metaRouter } from './modules/meta/routes.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGINS.split(',').map((s) => s.trim()), credentials: false }));
  app.use(express.json({ limit: '200kb' }));
  if (!isTest) app.use(pinoHttp({ logger }));
  app.use(rateLimit({ windowMs: 60_000, limit: isTest ? 100_000 : 300, standardHeaders: 'draft-8', legacyHeaders: false }));
  app.use(readToken);

  app.get('/health', async (_req, res) => res.json(await healthCheck()));

  const v1 = express.Router();
  v1.use('/auth', authRouter);
  v1.use('/me', meRouter);
  v1.use('/uploads', uploadsRouter);
  v1.use('/files', filesRouter);
  v1.use('/ai', aiRouter);
  v1.use('/incidents', incidentsRouter);
  v1.use('/map', mapRouter);
  v1.use('/chat', chatRouter);
  v1.use('/notifications', notificationsRouter);
  v1.use('/dashboard', dashboardsRouter);
  v1.use('/admin', adminRouter);
  v1.use('/exports', exportsRouter);
  v1.use('/meta', metaRouter);
  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

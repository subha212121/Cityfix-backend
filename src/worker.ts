import cron from 'node-cron';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { logger } from './lib/logger.js';
import {
  autoClose, deliverNotifications, generateSummaries, previousMonthSummary, refreshStats, runExportJobs, slaAlerts,
} from './jobs/index.js';

const enabled = new Set(config.WORKER_ENABLED_JOBS.split(',').map((s) => s.trim()));

/** Runs a job without overlapping itself; errors are logged, never fatal. */
function job(name: string, schedule: string, fn: () => Promise<unknown>) {
  if (!enabled.has(name)) return;
  let running = false;
  cron.schedule(schedule, async () => {
    if (running) return;
    running = true;
    try {
      const result = await fn();
      logger.debug({ job: name, result }, 'job done');
    } catch (err) {
      logger.error({ err, job: name }, 'job failed');
    } finally {
      running = false;
    }
  }, { timezone: 'Australia/Sydney' });
  logger.info({ job: name, schedule }, 'job scheduled');
}

job('deliveries', '*/10 * * * * *', deliverNotifications);   // every 10 s
job('exports', '*/30 * * * * *', runExportJobs);               // every 30 s
job('summaries', '0 * * * * *', generateSummaries);            // every minute
job('stats', '0 */15 * * * *', refreshStats);                  // every 15 min
job('sla', '0 5 * * * *', slaAlerts);                          // hourly at :05
job('autoclose', '0 0 2 * * *', autoClose);                    // daily 02:00
job('monthly', '0 0 3 1 * *', previousMonthSummary);           // 1st of month 03:00

logger.info('CityFix worker started');
process.on('SIGTERM', () => pool.end().then(() => process.exit(0)));

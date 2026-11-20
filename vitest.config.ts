import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests run against a real PostgreSQL + PostGIS. The global setup drops and
// recreates the test database from db/001_schema.sql + db/002_seed.sql.
// Read here (not only in test.env) so the global setup sees the same values.
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://cityfix_app:change-me@localhost:5432/cityfix_test';
export const TEST_DATABASE_ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';

export default defineConfig({
  test: {
    globalSetup: ['./tests/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      DATABASE_ADMIN_URL: TEST_DATABASE_ADMIN_URL,
      JWT_SECRET: 'test-secret-test-secret-test-secret-123456',
      AI_PROVIDER: 'none',
      STORAGE_DRIVER: 'local',
      LOCAL_STORAGE_DIR: path.join(os.tmpdir(), 'cityfix-test-storage'),
      PUBLIC_API_URL: 'http://localhost:3000',
    },
  },
});

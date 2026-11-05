import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './packages/adapters/src/db/schema/pg.schema.ts',
  out: './packages/adapters/src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgresql://localhost:5432/harness',
  },
  verbose: true,
  strict: true,
});

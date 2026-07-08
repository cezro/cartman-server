import 'dotenv/config';
import path from 'node:path';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: path.join(__dirname, 'prisma', 'schema.prisma'),
  datasource: {
    // Migrations need a direct (non-pgbouncer) connection — use the session-mode pooler.
    url: env('DIRECT_URL'),
  },
  migrations: {
    // Prisma 7 reads the seed command from here, not package.json#prisma.seed.
    seed: 'ts-node prisma/seed.ts',
  },
});

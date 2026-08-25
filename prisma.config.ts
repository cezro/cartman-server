import 'dotenv/config';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

/**
 * Migrations and introspection need a direct (non-pgbouncer) connection — the
 * session-mode pooler. `DIRECT_URL` is where that lives.
 *
 * **Deliberately not `env('DIRECT_URL')`.** Prisma 7 resolves the datasource
 * when it *loads this config*, which every command does — `generate` included,
 * even though it never opens a connection. So `env()` made `npm install` fail
 * at `postinstall` on any checkout without a `.env`:
 *
 *     PrismaConfigEnvError: Cannot resolve environment variable: DIRECT_URL
 *
 * That is a confusing failure in two places at once. On a fresh clone it stops
 * the install before anything is built, for a variable codegen does not need.
 * On Render it makes `DIRECT_URL` load-bearing for the *deploy* while
 * `render.yaml` describes it as a convenience for `db:drift` — so removing it
 * as unused config breaks the next deploy with an error naming Prisma and not
 * the cause.
 *
 * The placeholder keeps `generate` working with nothing set, and any command
 * that actually connects fails against a host that says what is wrong.
 */
const DIRECT_URL =
  process.env.DIRECT_URL ??
  'postgresql://DIRECT_URL_is_not_set@direct-url-is-not-set.invalid:5432/postgres';

export default defineConfig({
  schema: path.join(__dirname, 'prisma', 'schema.prisma'),
  datasource: {
    url: DIRECT_URL,
  },
  migrations: {
    // Prisma 7 reads the seed command from here, not package.json#prisma.seed.
    seed: 'ts-node prisma/seed.ts',
  },
});

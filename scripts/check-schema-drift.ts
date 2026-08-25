/**
 * Diff `prisma/schema.prisma` against a live database. Read-only: it opens a
 * connection, reads `information_schema`, and writes nothing.
 *
 * Why this exists
 * ---------------
 * `schema.prisma` is a mirror of cartman-mobile/supabase/migrations/, and
 * nothing enforced that. On 2026-08-20 four objects were found missing from
 * CartmanPH with their migrations still recorded as applied — `busy_until`,
 * `push_outbox`, `order_messages`, and the grants on two more tables. Two of
 * them were live outages. The cause was `prisma db push --accept-data-loss` on
 * the deploy path: it drops what the schema does not mention and writes no
 * `_prisma_migrations` row, so it leaves no trace.
 *
 * That command is gone from `render.yaml`, but the drift it fed on is the real
 * hazard, and it returns every time a migration lands in the other repo. This
 * makes the drift visible in one command instead of in an outage.
 *
 * Run it after applying any migration in cartman-mobile:
 *
 *     npm run db:drift
 *
 * Exit 0 = the schema matches. Non-zero = it does not, and the report says
 * which way each difference runs — a "live-only" column is one `db push` would
 * DROP, which is the direction that costs data.
 *
 * What this CANNOT see
 * --------------------
 * It compares **tables, columns and enum values only**. It does not compare
 * policies, grants, triggers, functions, indexes, defaults, nullability, or
 * column types — Prisma models none of those, so this is a limit of the
 * approach and not a gap in the code.
 *
 * That matters more than it sounds, because of what the 08-20 incident
 * actually was. Four objects were lost: `busy_until`, `push_outbox`,
 * `order_messages` — all three of which this would have caught — **and the
 * policies and grants on `incident_reports` / `verification_events`, which it
 * would have been blind to.**
 *
 * So a clean run here means the *mirror* is honest. It is not a statement
 * about policies or grants, and `schema.prisma` cannot be one either:
 * `supabase/migrations/` in cartman-mobile is the only authority for those.
 * Read a green result as "`db push` would not drop a table or a column", not
 * as "the drift story is finished".
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

/** Prisma's own bookkeeping table — it is not, and should not be, modelled. */
const IGNORED_TABLES = new Set(['_prisma_migrations']);

type Cols = Set<string>;

interface LiveSchema {
  tables: Map<string, Cols>;
  /** Views are read through, never created by Prisma — reported, not diffed. */
  views: Set<string>;
  enums: Map<string, string[]>;
}

async function readLiveSchema(url: string): Promise<LiveSchema> {
  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const views = new Set<string>(
      (
        await client.query<{ table_name: string }>(
          `select table_name from information_schema.views where table_schema = 'public'`,
        )
      ).rows.map((r) => r.table_name),
    );

    const tables = new Map<string, Cols>();
    for (const row of (
      await client.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'`,
      )
    ).rows) {
      tables.set(row.table_name, new Set());
    }

    for (const row of (
      await client.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name from information_schema.columns
          where table_schema = 'public'`,
      )
    ).rows) {
      // information_schema.columns covers views too; only tables are diffed.
      tables.get(row.table_name)?.add(row.column_name);
    }

    const enums = new Map<string, string[]>();
    for (const row of (
      await client.query<{ typname: string; labels: string }>(
        `select t.typname, string_agg(e.enumlabel, ',' order by e.enumsortorder) as labels
           from pg_type t
           join pg_enum e on e.enumtypid = t.oid
           join pg_namespace n on n.oid = t.typnamespace
          where n.nspname = 'public'
          group by t.typname`,
      )
    ).rows) {
      enums.set(row.typname, row.labels.split(','));
    }

    return { tables, views, enums };
  } finally {
    await client.end();
  }
}

interface PrismaSchema {
  models: Map<string, Cols>;
  enums: Map<string, string[]>;
}

export function parsePrismaSchema(source: string): PrismaSchema {
  const models = new Map<string, Cols>();
  const enums = new Map<string, string[]>();

  const modelNames = new Set(
    [...source.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]),
  );

  const blocks = source.matchAll(/^(model|enum)\s+(\w+)\s*\{([\s\S]*?)^\}/gm);
  for (const [, kind, name, body] of blocks) {
    const lines = body
      .split('\n')
      .map((l) => l.replace(/\/\/.*/, '').trim())
      .filter(Boolean);

    if (kind === 'enum') {
      enums.set(
        name,
        lines.filter((l) => !l.startsWith('@@')),
      );
      continue;
    }

    const cols: Cols = new Set();
    let tableName = name;
    for (const line of lines) {
      if (line.startsWith('@@map(')) {
        tableName = /@@map\("([^"]+)"\)/.exec(line)?.[1] ?? tableName;
        continue;
      }
      if (line.startsWith('@@')) continue;

      const field = /^(\w+)\s+(\S+)/.exec(line);
      if (!field) continue;
      const [, fieldName, rawType] = field;

      // A relation field names another model and backs no column of its own.
      // Scalar foreign keys (`merchant_id String`) are ordinary fields and are
      // kept — it is the object side (`merchant merchants`) that is dropped.
      const baseType = rawType.replace(/[[\]?]/g, '');
      if (modelNames.has(baseType)) continue;

      cols.add(/@map\("([^"]+)"\)/.exec(line)?.[1] ?? fieldName);
    }
    models.set(tableName, cols);
  }

  return { models, enums };
}

export function report(live: LiveSchema, schema: PrismaSchema): string[] {
  const problems: string[] = [];

  for (const [table, cols] of [...live.tables].sort()) {
    if (IGNORED_TABLES.has(table)) continue;
    if (!schema.models.has(table)) {
      problems.push(
        `table \`${table}\` exists in the database and has no model.\n` +
          `      A \`db push\` would DROP it, with its ${cols.size} column(s).`,
      );
    }
  }

  for (const table of [...schema.models.keys()].sort()) {
    if (live.tables.has(table)) continue;
    const asView = live.views.has(table)
      ? ' It exists as a VIEW — model it as a view or not at all, never as a model.'
      : '';
    problems.push(`model \`${table}\` has no table in the database.${asView}`);
  }

  for (const [table, liveCols] of [...live.tables].sort()) {
    if (IGNORED_TABLES.has(table)) continue;
    const modelCols = schema.models.get(table);
    if (!modelCols) continue;

    const liveOnly = [...liveCols].filter((c) => !modelCols.has(c)).sort();
    const modelOnly = [...modelCols].filter((c) => !liveCols.has(c)).sort();

    if (liveOnly.length) {
      problems.push(
        `\`${table}\`: in the database, absent from the model — ${liveOnly.join(', ')}.\n` +
          `      This is the direction that costs data: \`db push\` DROPS these.`,
      );
    }
    if (modelOnly.length) {
      problems.push(
        `\`${table}\`: in the model, absent from the database — ${modelOnly.join(', ')}.\n` +
          `      Reads of these columns fail at runtime. A migration is missing.`,
      );
    }
  }

  for (const [name, labels] of [...live.enums].sort()) {
    const modelLabels = schema.enums.get(name);
    if (!modelLabels) {
      problems.push(
        `enum \`${name}\` exists in the database and has no model.`,
      );
      continue;
    }
    const liveOnly = labels.filter((l) => !modelLabels.includes(l));
    const modelOnly = modelLabels.filter((l) => !labels.includes(l));
    if (liveOnly.length) {
      problems.push(
        `enum \`${name}\`: values in the database, absent from the model — ${liveOnly.join(', ')}.\n` +
          `      Prisma throws on reading a row that holds one of these.`,
      );
    }
    if (modelOnly.length) {
      problems.push(
        `enum \`${name}\`: values in the model, absent from the database — ${modelOnly.join(', ')}.`,
      );
    }
  }

  for (const name of [...schema.enums.keys()].sort()) {
    if (!live.enums.has(name)) {
      problems.push(`enum \`${name}\` has no type in the database.`);
    }
  }

  return problems;
}

async function main(): Promise<void> {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('Set DIRECT_URL (preferred) or DATABASE_URL before running.');
    process.exit(2);
  }

  const live = await readLiveSchema(url);
  const schema = parsePrismaSchema(
    readFileSync(join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8'),
  );
  const problems = report(live, schema);

  if (live.views.size) {
    console.log(
      `Views (not Prisma's to manage, ignored): ${[...live.views].sort().join(', ')}\n`,
    );
  }

  if (!problems.length) {
    // Counted from the ignored tables actually present, not from the size of
    // the ignore list — a database with no `_prisma_migrations` would
    // otherwise be reported as having one table fewer than it has.
    const ignoredPresent = [...IGNORED_TABLES].filter((t) =>
      live.tables.has(t),
    ).length;
    console.log(
      `schema.prisma matches the database: ` +
        `${live.tables.size - ignoredPresent} tables, ${live.enums.size} enums. ` +
        `(Tables, columns and enums only — not policies, grants, triggers, ` +
        `functions or indexes; supabase/migrations is the authority for those.)`,
    );
    return;
  }

  console.error(
    `schema.prisma has drifted from the database — ${problems.length} difference(s):\n`,
  );
  for (const problem of problems) console.error(`  - ${problem}\n`);
  console.error(
    'Fix by editing prisma/schema.prisma to match, or by applying the missing\n' +
      'migration in cartman-mobile. Never by running `prisma db push`.',
  );
  process.exit(1);
}

void main().catch((err: unknown) => {
  console.error(
    'Drift check could not run:',
    err instanceof Error ? err.message : err,
  );
  process.exit(2);
});

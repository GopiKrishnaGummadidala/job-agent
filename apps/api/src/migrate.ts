import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { config } from './config';

/** Applies migrations/*.sql in order, once each, as the database owner. */
export async function migrate(): Promise<string[]> {
  const dir = join(__dirname, '../../migrations');
  const client = new Client({ connectionString: config.migrateUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock(727001)');
    await client.query(
      'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
    );
    const done = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      await client.query('begin');
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
        applied.push(file);
      } catch (e) {
        await client.query('rollback');
        throw e;
      }
    }
    const pw = (await client.query('select quote_literal($1::text) as q', [config.appDbPassword])).rows[0].q;
    await client.query(`alter role jobagent_app password ${pw}`);
  } finally {
    await client.end();
  }
  return applied;
}

if (require.main === module) {
  migrate()
    .then((a) => console.log(a.length ? `Applied: ${a.join(', ')}` : 'Database is up to date'))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

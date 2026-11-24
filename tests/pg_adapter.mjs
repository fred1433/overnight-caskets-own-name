// Gives a node-postgres connection the two methods site/db.js uses (exec, query), on a
// fresh schema built from the same SQL files. Used only when PG_TEST_URL is set.
import pg from 'pg';

export async function pgAdapter(url, { shim, migration, seed }) {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`drop schema if exists app cascade; drop schema if exists public cascade; create schema public;
    drop schema if exists auth cascade;`);
  await admin.end();
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  // pg returns bigint as text; the tests compare numbers
  pg.types.setTypeParser(20, (v) => Number(v));
  await c.query(shim);
  await c.query(migration);
  await c.query(seed);
  return {
    exec: (sql) => c.query(sql),
    query: async (sql, params = []) => { const r = await c.query(sql, params); return { rows: r.rows, affectedRows: r.rowCount }; },
    close: () => c.end(),
  };
}

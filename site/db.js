// The demo's database: Postgres 17 compiled to WebAssembly (PGlite), in this page, with the
// same migration and row level security policies as supabase/migrations. Used by the page
// and by tests/rls.test.mjs.

export async function openDb(PGlite, { shim, migration, seed }) {
  const db = new PGlite();
  await db.exec(shim);
  await db.exec(migration);
  await db.exec(seed);
  return db;
}

// Run one statement as a signed-in person: role authenticated and the user id in the token
// claims, which is what Supabase does for each API request. commit: false rolls back.
// PGlite has one connection: statements of two callers must not interleave inside a transaction.
const queues = new WeakMap();
function serial(db, fn) {
  const prev = queues.get(db) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(db, next.catch(() => {}));
  return next;
}

export function runAs(db, user, sql, params = [], opts = {}) {
  return serial(db, () => runAsNow(db, user, sql, params, opts));
}

async function runAsNow(db, user, sql, params = [], { commit = false } = {}) {
  const claims = JSON.stringify({ sub: user.id, role: 'authenticated' });
  try {
    await db.exec('begin');
    await db.query("select set_config('request.jwt.claims', $1, true)", [claims]);
    await db.exec('set local role authenticated');
    const r = await db.query(sql, params);
    await db.exec(commit ? 'commit' : 'rollback');
    return { rows: r.rows, affected: r.affectedRows ?? 0 };
  } catch (e) {
    try { await db.exec('rollback'); } catch (_) { /* already closed */ }
    return { error: String(e && e.message ? e.message : e) };
  }
}

// Several statements in one signed-in transaction (saving an arrangement and its lines).
export function transactionAs(db, user, fn) {
  return serial(db, () => transactionAsNow(db, user, fn));
}

async function transactionAsNow(db, user, fn) {
  const claims = JSON.stringify({ sub: user.id, role: 'authenticated' });
  await db.exec('begin');
  try {
    await db.query("select set_config('request.jwt.claims', $1, true)", [claims]);
    await db.exec('set local role authenticated');
    const out = await fn((sql, params = []) => db.query(sql, params));
    await db.exec('commit');
    return out;
  } catch (e) {
    try { await db.exec('rollback'); } catch (_) { /* already closed */ }
    throw e;
  }
}

export function runAsService(db, sql, params = []) {
  return serial(db, () => runAsServiceNow(db, sql, params));
}

async function runAsServiceNow(db, sql, params = []) {
  await db.exec('begin');
  try {
    await db.exec('set local role service_role');
    const r = await db.query(sql, params);
    await db.exec('commit');
    return { rows: r.rows };
  } catch (e) {
    try { await db.exec('rollback'); } catch (_) { /* already closed */ }
    return { error: String(e.message || e) };
  }
}

export const ARRANGEMENTS_SQL = `select a.id, a.family_label, a.order_type, a.status, a.created_at,
  coalesce(json_agg(json_build_object('id', l.id, 'item', l.item_id::text, 'variant', l.variant_id::text,
    'title', l.title_at_save, 'retail', l.retail_cents, 'step', l.step_key) order by l.position)
    filter (where l.id is not null), '[]') as lines
from arrangements a left join arrangement_lines l on l.arrangement_id = a.id
group by a.id order by a.created_at desc`;

export const COSTS_SQL = 'select line_id, cost_cents, public_price_cents from arrangement_line_costs';

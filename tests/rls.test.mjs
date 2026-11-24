// Row level security, run on PGlite (Postgres 17 in WebAssembly, the engine the page uses).
// tests/pg_local.sh runs the same file against a local PostgreSQL through PG_TEST_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { catalog, freshDb, sqlFiles } from './helpers.mjs';
import { runAs, runAsService, transactionAs, ARRANGEMENTS_SQL } from '../site/db.js';
import { crossTenantChecks, OWNER_COUNT } from '../site/checks.js';
import { pgAdapter } from './pg_adapter.mjs';

const [A, B] = catalog.homes;
const dir = (h) => h.users.find((u) => u.label === 'Director');
const arr = (h) => h.users.find((u) => u.label === 'Arranger');

const engines = [['PGlite', freshDb]];
if (process.env.PG_TEST_URL) engines.push(['local PostgreSQL', () => pgAdapter(process.env.PG_TEST_URL, sqlFiles)]);

for (const [name, open] of engines) {
  test(`${name}: every cross-tenant check, both directions`, async () => {
    const db = await open();
    try {
      for (const [x, y] of [[A, B], [B, A]]) {
        const owner = await runAsService(db, OWNER_COUNT, [y.id]);
        assert.ok(owner.rows[0].n >= 1, `${y.short} must hold arrangements for the check to mean anything`);
        for (const c of crossTenantChecks(x, y)) {
          const r = await runAs(db, c.user, c.sql, c.params);
          assert.ok(c.pass(r), `${x.short} -> ${y.short}: ${c.id}: ${JSON.stringify(r)}`);
        }
      }
    } finally { await db.close?.(); }
  });

  test(`${name}: the arrangement list query has no home filter and still returns one home`, async () => {
    const db = await open();
    try {
      const ra = await runAs(db, dir(A), ARRANGEMENTS_SQL);
      const rb = await runAs(db, dir(B), ARRANGEMENTS_SQL);
      assert.deepEqual(ra.rows.map((r) => r.family_label), ['Sample: Lindqvist family']);
      assert.deepEqual(rb.rows.map((r) => r.family_label), ['Sample: Haddad family']);
      const none = await runAs(db, { id: '00000000-0000-4000-8000-000000000000' }, ARRANGEMENTS_SQL);
      assert.equal(none.rows.length, 0, 'a signed-in person with no membership sees nothing');
    } finally { await db.close?.(); }
  });

  test(`${name}: an arranger saves an arrangement; the database prices it and hides its cost from them`, async () => {
    const db = await open();
    try {
      const cambridge = Object.values(catalog.items).find((i) => i.handle.includes('cambridge-solid-mahogany'));
      const id = await transactionAs(db, arr(A), async (q) => {
        const a = await q('insert into arrangements (org_id, family_label) values ($1, $2) returning id', [A.id, 'Sample: test family']);
        // retail_cents sent as 1 cent: the trigger must replace it with the home's price
        const l = await q('insert into arrangement_lines (arrangement_id, org_id, step_key, item_id, variant_id, title_at_save, retail_cents) values ($1, $2, $3, $4, $5, $6, 1) returning retail_cents',
          [a.rows[0].id, A.id, 'casket', cambridge.id, 50196452901057, cambridge.title]);
        assert.equal(l.rows[0].retail_cents, 350995);
        return a.rows[0].id;
      });
      const costsArr = await runAs(db, arr(A), 'select count(*)::int as n from arrangement_line_costs');
      assert.equal(costsArr.rows[0].n, 0);
      const costsDir = await runAs(db, dir(A), 'select c.cost_cents, c.public_price_cents from arrangement_line_costs c join arrangement_lines l on l.id = c.line_id where l.arrangement_id = $1', [id]);
      assert.deepEqual(costsDir.rows, [{ cost_cents: 159499, public_price_cents: 289999 }]);
      const other = await runAs(db, dir(B), 'select count(*)::int as n from arrangements where id = $1', [id]);
      assert.equal(other.rows[0].n, 0);
    } finally { await db.close?.(); }
  });

  test(`${name}: rules, rooms and catalog writes follow the per-person switches`, async () => {
    const db = await open();
    try {
      const ok = await runAs(db, dir(A), 'update pricing_rules set markup_value = 99 where org_id = $1 and position = 1 returning id', [A.id]);
      assert.equal(ok.rows.length, 1);
      const no = await runAs(db, arr(A), 'update pricing_rules set markup_value = 99 where org_id = $1 returning id', [A.id]);
      assert.equal(no.rows.length, 0);
      const roomNo = await runAs(db, arr(A), "insert into selection_rooms (org_id, name) values ($1, 'x') returning id", [A.id]);
      assert.match(roomNo.error, /row-level security/);
      const cat = await runAs(db, dir(A), "update catalog_variants set public_price_cents = 1 returning id");
      assert.match(cat.error || '', /permission denied/);
      const invite = await runAs(db, arr(A), "insert into memberships (org_id, user_id, role) values ($1, gen_random_uuid(), 'owner')", [A.id]);
      assert.match(invite.error, /row-level security/);
      const crossInvite = await runAs(db, dir(A), "insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [B.id, dir(A).id]);
      assert.match(crossInvite.error, /row-level security/, 'a director cannot add themselves to another home');
    } finally { await db.close?.(); }
  });

  test(`${name}: a product removed from the catalog leaves the saved arrangement intact`, async () => {
    const db = await open();
    try {
      const before = await runAs(db, dir(A), ARRANGEMENTS_SQL);
      const line = (typeof before.rows[0].lines === 'string' ? JSON.parse(before.rows[0].lines) : before.rows[0].lines)[0];
      const del = await runAsService(db, 'delete from catalog_items where id = $1 returning id', [Number(line.item)]);
      assert.equal(del.rows.length, 1);
      const after = await runAs(db, dir(A), ARRANGEMENTS_SQL);
      const l2 = (typeof after.rows[0].lines === 'string' ? JSON.parse(after.rows[0].lines) : after.rows[0].lines)[0];
      assert.equal(l2.title, line.title);
      assert.equal(l2.retail, line.retail);
    } finally { await db.close?.(); }
  });
}

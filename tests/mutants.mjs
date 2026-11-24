// Deliberate breaks of the migration. Each one must make a check fail; if a mutant survives,
// the tests are not testing what they claim. Run: node tests/mutants.mjs
import { PGlite } from '@electric-sql/pglite';
import { catalog, sqlFiles } from './helpers.mjs';
import { openDb, runAs } from '../site/db.js';
import { crossTenantChecks } from '../site/checks.js';
import { priceFor } from '../site/pricing.js';

const MUTANTS = [
  ['read policy open to everyone', 'for select to authenticated using (app.is_member(org_id));\ncreate policy "members save arrangements"', 'for select to authenticated using (true);\ncreate policy "members save arrangements"'],
  ['insert check dropped', 'for insert to authenticated with check (app.is_member(org_id));\ncreate policy "members update', 'for insert to authenticated with check (true);\ncreate policy "members update'],
  ['membership ignores the user', 'where m.org_id = o and m.user_id = auth.uid())\n$$;', 'where m.org_id = o)\n$$;'],
  ['arranger may edit rules', "when 'edit_pricing' then m.can_edit_pricing", "when 'edit_pricing' then true"],
  ['costs readable by every member', 'for select to authenticated using (app.can(org_id, \'see_cost\'));', 'for select to authenticated using (app.is_member(org_id));'],
  ['floor ignored', 'select greatest(y, floor_cents) from r', 'select y from r'],
  ['.95 rounding off by one cent', 'x + ((95 - x % 100) + 100) % 100', 'x + ((94 - x % 100) + 100) % 100'],
  ['rule order reversed', 'order by r.position\n    limit 1', 'order by r.position desc\n    limit 1'],
];

async function caught(migration) {
  const db = await openDb(PGlite, { ...sqlFiles, migration });
  const [A, B] = catalog.homes;
  for (const [x, y] of [[A, B], [B, A]]) {
    for (const c of crossTenantChecks(x, y)) if (!c.pass(await runAs(db, c.user, c.sql, c.params))) return `check ${c.id}`;
  }
  for (const h of catalog.homes) for (const it of Object.values(catalog.items)) for (const v of it.variants) {
    const r = await db.query('select retail_cents::int as p from app.price_for($1, $2)', [h.id, v.id]);
    if (r.rows[0].p !== priceFor(h, it, v).retail) return `price of ${it.title}`;
  }
  return null;
}

let survived = 0;
for (const [name, from, to] of MUTANTS) {
  if (!sqlFiles.migration.includes(from)) { console.log(`MISSING  ${name}`); survived++; continue; }
  const by = await caught(sqlFiles.migration.replace(from, () => to));
  console.log(`${by ? 'caught  ' : 'SURVIVED'} ${name}${by ? ` (by ${by})` : ''}`);
  if (!by) survived++;
}
console.log(`${MUTANTS.length - survived} of ${MUTANTS.length} mutants caught`);
process.exit(survived ? 1 : 0);

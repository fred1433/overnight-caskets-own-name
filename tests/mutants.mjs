// Deliberate breaks of the migration and of site/pricing.js. Each one must make a check fail; if a
// mutant survives, the tests are not testing what they claim. Run: node tests/mutants.mjs
// (CATALOG=full node tests/mutants.mjs for the full catalog read, kept out of the repository)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { catalog, sqlFiles, ROOT } from './helpers.mjs';
import { openDb, runAs } from '../site/db.js';
import { crossTenantChecks } from '../site/checks.js';
import * as realPricing from '../site/pricing.js';
import { orderTypeProbe, everyRoomProductOrderable, orderingProbe, variantOwnerProbe, crossHomeErrorProbe, arrangerCostProbe,
  ruleBoundsProbe, orderedFrozenProbe } from './probes.mjs';

const SQL_MUTANTS = [
  ['read policy open to everyone', 'for select to authenticated using (app.is_member(org_id));\ncreate policy "members save arrangements"', 'for select to authenticated using (true);\ncreate policy "members save arrangements"'],
  ['insert check dropped', 'for insert to authenticated with check (app.is_member(org_id));\ncreate policy "members update', 'for insert to authenticated with check (true);\ncreate policy "members update'],
  ['membership ignores the user', 'where m.org_id = o and m.user_id = auth.uid())\n$$;', 'where m.org_id = o)\n$$;'],
  ['arranger may edit rules', "when 'edit_pricing' then m.can_edit_pricing", "when 'edit_pricing' then true"],
  ['costs readable by every member', 'for select to authenticated using (app.can(org_id, \'see_cost\'));', 'for select to authenticated using (app.is_member(org_id));'],
  ['floor ignored', 'select greatest(y, floor_cents) from r', 'select y from r'],
  ['.95 rounding off by one cent', 'x + ((95 - x % 100) + 100) % 100', 'x + ((94 - x % 100) + 100) % 100'],
  ['rule order reversed', 'order by r.position\n    limit 1', 'order by r.position desc\n    limit 1'],
  // G1
  ['G1: price_for granted to authenticated', 'grant execute on function app.price_for(uuid, bigint) to service_role;', 'grant execute on function app.price_for(uuid, bigint) to authenticated, service_role;'],
  ['G1: default execute for PUBLIC kept', 'revoke execute on all functions in schema app from public;\n', ''],
  // G2
  ['G2: order type of a line not checked', 'if a_type is distinct from v.order_type then', 'if false then'],
  ['G2: order type change leaves the line on its old variant', 'and s.item_id = cur.item_id and s.order_type = new.order_type;', 'and s.item_id = cur.item_id and s.order_type = old.order_type;'],
  // G4
  ['G4: ordering not guarded', "if auth.uid() is not null and not app.can(new.org_id, 'order') and (", "if false and ("],
  ['G4: guard reads the wrong switch', "not app.can(new.org_id, 'order')", "not app.can(new.org_id, 'see_cost')"],
  // G5
  ['G5: variant of another product accepted', 'if v.item_id <> new.item_id then', 'if false then'],
  // I2
  ['I2: price_line reads the arrangement without the home filter', 'where ar.id = new.arrangement_id and ar.org_id = new.org_id and app.is_member(new.org_id);', 'where ar.id = new.arrangement_id;'],
  ['I2: price_line skips the membership check', 'and ar.org_id = new.org_id and app.is_member(new.org_id);', 'and ar.org_id = new.org_id;'],
  ['I2: a client chooses the id of a new arrangement', 'grant insert (org_id, family_label, order_type, status) on public.arrangements to authenticated;', 'grant insert on public.arrangements to authenticated;'],
  ['I2: a client chooses the id of a new line', 'grant insert (arrangement_id, org_id, step_key, item_id, variant_id, title_at_save, retail_cents, position) on public.arrangement_lines to authenticated;', 'grant insert on public.arrangement_lines to authenticated;'],
  // I3
  ['I3: every member reads the rules', "for select to authenticated using (app.can(org_id, 'see_cost') or app.can(org_id, 'edit_pricing'));", 'for select to authenticated using (app.is_member(org_id));'],
  ['I3: the cost basis column readable', 'grant select (id, name, brand, created_at) on public.organizations to authenticated;', 'grant select on public.organizations to authenticated;'],
  ['I3: the cost function callable', 'grant execute on function app.cost_cents(bigint, numeric), app.apply_rule(bigint, text, numeric, text, bigint) to service_role;', 'grant execute on function app.cost_cents(bigint, numeric), app.apply_rule(bigint, text, numeric, text, bigint) to authenticated, service_role;'],
  ['I3: app.basis_pct answers everyone', "if not (app.can(o, 'see_cost') or app.can(o, 'edit_pricing')) then", 'if false then'],
  // I4
  ['I4: an ordered arrangement can be renamed or retyped', "if auth.uid() is not null and old.status = 'ordered' then", 'if false then'],
  ['I4: a line can be added to an ordered arrangement', "if a_status = 'ordered' then", 'if false then'],
  ['I4: the line keeps the title the client typed', 'new.title_at_save := (select ci.title from public.catalog_items ci where ci.id = new.item_id);', 'null;'],
  // I5
  ['I5: markup unbounded', "and markup_value <= case markup_kind when 'percent' then 1000 else 100000 end", ''],
  ['I5: decimal markups accepted', 'markup_value >= 0 and markup_value = trunc(markup_value)', 'markup_value >= 0'],
  ['I5: floor unbounded', 'floor_cents >= 0 and floor_cents <= 10000000 and floor_cents % 100 = 0', 'floor_cents >= 0'],
  ['I5: decimal cost basis accepted', 'and wholesale_basis_pct = trunc(wholesale_basis_pct)', ''],
];

const JS_MUTANTS = [
  ['G2: page saves every arrangement as Buy Now', "order_type: typed ? typed.variant.order_type : null,", "order_type: 'Buy Now',"],
  ['G2: page shows an unavailable Buy Now variant', "return typed.find((v) => v.order_type === 'Buy Now' && v.available) || typed.find((v) => v.available) || typed[0];", "return typed.find((v) => v.order_type === 'Buy Now') || typed[0];"],
  ['C2: margin percentage in floating point', "return `${neg ? '-' : ''}${Math.floor(tenths / 10)}.${tenths % 10}`;", 'return (margin / retail * 100).toFixed(1);'],
];

async function dbCaught(db, pr) {
  const [A, B] = catalog.homes;
  for (const [x, y] of [[A, B], [B, A]]) {
    for (const c of crossTenantChecks(x, y)) if (!c.pass(await runAs(db, c.user, c.sql, c.params))) return `check ${c.id}`;
  }
  for (const h of catalog.homes) for (const it of Object.values(catalog.items)) for (const v of it.variants) {
    const r = await db.query('select retail_cents::int as p from app.price_for($1, $2)', [h.id, v.id]);
    if (r.rows[0].p !== pr.priceFor(h, it, v).retail) return `price of ${it.title}`;
  }
  for (const [name, probe] of [['order type', orderTypeProbe], ['ordering', orderingProbe], ['variant owner', variantOwnerProbe],
    ['I2 cross-home errors', crossHomeErrorProbe], ['I3 arranger and cost', arrangerCostProbe], ['I5 rule bounds', ruleBoundsProbe]]) {
    const why = await probe(db, catalog);
    if (why) return `${name} probe: ${why}`;
  }
  const why = await everyRoomProductOrderable(db, catalog, pr);
  if (why) return `every room product probe: ${why}`;
  const frozen = await orderedFrozenProbe(db, catalog); // last: it leaves an ordered arrangement behind
  if (frozen) return `I4 ordered frozen probe: ${frozen}`;
  return null;
}

function jsCaught(pr) {
  const cases = [[255000, 400000, '63.8'], [191496, 350995, '54.6'], [2, 3, '66.7']];
  for (const [m, r, want] of cases) if (pr.marginPct(m, r) !== want) return `margin ${m}/${r} = ${pr.marginPct(m, r)}`;
  return null;
}

let survived = 0;
let total = 0;
const report = (name, by) => {
  total++;
  console.log(`${by ? 'caught  ' : 'SURVIVED'} ${name}${by ? ` (by ${by.slice(0, 140)})` : ''}`);
  if (!by) survived++;
};

for (const [name, from, to] of SQL_MUTANTS) {
  if (!sqlFiles.migration.includes(from)) { console.log(`MISSING  ${name}`); survived++; total++; continue; }
  const db = await openDb(PGlite, { ...sqlFiles, migration: sqlFiles.migration.replace(from, () => to) });
  report(name, await dbCaught(db, realPricing));
  await db.close();
}

const pricingSrc = readFileSync(join(ROOT, 'site/pricing.js'), 'utf8');
for (const [name, from, to] of JS_MUTANTS) {
  if (!pricingSrc.includes(from)) { console.log(`MISSING  ${name}`); survived++; total++; continue; }
  const src = pricingSrc.replace(from, () => to);
  const pr = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
  let by = jsCaught(pr);
  if (!by) {
    const db = await openDb(PGlite, sqlFiles);
    by = await dbCaught(db, pr);
    await db.close();
  }
  report(name, by);
}
console.log(`${total - survived} of ${total} mutants caught`);
process.exit(survived ? 1 : 0);

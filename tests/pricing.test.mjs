// Prices to the cent: the page (site/pricing.js) and the database (app.price_for) agree on
// every casket and head panel variant for both sample homes, and each rule stays in its collection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { catalog, freshDb } from './helpers.mjs';
import { priceFor, applyRule, costCents, ruleFor } from '../site/pricing.js';

const [A, B] = catalog.homes;
const items = Object.values(catalog.items);
const byHandle = (s) => items.find((i) => i.handle.includes(s));

test('page and database give the same cost and retail for every variant, both homes', async () => {
  const db = await freshDb();
  let n = 0;
  for (const h of [A, B]) {
    for (const it of items) {
      for (const v of it.variants) {
        const js = priceFor(h, it, v);
        const r = await db.query('select cost_cents::int as cost, retail_cents::int as retail from app.price_for($1, $2)', [h.id, v.id]);
        assert.deepEqual({ cost: r.rows[0].cost, retail: r.rows[0].retail }, { cost: js.cost, retail: js.retail }, `${h.short} ${it.title} ${v.title}`);
        n++;
      }
    }
  }
  assert.ok(n > 400, `${n} prices compared`);
});

test('hand-checked prices', () => {
  const cambridge = byHandle('cambridge-solid-mahogany');
  // 2,899.99 x 55% = 1,594.99; + 120% = 3,508.98; up to .95 = 3,509.95; floor 2,495.00 not reached
  assert.equal(priceFor(A, cambridge, cambridge.variants[0]).retail, 350995);
  // Calder Ruiz: 2,899.99 x 60% = 1,739.99; + 110% = 3,653.98; up to .95 = 3,654.95
  assert.equal(priceFor(B, cambridge, cambridge.variants[0]).retail, 365495);
  const kenwood = byHandle('kenwood-poplar');
  // 999.99 x 55% = 549.99; + 95% = 1,072.48; up to the dollar 1,073.00; floor 1,495.00 applies
  assert.equal(priceFor(A, kenwood, kenwood.variants[0]).retail, 149500);
  const panel = items.find((i) => i.title === "In God's Care Head Panel - Blue");
  // 150.00 x 55% = 82.50; + $120 = 202.50; up to the dollar = 203.00
  assert.equal(priceFor(A, panel, panel.variants[0]).retail, 20300);
});

test('a rule applies to its collection and not to the others', () => {
  const benjamin = byHandle('benjamin-oak');           // in Jewish Caskets and in Solid Wood Caskets
  const montclair = byHandle('montclair-solid-oak');   // Solid Wood Caskets only
  const army = byHandle('veterans-army');              // Veterans
  assert.equal(ruleFor(A, benjamin).label, 'Jewish caskets', 'first matching rule wins');
  assert.equal(ruleFor(A, montclair).label, 'Solid wood');
  assert.equal(ruleFor(A, army).label, 'Veterans');
  const before = [benjamin, montclair, army].map((i) => priceFor(A, i, i.variants[0]).retail);
  const changed = { ...A, rules: A.rules.map((r) => (r.label === 'Solid wood' ? { ...r, value: 300 } : r)) };
  const after = [benjamin, montclair, army].map((i) => priceFor(changed, i, i.variants[0]).retail);
  assert.equal(after[0], before[0]);
  assert.notEqual(after[1], before[1]);
  assert.equal(after[2], before[2]);
  const panel = items.find((i) => i.type === 'lid_panel');
  assert.equal(ruleFor(A, panel).label, 'Head panels', 'casket rules never price a panel');
});

test('rounding and floor fall on the cent', () => {
  const r = (kind, value, rounding, floor) => ({ kind, value, rounding, floor });
  assert.equal(applyRule(100000, r('percent', 0, 'ninety_five', 0)), 100095);
  assert.equal(applyRule(100095, r('percent', 0, 'ninety_five', 0)), 100095);
  assert.equal(applyRule(100096, r('percent', 0, 'ninety_five', 0)), 100195);
  assert.equal(applyRule(100001, r('percent', 0, 'whole', 0)), 100100);
  assert.equal(applyRule(100000, r('percent', 0, 'whole', 0)), 100000);
  assert.equal(applyRule(12345, r('percent', 10, 'cent', 0)), 13580);  // 135.795 -> 135.80
  assert.equal(applyRule(10000, r('amount', 12.5, 'cent', 0)), 11250);
  assert.equal(applyRule(10000, r('percent', 50, 'whole', 199.99)), 19999);
  assert.equal(applyRule(10000, r('percent', 33.33, 'cent', 0)), 13333);
  assert.equal(costCents(289999, 55), 159499);
  assert.equal(costCents(15000, 55), 8250);
});

test('the same rule computed by the database at its edges', async () => {
  const db = await freshDb();
  const cases = [[100000, 'percent', 0, 'ninety_five', 0], [100096, 'percent', 0, 'ninety_five', 0], [100001, 'percent', 0, 'whole', 0],
    [12345, 'percent', 10, 'cent', 0], [10000, 'amount', 12.5, 'cent', 0], [10000, 'percent', 50, 'whole', 19999], [10000, 'percent', 33.33, 'cent', 0]];
  for (const [c, k, v, ro, f] of cases) {
    const r = await db.query('select app.apply_rule($1, $2, $3, $4, $5)::int as p', [c, k, v, ro, f]);
    assert.equal(r.rows[0].p, applyRule(c, { kind: k, value: v, rounding: ro, floor: f / 100 }), JSON.stringify([c, k, v, ro, f]));
  }
});

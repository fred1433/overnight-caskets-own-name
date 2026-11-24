// The catalog read, the rooms built from it, display names and the supplier cart link.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { catalog, ROOT, RAW, FULL, MIGRATION_PATH } from './helpers.mjs';
import { cartLink, variantForLine, shownVariant, savePlan, orderTypesFor, lineStatus } from '../site/pricing.js';

const items = catalog.items;
const all = Object.values(items);
const variantIds = new Set(all.flatMap((i) => i.variants.map((v) => v.id)));
const raw = readdirSync(RAW).filter((f) => /^products_p\d+\.json$/.test(f)).flatMap((f) => JSON.parse(readFileSync(join(RAW, f), 'utf8')).products);
const rawVariants = new Map(raw.flatMap((p) => p.variants.map((v) => [v.id, v])));
const READ = catalog.read_started;

test('counts of the catalog read', () => {
  const expected = FULL
    ? { products: 369, variants: 515, casket: 130, lid_panel: 37, urn: 193, pet_casket: 9 }
    : { products: 14, variants: 22, casket: 12, lid_panel: 2 };
  assert.deepEqual(catalog.counts, expected);
});

test('rooms hold only available adult caskets of the collection they are named after', () => {
  const members = (h) => JSON.parse(readFileSync(join(RAW, 'collections', h + '.json'), 'utf8')).products.map((p) => p.id);
  for (const home of catalog.homes) {
    for (const r of home.rooms) {
      assert.ok(r.items.length >= (FULL ? 5 : 1), r.name);
      for (const id of r.items) {
        const it = items[String(id)];
        assert.equal(it.type, 'casket', `${r.name}: ${it.title}`);
        assert.ok(!/urn|pet|panel/i.test(it.title), it.title);
        assert.ok(it.variants.some((v) => v.available), `${it.title} is unavailable`);
        assert.ok(members(r.collection).includes(id), `${it.title} not in ${r.collection}`);
      }
      assert.ok(!/\$|under|over|big|economical|popular|best/i.test(r.name), `room named by price or ranking: ${r.name}`);
    }
  }
});

test('prices come from price, never from compare_at_price', () => {
  for (const it of all) for (const v of it.variants) {
    const rv = rawVariants.get(v.id);
    assert.equal(v.price, Math.round(Number(rv.price) * 100), it.title);
  }
  assert.ok(!JSON.stringify(catalog).includes('compare_at'));
});

test('C3: names shown to the family carry no stray apostrophe, across the catalog', () => {
  const stray = /[A-Za-z]['’](?![A-Za-z])/;
  for (const it of all) {
    assert.ok(!stray.test(it.name) && !stray.test(it.sub || ''), `${it.title} -> ${it.name}`);
  }
  const byTitle = (t) => all.find((i) => i.title.startsWith(t));
  assert.equal(byTitle("White Cross' Lords Prayer").name, 'White Cross Lords Prayer Casket');
  assert.equal(byTitle("Last Supper' Antique White").name, 'Last Supper Antique White Casket');
  assert.equal(byTitle("In God's Care Spruce Blue").name, "In God's Care Spruce Blue Casket", 'a real apostrophe stays');
  assert.equal(byTitle("Corner Rose Mother' Head Panel").name, 'Corner Rose Mother Head Panel - Ivory');
});

test('C11: wood or steel, in the product page words, for the comparison', () => {
  const byHandle = (s) => all.find((i) => i.handle.includes(s));
  assert.equal(byHandle('cambridge-solid-mahogany').attributes.material, 'Solid hardwood');
  assert.equal(byHandle('sterling-copper').attributes.material, 'Steel');
});

test('typed variants of one product share one price (switching the order type keeps the frozen price)', () => {
  for (const it of all) {
    const typed = it.variants.filter((v) => v.order_type);
    if (typed.length) assert.equal(new Set(typed.map((v) => v.price)).size, 1, it.title);
  }
});

const cambridge = all.find((i) => i.handle.includes('cambridge-solid-mahogany'));
const panel = all.find((i) => i.title === "In God's Care Head Panel - Blue");
const jackson = all.find((i) => i.handle.includes('jackson-cherry-veneer'));
const hannah = all.find((i) => i.handle.includes('hannah-poplar'));

test('Pre-Need orders the Pre-Need variant, Buy Now the Buy Now variant', () => {
  const line = { item: cambridge.id, variant: 50196452868289 };
  assert.equal(variantForLine(cambridge, line, 'Pre-Need').id, 50196452901057);
  assert.equal(variantForLine(cambridge, line, 'Buy Now').id, 50196452868289);
  const pre = cartLink([line], items, 'Pre-Need', READ);
  assert.equal(pre.url, 'https://overnightcaskets.com/cart/50196452901057:1');
  assert.ok(!pre.url.includes('50196452868289'));
});

test('G2: a product offered only as Pre-Need is shown, saved and ordered as Pre-Need', () => {
  const v = shownVariant(jackson);
  assert.equal(v.order_type, 'Pre-Need');
  const plan = savePlan([{ step: 'casket', item: jackson, variant: v }]);
  assert.equal(plan.order_type, 'Pre-Need');
  assert.equal(plan.lines[0].variant, 50035105333441);
  assert.deepEqual(orderTypesFor(plan.lines, items), ['Pre-Need'], 'no Buy Now / Pre-Need choice when one side cannot be ordered');
  assert.equal(lineStatus(jackson, plan.lines[0], plan.order_type, READ), '');
  assert.equal(cartLink(plan.lines, items, plan.order_type, READ).url, 'https://overnightcaskets.com/cart/50035105333441:1');
  assert.deepEqual(orderTypesFor([{ item: cambridge.id }], items), ['Buy Now', 'Pre-Need']);
  assert.deepEqual(orderTypesFor([{ item: hannah.id }], items), [], 'no choice on a product without Buy Now / Pre-Need');
  const noHandles = hannah.variants.find((x) => x.title === 'No Handles');
  const h2 = savePlan([{ step: 'casket', item: hannah, variant: shownVariant(hannah, noHandles.id) }]);
  assert.equal(h2.order_type, null);
  assert.equal(h2.lines[0].variant, noHandles.id);
});

test('cart link: two lines, only real variant ids, unavailable and absent products left out', () => {
  const two = cartLink([{ item: cambridge.id, variant: 50196452868289 }, { item: panel.id, variant: panel.variants[0].id }], items, 'Buy Now', READ);
  assert.equal(two.url, `https://overnightcaskets.com/cart/50196452868289:1,${panel.variants[0].id}:1`);
  for (const l of two.lines) assert.ok(variantIds.has(l.variant));
  const maroset = all.find((i) => i.title.startsWith('Maroset Jewish Poplar'));
  const gone = cartLink([{ item: maroset.id, variant: maroset.variants[0].id, title: maroset.title }], items, 'Buy Now', READ);
  assert.equal(gone.url, null);
  assert.equal(gone.leftOut[0].reason, 'Not available in the catalog read on 24 Nov 2026');
  const removed = cartLink([{ item: 1, variant: 2, title: 'A product the catalog read does not hold' }, { item: cambridge.id, variant: 50196452868289 }], items, 'Buy Now', READ);
  assert.equal(removed.leftOut[0].reason, 'Not in the catalog read on 24 Nov 2026');
  assert.equal(removed.url, 'https://overnightcaskets.com/cart/50196452868289:1');
  const forged = cartLink([{ item: cambridge.id, variant: 123 }], items, 'Buy Now', READ);
  assert.ok(!forged.url.includes(':123'), 'a typed product always orders a catalog variant');
});

test('C1: the page never says a product is "no longer" available: there is one catalog read', () => {
  for (const f of ['site/app.js', 'site/pricing.js', 'site/index.html']) {
    assert.ok(!/no longer/i.test(readFileSync(join(ROOT, f), 'utf8')), f);
  }
});

test('the SQL shown on the page is an excerpt of the migration, line for line', () => {
  const html = readFileSync(join(ROOT, 'site/index.html'), 'utf8');
  const mig = readFileSync(join(ROOT, MIGRATION_PATH), 'utf8');
  const pre = html.match(/<pre>([\s\S]*?)<\/pre>/)[1];
  const lines = pre.split('\n').filter((l) => l.trim());
  for (const line of lines) assert.ok(mig.includes(line), line);
  for (const t of ['arrangements', 'pricing_rules', 'arrangement_line_costs']) {
    assert.ok(lines.includes(`alter table public.${t} enable row level security;`), `${t}: row level security enabled`);
  }
  assert.ok(pre.includes('create policy "members read rules" on public.pricing_rules'), 'the read policy of pricing_rules is shown');
  assert.ok(html.includes(`blob/main/${MIGRATION_PATH}`), 'links to the migration file');
});

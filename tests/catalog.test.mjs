// The snapshot, the rooms built from it, and the supplier cart link.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { catalog, ROOT } from './helpers.mjs';
import { cartLink, variantForLine } from '../site/pricing.js';

const items = catalog.items;
const all = Object.values(items);
const variantIds = new Set(all.flatMap((i) => i.variants.map((v) => v.id)));
const raw = ['products_p1.json', 'products_p2.json'].flatMap((f) => JSON.parse(readFileSync(join(ROOT, 'data/raw', f), 'utf8')).products);
const rawVariants = new Map(raw.flatMap((p) => p.variants.map((v) => [v.id, v])));

test('snapshot counts', () => {
  assert.deepEqual(catalog.counts, { products: 369, variants: 515, casket: 130, lid_panel: 37, urn: 193, pet_casket: 9 });
});

test('rooms hold only available adult caskets of the collection they are named after', () => {
  const members = (h) => JSON.parse(readFileSync(join(ROOT, 'data/raw/collections', h + '.json'), 'utf8')).products.map((p) => p.id);
  for (const home of catalog.homes) {
    for (const r of home.rooms) {
      assert.ok(r.items.length >= 5, r.name);
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

const cambridge = all.find((i) => i.handle.includes('cambridge-solid-mahogany'));
const panel = all.find((i) => i.title === "In God's Care Head Panel - Blue");

test('Pre-Need orders the Pre-Need variant, Buy Now the Buy Now variant', () => {
  const line = { item: cambridge.id, variant: 50196452868289 };
  assert.equal(variantForLine(cambridge, line, 'Pre-Need').id, 50196452901057);
  assert.equal(variantForLine(cambridge, line, 'Buy Now').id, 50196452868289);
  const pre = cartLink([line], items, 'Pre-Need');
  assert.equal(pre.url, 'https://overnightcaskets.com/cart/50196452901057:1');
  assert.ok(!pre.url.includes('50196452868289'));
});

test('cart link: two lines, only real variant ids, unavailable and removed products left out', () => {
  const two = cartLink([{ item: cambridge.id, variant: 50196452868289 }, { item: panel.id, variant: panel.variants[0].id }], items, 'Buy Now');
  assert.equal(two.url, `https://overnightcaskets.com/cart/50196452868289:1,${panel.variants[0].id}:1`);
  for (const l of two.lines) assert.ok(variantIds.has(l.variant));
  const maroset = all.find((i) => i.title.startsWith('Maroset Jewish Poplar'));
  const gone = cartLink([{ item: maroset.id, variant: maroset.variants[0].id, title: maroset.title }], items, 'Buy Now');
  assert.equal(gone.url, null);
  assert.equal(gone.leftOut[0].reason, 'Not available in the catalog read');
  const removed = cartLink([{ item: 1, variant: 2, title: 'A product the sync deleted' }, { item: cambridge.id, variant: 50196452868289 }], items, 'Buy Now');
  assert.equal(removed.leftOut[0].reason, 'No longer in the current catalog');
  assert.equal(removed.url, 'https://overnightcaskets.com/cart/50196452868289:1');
  const forged = cartLink([{ item: cambridge.id, variant: 123 }], items, 'Buy Now');
  assert.ok(!forged.url.includes(':123'), 'a typed product always orders a catalog variant');
});

test('the policy shown on the page is the one in the migration', () => {
  const html = readFileSync(join(ROOT, 'site/index.html'), 'utf8');
  const mig = readFileSync(join(ROOT, 'supabase/migrations/20261124120000_selection_room.sql'), 'utf8');
  const pre = html.match(/<pre>([\s\S]*?)<\/pre>/)[1];
  for (const line of pre.split('\n').filter((l) => l.trim())) assert.ok(mig.includes(line), line);
});

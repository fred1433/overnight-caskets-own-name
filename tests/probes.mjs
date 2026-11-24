// What the database and the page must hold beyond the cross-tenant checks. Each probe returns null
// when it holds, or what went wrong. Shared by tests/rls.test.mjs and tests/mutants.mjs.
import { runAs, runAsService, transactionAs, ARRANGEMENTS_SQL } from '../site/db.js';

const dir = (h) => h.users.find((u) => u.label === 'Director');
const arr = (h) => h.users.find((u) => u.label === 'Arranger');
const typedItem = (catalog) => Object.values(catalog.items).find((i) => i.type === 'casket'
  && ['Buy Now', 'Pre-Need'].every((t) => i.variants.some((v) => v.order_type === t && v.available)));
const panelItem = (catalog) => Object.values(catalog.items).find((i) => i.type === 'lid_panel' && i.variants.some((v) => v.available));

async function tryTx(db, user, fn) {
  try { return { value: await transactionAs(db, user, fn) }; } catch (e) { return { error: String(e.message || e) }; }
}

// G2 in the database: a Buy Now / Pre-Need variant is saved only under the same order type, and
// changing the order type moves the line to the product's variant of that type.
export async function orderTypeProbe(db, catalog) {
  const A = catalog.homes[0];
  const it = typedItem(catalog);
  const pre = it.variants.find((v) => v.order_type === 'Pre-Need');
  const buy = it.variants.find((v) => v.order_type === 'Buy Now');
  for (const type of [null, 'Buy Now']) {
    const r = await tryTx(db, dir(A), async (q) => {
      const a = await q('insert into arrangements (org_id, family_label, order_type) values ($1, $2, $3) returning id', [A.id, 'Sample: probe', type]);
      await q('insert into arrangement_lines (arrangement_id, org_id, step_key, item_id, variant_id, title_at_save, retail_cents) values ($1, $2, $3, $4, $5, $6, 0)',
        [a.rows[0].id, A.id, 'casket', it.id, pre.id, it.title]);
    });
    if (!r.error) return `a Pre-Need variant was saved under an arrangement typed ${type}`;
  }
  const saved = await tryTx(db, dir(A), async (q) => {
    const a = await q('insert into arrangements (org_id, family_label, order_type) values ($1, $2, $3) returning id', [A.id, 'Sample: probe', 'Buy Now']);
    await q('insert into arrangement_lines (arrangement_id, org_id, step_key, item_id, variant_id, title_at_save, retail_cents) values ($1, $2, $3, $4, $5, $6, 0)',
      [a.rows[0].id, A.id, 'casket', it.id, buy.id, it.title]);
    return a.rows[0].id;
  });
  if (saved.error) return `a Buy Now line under a Buy Now arrangement was refused: ${saved.error}`;
  const up = await runAs(db, dir(A), "update arrangements set order_type = 'Pre-Need' where id = $1 returning id", [saved.value], { commit: true });
  if (up.error || up.rows.length !== 1) return `the director could not switch to Pre-Need: ${up.error}`;
  const v = await runAs(db, dir(A), 'select variant_id::text as v from arrangement_lines where arrangement_id = $1', [saved.value]);
  if (v.rows[0].v !== String(pre.id)) return `after switching to Pre-Need the line still orders variant ${v.rows[0].v}`;
  return null;
}

// G2 across the catalog: every product of every room, saved the way the page saves it (the variant
// shown and its order type), comes back from the database orderable, with nothing marked unavailable.
export async function everyRoomProductOrderable(db, catalog, pr) {
  let n = 0;
  for (const h of catalog.homes) {
    for (const room of h.rooms) {
      for (const id of room.items) {
        const it = catalog.items[String(id)];
        const plan = pr.savePlan([{ step: 'casket', item: it, variant: pr.shownVariant(it) }]);
        const r = await tryTx(db, dir(h), async (q) => {
          const a = await q('insert into arrangements (org_id, family_label, order_type) values ($1, $2, $3) returning id', [h.id, 'Sample: probe', plan.order_type]);
          for (const l of plan.lines) {
            await q('insert into arrangement_lines (arrangement_id, org_id, step_key, item_id, variant_id, title_at_save, retail_cents, position) values ($1, $2, $3, $4, $5, $6, 0, $7)',
              [a.rows[0].id, h.id, l.step, l.item, l.variant, l.title, l.position]);
          }
          return a.rows[0].id;
        });
        if (r.error) return `${h.short}, ${room.name}, ${it.title}: saving was refused (${r.error})`;
        const back = await runAs(db, dir(h), `select * from (${ARRANGEMENTS_SQL}) x where id = $1`, [r.value]);
        const a = back.rows[0];
        const lines = typeof a.lines === 'string' ? JSON.parse(a.lines) : a.lines;
        const link = pr.cartLink(lines, catalog.items, a.order_type, catalog.read_started);
        if (link.leftOut.length) return `${h.short}, ${room.name}, ${it.title}: saved ${a.order_type}, then "${link.leftOut[0].reason}"`;
        if (!link.url || !link.url.includes(`${pr.shownVariant(it).id}:1`)) return `${h.short}, ${it.title}: the link does not order the variant shown (${link.url})`;
        n++;
      }
    }
  }
  return n ? null : 'no room product was tried';
}

// G4: ordering is held by the database, not only hidden on the page.
export async function orderingProbe(db, catalog) {
  const A = catalog.homes[0];
  const target = await runAs(db, dir(A), 'select id from arrangements limit 1');
  const id = target.rows[0].id;
  const tries = [
    ["update arrangements set status = 'ordered' where id = $1 returning id", [id]],
    ["update arrangements set order_type = 'Pre-Need' where id = $1 returning id", [id]],
    ["insert into arrangements (org_id, family_label, status) values ($1, 'Sample: probe', 'ordered') returning id", [A.id]],
  ];
  for (const [sql, params] of tries) {
    const r = await runAs(db, arr(A), sql, params);
    if (!r.error) return `the arranger could run: ${sql.split(' where')[0]} (${r.rows.length} rows)`;
  }
  // Someone who sees cost and edits prices, without the order switch, cannot order either.
  const bookkeeper = { id: '7d1e0c55-0000-4000-8000-c00000000001' };
  await runAsService(db, "insert into memberships (org_id, user_id, label, role, can_see_cost, can_edit_pricing, can_order) values ($1, $2, 'Bookkeeper', 'director', true, true, false) on conflict do nothing", [A.id, bookkeeper.id]);
  const bk = await runAs(db, bookkeeper, "update arrangements set status = 'ordered' where id = $1 returning id", [id]);
  if (!bk.error) return `a person without the order switch marked an arrangement ordered (${bk.rows.length} rows)`;
  const ok = await runAs(db, arr(A), "update arrangements set family_label = 'Sample: renamed' where id = $1 returning id", [id]);
  if (ok.error || ok.rows.length !== 1) return `the arranger could not rename an arrangement: ${ok.error}`;
  const dirOk = await runAs(db, dir(A), "update arrangements set status = 'ordered' where id = $1 returning id", [id]);
  if (dirOk.error || dirOk.rows.length !== 1) return `the director could not mark it ordered: ${dirOk.error}`;
  return null;
}

// G5: a line's variant belongs to the line's product.
export async function variantOwnerProbe(db, catalog) {
  const A = catalog.homes[0];
  const it = typedItem(catalog);
  const panel = panelItem(catalog);
  const r = await tryTx(db, dir(A), async (q) => {
    const a = await q('insert into arrangements (org_id, family_label) values ($1, $2) returning id', [A.id, 'Sample: probe']);
    await q('insert into arrangement_lines (arrangement_id, org_id, step_key, item_id, variant_id, title_at_save, retail_cents) values ($1, $2, $3, $4, $5, $6, 0)',
      [a.rows[0].id, A.id, 'casket', it.id, panel.variants[0].id, it.title]);
  });
  return r.error ? null : `a ${it.title} line was saved with the variant of ${panel.title}`;
}

export const DB_PROBES = { orderTypeProbe, orderingProbe, variantOwnerProbe };

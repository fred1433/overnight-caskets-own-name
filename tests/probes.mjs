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

const plainItem = (catalog) => Object.values(catalog.items).find((i) => i.type === 'casket' && i.variants.length === 1
  && !i.variants[0].order_type && i.variants[0].available);
const GHOST = '00000000-0000-4000-8000-00000000dead';
const answer = (r, ids) => {
  let s = r.error ? `error: ${r.error}` : `rows: ${(r.rows || []).length}`;
  for (const id of ids) s = s.split(String(id)).join('<id>');
  return s;
};

// I2: a write aimed at another home's arrangement (or line) fails exactly as one aimed at an id that
// does not exist, for every person of the home, both directions. The ids the caller sent are the only
// difference allowed between the two answers.
export async function crossHomeErrorProbe(db, catalog) {
  const it = typedItem(catalog);
  const plain = plainItem(catalog);
  const variants = [['Buy Now', it.id, it.variants.find((v) => v.order_type === 'Buy Now').id],
    ['Pre-Need', it.id, it.variants.find((v) => v.order_type === 'Pre-Need').id], ['plain', plain.id, plain.variants[0].id]];
  const [A, B] = catalog.homes;
  for (const [x, y] of [[A, B], [B, A]]) {
    const theirs = (await runAsService(db, 'select id from arrangements where org_id = $1 order by created_at', [y.id])).rows.map((r) => r.id);
    const theirLines = (await runAsService(db, 'select id from arrangement_lines where org_id = $1', [y.id])).rows.map((r) => r.id);
    const mine = (await runAsService(db, "select id from arrangements where org_id = $1 and status = 'saved' order by created_at limit 1", [x.id])).rows[0].id;
    const tries = [];
    for (const [kind, item, variant] of variants) {
      for (const org of [y.id, x.id]) {
        tries.push([`a ${kind} line filed under ${org === y.id ? `${y.short}'s` : 'its own'} home id`,
          "insert into arrangement_lines (arrangement_id, org_id, step_key, item_id, variant_id, title_at_save, retail_cents) values ($1, $2, 'casket', $3, $4, 'x', 0) returning id",
          (id) => [id, org, item, variant], theirs]);
      }
    }
    tries.push(['a rename', "update arrangements set family_label = 'x' where id = $1 returning id", (id) => [id], theirs]);
    tries.push(['ordering', "update arrangements set status = 'ordered' where id = $1 returning id", (id) => [id], theirs]);
    tries.push(['an arrangement reusing its id', "insert into arrangements (id, org_id, family_label) values ($1, $2, 'x') returning id", (id) => [id, x.id], theirs]);
    tries.push(['a line reusing a line id', "insert into arrangement_lines (id, arrangement_id, org_id, step_key, item_id, variant_id, title_at_save, retail_cents) values ($1, $2, $3, 'casket', $4, $5, 'x', 0) returning id",
      (id) => [id, mine, x.id, plain.id, plain.variants[0].id], theirLines]);
    for (const u of x.users) {
      for (const [what, sql, params, targets] of tries) {
        for (const target of targets) {
          const real = answer(await runAs(db, u, sql, params(target)), [target]);
          const fake = answer(await runAs(db, u, sql, params(GHOST)), [GHOST]);
          if (real !== fake) return `${x.short} ${u.label}, ${what}: ${y.short}'s id answers "${real.slice(0, 160)}", an unknown id answers "${fake.slice(0, 160)}"`;
        }
      }
    }
  }
  return null;
}

// I3: what the arranger preview says is held by the database: no pricing rule, no cost basis and no
// cost function for an arranger; the director still reads the rules and the basis of their own home.
export async function arrangerCostProbe(db, catalog) {
  const [A, B] = catalog.homes;
  for (const [h, other] of [[A, B], [B, A]]) {
    const u = arr(h);
    const rules = await runAs(db, u, 'select count(*)::int as n from pricing_rules');
    if (!rules.error && rules.rows[0].n !== 0) return `${h.short}'s arranger reads ${rules.rows[0].n} pricing rules`;
    const basis = await runAs(db, u, 'select wholesale_basis_pct from organizations');
    if (!basis.error && basis.rows.length) return `${h.short}'s arranger reads the cost basis (${basis.rows[0].wholesale_basis_pct})`;
    const viaFn = await runAs(db, u, 'select app.basis_pct($1) as b', [h.id]);
    if (!viaFn.error) return `${h.short}'s arranger reads the cost basis through app.basis_pct (${viaFn.rows[0].b})`;
    const cost = await runAs(db, u, 'select app.cost_cents(219999, 55) as c');
    if (!cost.error) return `${h.short}'s arranger computes a cost with app.cost_cents (${cost.rows[0].c})`;
    const name = await runAs(db, u, 'select name from organizations');
    if (name.error || name.rows.length !== 1) return `${h.short}'s arranger can no longer read the home's name (${name.error || name.rows.length})`;
    const d = dir(h);
    const dr = await runAs(db, d, 'select count(*)::int as n from pricing_rules');
    if (dr.error || dr.rows[0].n !== h.rules.length) return `${h.short}'s director reads ${dr.error || dr.rows[0].n} of ${h.rules.length} rules`;
    const db1 = await runAs(db, d, 'select app.basis_pct($1)::float8 as b', [h.id]);
    if (db1.error || db1.rows[0].b !== Number(h.wholesale_basis_pct)) return `${h.short}'s director does not read the cost basis (${db1.error || db1.rows[0].b})`;
    const cross = await runAs(db, d, 'select app.basis_pct($1)::float8 as b', [other.id]);
    if (!cross.error) return `${h.short}'s director reads ${other.short}'s cost basis (${cross.rows[0].b})`;
  }
  return null;
}

// I5 in the database: a rule's markup and floor are bounded whole numbers, the cost basis a whole
// percentage, so the page and the database cannot round the same value two ways.
export async function ruleBoundsProbe(db, catalog) {
  const A = catalog.homes[0];
  const d = dir(A);
  const id = (await runAs(db, d, "select id from pricing_rules where org_id = $1 and markup_kind = 'percent' order by position limit 1", [A.id])).rows[0].id;
  const refused = [
    ['markup_value = 100000000', 'pricing_rules'], ['markup_value = 1001', 'pricing_rules'], ['markup_value = 1.005', 'pricing_rules'],
    ["markup_kind = 'amount', markup_value = 100001", 'pricing_rules'], ['floor_cents = 150', 'pricing_rules'],
    ['floor_cents = 10000100', 'pricing_rules'], ['wholesale_basis_pct = 55.5', 'organizations'],
  ];
  for (const [set, table] of refused) {
    const r = await runAs(db, d, `update ${table} set ${set} where id = $1 returning id`, [table === 'organizations' ? A.id : id]);
    if (!r.error) return `the database stored ${set} (${r.rows.length} row)`;
  }
  for (const set of ['markup_value = 1000', 'markup_value = 0', "markup_kind = 'amount', markup_value = 100000", 'floor_cents = 10000000']) {
    const r = await runAs(db, d, `update pricing_rules set ${set} where id = $1 returning id`, [id]);
    if (r.error || r.rows.length !== 1) return `the database refused ${set}: ${r.error}`;
  }
  return null;
}

// I4: once ordered, an arrangement is what the supplier received. No one signed in adds, removes or
// changes a line, renames it or changes its order type or status. A line's title is the catalog's.
export async function orderedFrozenProbe(db, catalog) {
  const A = catalog.homes[0];
  const it = typedItem(catalog);
  const buy = it.variants.find((v) => v.order_type === 'Buy Now');
  const plain = plainItem(catalog);
  const made = await tryTx(db, dir(A), async (q) => {
    const a = await q("insert into arrangements (org_id, family_label, order_type) values ($1, 'Sample: frozen probe', 'Buy Now') returning id", [A.id]);
    const l = await q("insert into arrangement_lines (arrangement_id, org_id, step_key, item_id, variant_id, title_at_save, retail_cents) values ($1, $2, 'casket', $3, $4, 'Free casket', 0) returning title_at_save",
      [a.rows[0].id, A.id, it.id, buy.id]);
    return { id: a.rows[0].id, title: l.rows[0].title_at_save };
  });
  if (made.error) return `the director could not save the probe arrangement: ${made.error}`;
  if (made.value.title !== it.title) return `a line typed "Free casket" was saved under that title (${made.value.title})`;
  const id = made.value.id;
  const ord = await runAs(db, dir(A), "update arrangements set status = 'ordered' where id = $1 returning id", [id], { commit: true });
  if (ord.error || ord.rows.length !== 1) return `the director could not mark it ordered: ${ord.error}`;
  const snapshot = async () => JSON.stringify((await runAsService(db, `select a.family_label, a.order_type, a.status,
    (select json_agg(json_build_object('v', l.variant_id::text, 't', l.title_at_save, 'r', l.retail_cents) order by l.id) from arrangement_lines l where l.arrangement_id = a.id) as lines
    from arrangements a where a.id = $1`, [id])).rows);
  const before = await snapshot();
  const tries = [
    ['adds a line', "insert into arrangement_lines (arrangement_id, org_id, step_key, item_id, variant_id, title_at_save, retail_cents) values ($1, $2, 'casket', $3, $4, 'Free casket', 1) returning id", [id, A.id, plain.id, plain.variants[0].id]],
    ['renames it', "update arrangements set family_label = 'Sample: other' where id = $1 returning id", [id]],
    ['changes its order type', "update arrangements set order_type = 'Pre-Need' where id = $1 returning id", [id]],
    ['puts it back to saved', "update arrangements set status = 'saved' where id = $1 returning id", [id]],
    ['changes a line', 'update arrangement_lines set retail_cents = 1 where arrangement_id = $1 returning id', [id]],
    ['removes a line', 'delete from arrangement_lines where arrangement_id = $1 returning id', [id]],
  ];
  for (const u of [arr(A), dir(A)]) {
    for (const [what, sql, params] of tries) {
      const r = await runAs(db, u, sql, params, { commit: true });
      if (!r.error && r.rows.length) return `${u.label} ${what} on an ordered arrangement (${r.rows.length} row)`;
    }
  }
  const after = await snapshot();
  if (after !== before) return `the ordered arrangement changed: ${before} -> ${after}`;
  return null;
}

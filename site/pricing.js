// Prices in whole cents. The database computes the same numbers (app.apply_rule, app.cost_cents);
// tests/pricing.test.mjs checks both agree on every casket and head panel for both sample homes.

export function costCents(publicCents, basisPct) {
  const bp = Math.round(Number(basisPct) * 100);
  return Math.floor((publicCents * bp + 5000) / 10000);
}

export function applyRule(cost, rule) {
  const v = Math.round(Number(rule.value) * 100);
  let x = rule.kind === 'percent' ? Math.floor((cost * (10000 + v) + 5000) / 10000) : cost + v;
  if (rule.rounding === 'whole') x += (100 - (x % 100)) % 100;
  else if (rule.rounding === 'ninety_five') x += ((95 - (x % 100)) + 100) % 100;
  return Math.max(x, Math.round(Number(rule.floor) * 100));
}

export function ruleFor(home, item) {
  return home.rules.find((r) => r.item_type === item.type && (r.collection == null || item.collections.includes(r.collection))) || null;
}

export function priceFor(home, item, variant) {
  const cost = costCents(variant.price, home.wholesale_basis_pct);
  const rule = ruleFor(home, item);
  const retail = rule ? applyRule(cost, rule) : variant.price;
  return { public: variant.price, cost, retail, rule, margin: retail - cost };
}

// Margin as a percentage of retail, one decimal, rounded half up, in whole numbers only
// (2,550.00 on 4,000.00 is 63.8%, where floating point gives 63.7).
export function marginPct(margin, retail) {
  if (!retail) return '0.0';
  const neg = (margin < 0) !== (retail < 0) && margin !== 0;
  const m = Math.abs(margin);
  const r = Math.abs(retail);
  const tenths = Math.floor((2000 * m + r) / (2 * r));
  return `${neg ? '-' : ''}${Math.floor(tenths / 10)}.${tenths % 10}`;
}

// The variant the family is shown: the one the director picked, otherwise Buy Now when it can be
// ordered, otherwise the first variant that can.
export function shownVariant(item, pick) {
  if (pick) {
    const v = item.variants.find((x) => x.id === Number(pick));
    if (v) return v;
  }
  const typed = item.variants.filter((v) => v.order_type);
  if (typed.length) return typed.find((v) => v.order_type === 'Buy Now' && v.available) || typed.find((v) => v.available) || typed[0];
  return item.variants.find((v) => v.available) || item.variants[0];
}

// What saving records: the variants shown, and the order type of the Buy Now / Pre-Need variant
// among them (null when no product of the arrangement offers either).
export function savePlan(entries) {
  const typed = entries.find((e) => e.variant.order_type);
  return {
    order_type: typed ? typed.variant.order_type : null,
    lines: entries.map((e, i) => ({ step: e.step, item: e.item.id, variant: e.variant.id, title: e.item.title, position: i })),
  };
}

// Order types the director may switch an arrangement to: those for which every Buy Now /
// Pre-Need product of the arrangement has a variant that can be ordered.
export function orderTypesFor(lines, items) {
  const typedItems = lines.map((l) => items[String(l.item)]).filter((it) => it && it.variants.some((v) => v.order_type));
  if (!typedItems.length) return [];
  return ['Buy Now', 'Pre-Need'].filter((t) => typedItems.every((it) => it.variants.some((v) => v.order_type === t && v.available)));
}

// The variant a line orders: the one matching the arrangement's order type when the product
// offers Buy Now and Pre-Need, otherwise the variant saved on the line.
export function variantForLine(item, line, orderType) {
  if (!item) return null;
  const typed = item.variants.filter((v) => v.order_type);
  if (typed.length) return typed.find((v) => v.order_type === orderType) || null;
  return item.variants.find((v) => v.id === Number(line.variant)) || null;
}

export function readDay(iso) {
  const d = new Date(iso);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${d.getUTCDate()} ${mon} ${d.getUTCFullYear()}`;
}

// Why a saved line cannot be ordered, in the words of the only catalog read there is.
export function lineStatus(item, line, orderType, readIso) {
  const day = readDay(readIso);
  if (!item) return `Not in the catalog read on ${day}`;
  const v = variantForLine(item, line, orderType);
  if (!v) return `Not in the catalog read on ${day}`;
  if (!v.available) return `Not available in the catalog read on ${day}`;
  return '';
}

export const STORE = 'https://overnightcaskets.com';

// Supplier cart link: /cart/<variant>:<qty>,... built only from variants present and available
// in the catalog read. Lines that cannot be ordered are returned in leftOut, never guessed.
export function cartLink(lines, items, orderType, readIso) {
  const ok = [];
  const leftOut = [];
  for (const line of lines) {
    const item = items[String(line.item)];
    const reason = lineStatus(item, line, orderType, readIso);
    if (reason) { leftOut.push({ ...line, reason }); continue; }
    const v = variantForLine(item, line, orderType);
    ok.push({ ...line, variant: v.id, variantTitle: v.title, public: v.price, qty: 1, name: item.name || item.title });
  }
  const url = ok.length ? `${STORE}/cart/${ok.map((l) => `${l.variant}:${l.qty}`).join(',')}` : null;
  return { url, lines: ok, leftOut };
}

export function money(c) {
  const s = (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (c < 0 ? '-$' : '$') + s;
}

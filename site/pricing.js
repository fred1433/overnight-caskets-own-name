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

// The variant a line orders: the one matching the arrangement's order type when the product
// offers Buy Now and Pre-Need, otherwise the variant saved on the line.
export function variantForLine(item, line, orderType) {
  if (!item) return null;
  const typed = item.variants.filter((v) => v.order_type);
  if (typed.length) return typed.find((v) => v.order_type === orderType) || null;
  return item.variants.find((v) => v.id === Number(line.variant)) || null;
}

export const STORE = 'https://overnightcaskets.com';

// Supplier cart link: /cart/<variant>:<qty>,... built only from variants present and available
// in the catalog snapshot. Lines that cannot be ordered are returned in leftOut, never guessed.
export function cartLink(lines, items, orderType) {
  const ok = [];
  const leftOut = [];
  for (const line of lines) {
    const item = items[String(line.item)];
    const v = variantForLine(item, line, orderType);
    if (!item || !v) leftOut.push({ ...line, reason: 'No longer in the current catalog' });
    else if (!v.available) leftOut.push({ ...line, reason: 'Not available in the catalog read' });
    else ok.push({ ...line, variant: v.id, variantTitle: v.title, public: v.price, qty: 1, name: item.title });
  }
  const url = ok.length ? `${STORE}/cart/${ok.map((l) => `${l.variant}:${l.qty}`).join(',')}` : null;
  return { url, lines: ok, leftOut };
}

export function money(c) {
  const s = (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (c < 0 ? '-$' : '$') + s;
}

import { priceFor, money, cartLink, shownVariant, savePlan, orderTypesFor, lineStatus, marginPct } from './pricing.js';
import { crossTenantChecks, OWNER_COUNT } from './checks.js';
import { openDb, runAs, runAsService, transactionAs, ARRANGEMENTS_SQL, COSTS_SQL } from './db.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const img = (src, w) => (src ? src + (src.includes('?') ? '&' : '?') + 'width=' + w : '');

let C;
const S = {
  home: 0,
  per: {},
  as: {},
  director: false,
  animate: false,
  compare: false,
  checkout: null,
  chip: 'All',
  db: { status: 'idle', inst: null, promise: null, error: null },
  arr: {},
  costs: {},
  local: {},
  present: false,
};
const PAGE_TITLE = document.title;

const H = () => C.homes[S.home];
const P = () => S.per[H().id];
const userOf = (h) => h.users.find((u) => u.label === (S.as[h.id] || 'Director'));
const item = (id) => C.items[String(id)];
const room = () => H().rooms.find((r) => r.id === P().room);

function fmtRead(iso) {
  const d = new Date(iso);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${d.getUTCDate()} ${mon} ${d.getUTCFullYear()}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

const displayVariant = (it) => shownVariant(it, P().variantPick[it.id]);
// The option a director picked on a product sold in several versions (handles, lid style),
// written for the family: "Handle Type: No Handles". Nothing for Buy Now / Pre-Need.
function variantNote(it, v = displayVariant(it)) {
  if (it.variants.length < 2 || it.variants.some((x) => x.order_type)) return '';
  return `${it.options && it.options[0] && it.options[0] !== 'Title' ? it.options[0] + ': ' : ''}${v.title}`;
}
const retail = (it, h = H()) => priceFor(h, it, displayVariant(it)).retail;

function panelName(t) {
  const m = t.match(/^(.*?)\s*-\s*(Ivory|White|Blue|Pink)\s*$/i);
  return m ? { name: m[1].replace(/\s+Head Panel$/i, ''), colour: m[2][0].toUpperCase() + m[2].slice(1).toLowerCase() } : { name: t.replace(/\s+Panel$/i, ''), colour: 'Custom' };
}

function mark(h, size = 44) {
  const a = h.brand.accent;
  const f = h.brand.font === 'Albert Sans' ? "'Albert Sans', sans-serif" : "'Cormorant Garamond', serif";
  if (h.brand.mark === 'arch') {
    return `<svg viewBox="0 0 44 44" width="${size}" height="${size}" aria-hidden="true"><path d="M6 41V19a16 16 0 0 1 32 0v22z" fill="none" stroke="${a}" stroke-width="1.3"/><path d="M9.5 41V19.5a12.5 12.5 0 0 1 25 0V41" fill="none" stroke="${a}" stroke-width=".6"/><text x="22" y="31" text-anchor="middle" font-family="${f}" font-size="11.5" font-weight="500" letter-spacing="1.5" fill="${a}">${esc(h.monogram)}</text></svg>`;
  }
  return `<svg viewBox="0 0 44 44" width="${size}" height="${size}" aria-hidden="true"><ellipse cx="22" cy="22" rx="19" ry="21" fill="none" stroke="${a}" stroke-width="1.3"/><ellipse cx="22" cy="22" rx="16" ry="18" fill="none" stroke="${a}" stroke-width=".6"/><text x="22" y="27" text-anchor="middle" font-family="${f}" font-size="15" font-weight="600" letter-spacing=".5" fill="${a}">${esc(h.monogram)}</text></svg>`;
}

function newSession(h, roomId) {
  return { room: roomId || h.rooms[0].id, idx: 0, step: 'casket', kept: [], casket: null, panel: null, variantPick: {}, saved: null, saving: false };
}

/* Family side ------------------------------------------------------------------------------ */

function headerHTML() {
  const h = H();
  const rest = h.name.slice(h.short.length).trim();
  const p = P();
  const steps = [['casket', 'Casket'], ['lid_panel', 'Head panel'], ['review', 'Review']];
  const order = steps.map((s) => s[0]);
  return `
  <header class="bar">
    <div class="brand">${mark(h)}<div class="brand-text"><span class="brand-name">${esc(h.short)}</span><span class="brand-kind">${esc(rest)}</span></div></div>
    <p class="family"><strong>${esc(h.session_family)}</strong><span class="tag">Sample</span></p>
    ${S.present ? '' : `<button class="dv-btn" data-act="director" data-k="dv" aria-expanded="${S.director}" aria-controls="director">Director view</button>`}
  </header>
  ${S.present ? '<button class="leave" data-act="leave-present" data-k="leave" aria-label="Leave presentation">Leave</button>' : ''}
  <nav class="bar2" aria-label="Rooms and steps">
    <div class="rooms" role="tablist" aria-label="Selection rooms">
      ${h.rooms.map((r) => `<button class="room-tab" role="tab" data-act="room" data-id="${r.id}" data-k="room-${r.id}" aria-selected="${p.step === 'casket' && p.room === r.id}">${esc(r.name)}</button>`).join('')}
    </div>
    <ol class="steps">
      ${steps.map(([k, label]) => {
        const i = order.indexOf(k);
        const cur = order.indexOf(p.step);
        const enabled = k === 'casket' || !!p.casket;
        return `<li><button class="step-btn ${i < cur ? 'done' : ''}" data-act="step" data-step="${k}" data-k="step-${k}" ${p.step === k ? 'aria-current="step"' : ''} ${enabled ? '' : 'disabled'}>${label}</button></li>`;
      }).join('')}
    </ol>
  </nav>`;
}

const FACTS = [['material', 'Material'], ['finish', 'Exterior finish'], ['interior', 'Interior']];
const COMPARE_ROWS = [['material', 'Material'], ['finish', 'Exterior finish'], ['interior', 'Interior'], ['bed', 'Bed'], ['sealed', 'Sealed'], ['exterior_size', 'Exterior size']];

function casketHTML() {
  const h = H();
  const p = P();
  const r = room();
  const ids = r.items;
  p.idx = Math.min(p.idx, ids.length - 1);
  const it = item(ids[p.idx]);
  const kept = p.kept.includes(it.id);
  const chosen = p.casket === it.id;
  return `
  <div class="stage">
    <figure class="photo" data-swipe>
      <img src="${img(it.image, 1100)}" alt="${esc(it.name)}" width="1100" height="1100" draggable="false">
      <button class="nav-btn prev" data-act="prev" data-k="prev" aria-label="Previous casket"><svg viewBox="0 0 20 20"><path d="M12.5 4 6.5 10l6 6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></button>
      <button class="nav-btn next" data-act="next" data-k="next" aria-label="Next casket"><svg viewBox="0 0 20 20"><path d="m7.5 4 6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></button>
      <figcaption class="count">${p.idx + 1} of ${ids.length}</figcaption>
      ${kept ? '<span class="kept-mark">Kept for comparison</span>' : ''}
    </figure>
    <div class="info">
      <p class="room-line">${esc(r.name)}, ${ids.length} caskets</p>
      <h2 class="pname">${esc(it.name)}</h2>
      ${it.sub ? `<p class="psub">${esc(it.sub)}</p>` : ''}
      ${variantNote(it) ? `<p class="pvariant" data-variant-note>${esc(variantNote(it))}</p>` : ''}
      <p class="price" data-price>${money(retail(it))}</p>
      <dl class="facts">${FACTS.filter(([k]) => it.attributes[k]).map(([k, l]) => `<div><dt>${l}</dt><dd>${esc(it.attributes[k])}</dd></div>`).join('')}</dl>
      <div class="actions">
        ${chosen ? '<p class="chosen-note">Chosen for this arrangement.</p>' : ''}
        <button class="btn primary" data-act="choose" data-id="${it.id}" data-k="choose">${chosen ? 'Continue with this casket' : 'Choose this casket'}</button>
        <button class="btn keep" data-act="keep" data-id="${it.id}" data-k="keep" aria-pressed="${kept}">${kept ? 'Kept for comparison' : 'Keep for comparison'}</button>
      </div>
    </div>
  </div>
  <div class="strip">
    <ul class="thumbs" aria-label="Caskets in ${esc(r.name)}">
      ${ids.map((id, i) => {
        const t = item(id);
        return `<li><button class="thumb" data-act="focus" data-i="${i}" data-k="thumb-${i}" ${i === p.idx ? 'aria-current="true"' : ''} aria-label="${esc(t.name)}, ${money(retail(t))}">${p.kept.includes(t.id) ? '<i class="dot" aria-hidden="true"></i>' : ''}<img src="${img(t.image, 260)}" alt="" loading="lazy" width="106" height="64"><span class="t-name">${esc(t.name)}</span><span class="t-price">${money(retail(t))}</span></button></li>`;
      }).join('')}
    </ul>
    <div class="strip-end">
      <p>${p.kept.length ? `${p.kept.length} kept for comparison` : 'Keep two or three to compare them'}</p>
      <button class="btn" data-act="compare" data-k="compare" ${p.kept.length >= 2 ? '' : 'disabled'}>Compare side by side</button>
    </div>
  </div>
  ${S.compare ? compareHTML() : ''}`;
}

function compareHTML() {
  const p = P();
  const its = p.kept.map(item);
  return `
  <div class="compare" role="dialog" aria-modal="false" aria-label="Compare side by side">
    <div class="compare-head"><h2>Side by side</h2><button class="btn" data-act="close-compare" data-k="close-compare">Back to the room</button></div>
    <div class="compare-grid">
      <table class="compare-table">
        <colgroup><col class="c-label">${its.map(() => '<col>').join('')}</colgroup>
        <thead><tr><th scope="col"><span class="sr"></span></th>${its.map((it) => `<th scope="col"><img class="c-photo" src="${img(it.image, 600)}" alt=""><p class="c-name">${esc(it.name)}</p><p class="psub" style="font-size:15px;margin:0">${esc([it.sub, variantNote(it)].filter(Boolean).join(', '))}</p><p class="c-price">${money(retail(it))}</p><div class="c-actions"><button class="btn primary" data-act="choose" data-id="${it.id}" data-k="cchoose-${it.id}">Choose</button><button class="btn" data-act="uncompare" data-id="${it.id}" data-k="unc-${it.id}">Remove</button></div></th>`).join('')}</tr></thead>
        <tbody>${COMPARE_ROWS.map(([k, l]) => `<tr><th scope="row">${l}</th>${its.map((it) => `<td>${esc(it.attributes[k] || 'Not stated')}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>
  </div>`;
}

function panelsHTML() {
  const h = H();
  const p = P();
  const casket = item(p.casket);
  // The custom cap panel is made from the family's own photo and words, so it is not offered from a list.
  const panels = Object.values(C.items).filter((i) => i.type === 'lid_panel' && panelName(i.name).colour !== 'Custom' && i.variants.some((v) => v.available));
  const chips = ['All', 'Ivory', 'White', 'Blue', 'Pink'];
  const shown = panels.filter((i) => S.chip === 'All' || panelName(i.name).colour === S.chip);
  return `
  <div class="panels">
    <div class="panels-head">
      <div><h2>A head panel, if the family wishes</h2><p>For the ${esc(casket.name)}. Optional.</p></div>
      <div class="chips" role="group" aria-label="Panel colour">${chips.map((c) => `<button class="chip" data-act="chip" data-c="${c}" data-k="chip-${c}" aria-pressed="${S.chip === c}">${c}</button>`).join('')}</div>
    </div>
    <ul class="panel-grid">
      <li><button class="ptile" data-act="panel" data-id="none" data-k="panel-none" aria-pressed="${p.panel === 'none'}"><span class="none">No head panel</span><b>No head panel</b><small>The casket as shown</small></button></li>
      ${shown.map((i, n0) => {
        const n = panelName(i.name);
        return `<li><button class="ptile" data-act="panel" data-id="${i.id}" data-k="panel-${i.id}" aria-pressed="${p.panel === i.id}"><img src="${img(i.image, 360)}" alt="" ${n0 > 20 ? 'loading="lazy"' : ''}><b>${esc(n.name)}</b><small>${esc(n.colour)}</small><em>${money(retail(i))}</em></button></li>`;
      }).join('')}
    </ul>
    <div class="panels-foot"><button class="btn primary" data-act="to-review" data-k="to-review" ${p.panel ? '' : 'disabled'}>Continue to review</button></div>
  </div>`;
}

function sessionLines() {
  const p = P();
  const lines = [];
  if (p.casket) lines.push({ step: 'casket', it: item(p.casket) });
  if (p.panel && p.panel !== 'none') lines.push({ step: 'lid_panel', it: item(p.panel) });
  return lines;
}

function reviewHTML() {
  const h = H();
  const p = P();
  const lines = sessionLines();
  const total = lines.reduce((s, l) => s + retail(l.it), 0);
  return `
  <div class="review">
    <article class="sheet">
      <p class="sheet-home">${mark(h, 30)}${esc(h.name)}</p>
      <h2>Arrangement for the ${esc(h.session_family)}</h2>
      <p class="sheet-sub">Sample family. Prices are ${esc(h.short)}’s own.</p>
      <table class="lines">
        <tbody>${lines.map((l) => `<tr><td class="l-img"><img src="${img(l.it.image, 240)}" alt=""></td><td class="l-name"><b>${esc(l.step === 'lid_panel' ? panelName(l.it.name).name + ' head panel' : l.it.name)}</b><span>${esc(l.step === 'lid_panel' ? panelName(l.it.name).colour : [l.it.sub, variantNote(l.it)].filter(Boolean).join(', '))}</span></td><td class="l-price">${money(retail(l.it))}</td></tr>`).join('')}
        ${p.panel === 'none' ? '<tr><td class="l-img"></td><td class="l-name"><span>No head panel</span></td><td class="l-price"></td></tr>' : ''}</tbody>
        <tfoot><tr><td></td><td>Total</td><td class="l-price">${money(total)}</td></tr></tfoot>
      </table>
      <div class="sheet-actions">
        ${p.saved ? `<p class="saved-note" data-saved>Saved. ${esc(h.short)} has this arrangement on file.</p><button class="btn" data-act="new" data-k="new">Begin another selection</button>`
          : `${p.saveError ? `<p class="save-err" role="alert" data-save-error>${esc(p.saveError)}</p>` : ''}<button class="btn" data-act="step" data-step="casket" data-k="back-casket">Back to the caskets</button><button class="btn primary" data-act="save" data-k="save" ${p.saving ? 'disabled' : ''}>${p.saving ? 'Saving' : 'Save arrangement'}</button>`}
      </div>
    </article>
  </div>`;
}

/* Director side ---------------------------------------------------------------------------- */

const ROUND = { cent: 'To the cent', whole: 'Whole dollar', ninety_five: 'Ends in .95' };
const ROUND_TEXT = { cent: 'to the cent', whole: 'rounded up to the whole dollar', ninety_five: 'rounded up to end in .95' };

function ruleText(r) {
  if (!r) return 'No rule: public price';
  const m = r.kind === 'percent' ? `cost + ${Number(r.value)}%` : `cost + ${money(Math.round(r.value * 100))}`;
  return `${r.label}: ${m}, ${ROUND_TEXT[r.rounding]}${Number(r.floor) ? `, floor ${money(Math.round(r.floor * 100))}` : ''}`;
}

function arrangementsHTML(h, u) {
  const st = S.db.status;
  let list;
  let note = '';
  if (st === 'ready') list = S.arr[h.id] || [];
  else if (st === 'failed') {
    list = S.local[h.id];
    note = `<p class="d-note">The in-page database did not start in this browser (${esc(S.db.error)}). The list below is kept in the page only; the same queries run in the repository tests.</p>`;
  } else return `<p class="db-state" data-db-state>Starting the database in this page.</p>`;
  const costs = S.costs[h.id] || {};
  const items = list.map((a) => {
    const link = cartLink(a.lines, C.items, a.order_type, C.read_started);
    const total = a.lines.reduce((s, l) => s + Number(l.retail), 0);
    const lines = a.lines.map((l) => {
      const it = item(l.item);
      const gone = lineStatus(it, l, a.order_type, C.read_started);
      const v = it && it.variants.find((x) => x.id === Number(l.variant));
      const note = it && v && l.step !== 'lid_panel' ? variantNote(it, v) : '';
      const c = costs[l.id];
      const name = it ? (l.step === 'lid_panel' ? panelName(it.name).name + ' head panel, ' + panelName(it.name).colour : it.name + (note ? `, ${note}` : '')) : l.title;
      return `<li><span>${esc(name)}${gone ? `<span class="gone">${esc(gone)}</span>` : ''}</span><span>${money(Number(l.retail))}${u.can_see_cost && c ? `<span class="cost">Illustrative cost ${money(c.cost)}<br>Illustrative margin ${money(Number(l.retail) - c.cost)}</span>` : ''}</span></li>`;
    }).join('');
    const open = S.checkout === a.id;
    const types = orderTypesFor(a.lines, C.items);
    const typeCtl = types.length >= 2 && u.can_order
      ? `<label class="a-type">Order type <select data-ordertype="${esc(a.id)}" data-k="ot-${esc(a.id)}">${types.map((o) => `<option ${a.order_type === o ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`
      : a.order_type ? `<span class="a-type" data-order-type>Order type: ${esc(a.order_type)}</span>` : '';
    return `<li data-arr="${esc(a.id)}">
      <div class="a-top"><b>${esc(a.family_label)}</b><span>${money(total)}</span></div>
      <ul class="a-lines">${lines}</ul>
      <div class="a-act">
        ${typeCtl}
        ${u.can_order ? `<button class="d-btn ${open ? 'quiet' : ''}" data-act="checkout" data-id="${esc(a.id)}" data-k="co-${esc(a.id)}" aria-expanded="${open}">${open ? 'Hide supplier order' : 'Prepare supplier order'}</button>` : ''}
      </div>
      ${S.arrError && S.arrError.id === a.id ? `<p class="d-err" role="alert" data-arr-error>${esc(S.arrError.text)}</p>` : ''}
      ${open ? checkoutHTML(link) : ''}
    </li>`;
  }).join('');
  return `${note}<ul class="arr">${items || '<li>No arrangement on file yet.</li>'}</ul>`;
}

function checkoutHTML(link) {
  const name = (l) => (item(l.item) ? item(l.item).name : l.title);
  return `<div class="checkout" data-checkout>
    <p style="margin:0 0 6px">The supplier link carries exactly these lines, built from the variant ids of the catalog read:</p>
    ${link.url ? `<code data-cart-url>${esc(link.url)}</code>` : ''}
    <table>${link.lines.map((l) => `<tr><td>${esc(l.name)}<br><span style="color:var(--ink-3)">${esc(l.variantTitle)}, variant ${l.variant}, qty ${l.qty}</span></td><td>Public ${money(l.public)}</td></tr>`).join('')}
    ${link.leftOut.map((l) => `<tr><td colspan="2">${esc(name(l))}: ${esc(l.reason[0].toLowerCase() + l.reason.slice(1))}, left out of the link</td></tr>`).join('')}</table>
    ${link.url ? `<a class="open" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer" data-k="open-cart">Open public checkout (public prices)</a>
    <p class="partner">Partner prices would come from the wholesale account; this page checks only the public checkout (Shop Pay), on 24 November 2026.</p>` : '<p class="d-note">Nothing in this arrangement can be ordered from the catalog read.</p>'}
  </div>`;
}

function directorHTML() {
  const h = H();
  const u = userOf(h);
  const p = P();
  const it = p.step === 'casket' ? item(room().items[p.idx]) : item(p.casket);
  const v = displayVariant(it);
  const pr = priceFor(h, it, v);
  const extra = it.variants.length > 1 && !it.variants.every((x) => x.order_type);
  const arranger = u.label === 'Arranger';
  return `
  <div class="scrim" data-act="close-director"></div>
  <aside class="director ${S.animate ? 'animate' : ''}" id="director" role="dialog" aria-label="Director view">
    <div class="d-head"><div><h2>Director view</h2><p>The family does not see this panel.</p></div><button class="d-close" data-act="close-director" data-k="close-director">Close</button></div>
    <div class="d-body">
      <section class="d-sec">
        <div class="who"><p>Signed in as <b>${esc(u.label)}</b>, ${esc(h.short)}</p>
          <button class="switch" role="switch" aria-checked="${arranger}" data-act="as-arranger" data-k="as-arranger"><span class="track"></span>Preview as arranger</button></div>
        <p class="d-note">Staff sign in with a 6-digit email code scoped to their home; this demo opens two sample homes directly.${arranger ? ' An arranger guides the family and saves arrangements. Cost, margin, pricing rules and supplier orders are hidden from this person, and the database refuses them too: it returns no rule, cost basis or saved cost, and refuses ordering.' : ''}</p>
      </section>
      <section class="d-sec">
        <h3>${esc(it.name)}</h3>
        ${u.can_see_cost ? `<table class="ladder">
          <tr><th>Public price on overnightcaskets.com, read ${fmtRead(C.read_started)}</th><td>${money(pr.public)}</td></tr>
          <tr><th>Illustrative wholesale cost, <input class="pct" type="number" inputmode="numeric" min="1" max="100" step="1" value="${Number(h.wholesale_basis_pct)}" data-basis data-k="basis" aria-label="Wholesale cost as a percentage of the public price">% of public</th><td data-d-cost>${money(pr.cost)}</td></tr>
          <tr class="strong"><th>Retail, what the family sees</th><td data-d-retail>${money(pr.retail)}</td></tr>
          <tr><th>Illustrative margin</th><td data-d-margin>${money(pr.margin)} (${marginPct(pr.margin, pr.retail)}%)</td></tr>
        </table>
        <p class="rule-line" data-d-rule>${esc(ruleText(pr.rule))}</p>
        <p class="d-note">The cost is an assumption until the partner price list is loaded. The price is frozen in the arrangement when it is saved.</p>`
        : `<p class="rule-line">Retail shown to the family: ${money(pr.retail)}</p>`}
        ${extra ? `<p class="rule-line"><label>Variant <select data-variant="${it.id}" data-k="variant">${it.variants.map((x) => `<option value="${x.id}" ${x.id === v.id ? 'selected' : ''} ${x.available ? '' : 'disabled'}>${esc(x.title)}, ${money(priceFor(h, it, x).retail)}</option>`).join('')}</select></label></p>` : ''}
      </section>
      ${u.can_edit_pricing ? `<section class="d-sec">
        <h3>Pricing rules, first match wins</h3>
        ${S.ruleError ? `<p class="d-err" role="alert" data-rule-error>${esc(S.ruleError)}</p>` : ''}
        <ul class="rules">${h.rules.map((r, i) => `<li data-rule-id="${r.id}" class="${pr.rule && pr.rule.id === r.id ? 'active' : ''}">
          <div class="r-top"><b>${esc(r.label)}</b><span>${r.collection ? `${esc(C.collections[r.collection].title)} collection` : r.item_type === 'lid_panel' ? 'every head panel' : 'every casket not above'}</span></div>
          <div class="r-edit">
            <label>Markup<select data-rule="${i}" data-f="kind" data-k="r${i}-kind"><option value="percent" ${r.kind === 'percent' ? 'selected' : ''}>%</option><option value="amount" ${r.kind === 'amount' ? 'selected' : ''}>$</option></select></label>
            <label>Value<input type="number" inputmode="numeric" min="0" max="${BOUNDS[r.kind]}" step="1" value="${Number(r.value)}" data-rule="${i}" data-f="value" data-k="r${i}-value"></label>
            <label>Rounding<select data-rule="${i}" data-f="rounding" data-k="r${i}-rounding">${Object.entries(ROUND).map(([k, l]) => `<option value="${k}" ${r.rounding === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
            <label>Floor, $<input type="number" inputmode="numeric" min="0" max="${BOUNDS.floor}" step="1" value="${Number(r.floor)}" data-rule="${i}" data-f="floor" data-k="r${i}-floor"></label>
          </div></li>`).join('')}</ul>
        <p class="d-note">Collections are Overnight Caskets’ own. Rule changes reprice the rooms at once and are written to the database as this director.</p>
      </section>` : ''}
      <section class="d-sec">
        <h3>Arrangements on file</h3>
        ${arrangementsHTML(h, u)}
      </section>
      <section class="d-sec">
        <p class="d-note">Catalog read ${fmtRead(C.read_started)} from the public storefront feed: ${C.counts.casket} caskets and ${C.counts.lid_panel - 1} head panels used here; urns, pet caskets and the custom cap panel are left out.</p>
      </section>
    </div>
  </aside>`;
}

/* Render ------------------------------------------------------------------------------------ */

const KEEP_SCROLL = ['.d-body', '.thumbs', '.panel-grid', '.compare-grid', '.review', '.info'];

function render() {
  const app = $('#app');
  const h = H();
  const active = document.activeElement;
  const k = active && active.closest && active.closest('#app') ? active.getAttribute('data-k') : null;
  const scrolls = KEEP_SCROLL.map((s) => { const el = app.querySelector(s); return el ? [s, el.scrollTop, el.scrollLeft] : null; }).filter(Boolean);
  app.style.setProperty('--accent', h.brand.accent);
  app.style.setProperty('--accent-soft', h.brand.accent_soft);
  app.style.setProperty('--paper', h.brand.paper);
  app.style.setProperty('--brand', h.brand.font === 'Albert Sans' ? "'Albert Sans', 'Helvetica Neue', Arial, sans-serif" : "'Cormorant Garamond', Georgia, serif");
  app.dataset.font = h.brand.font;
  app.dataset.home = h.id;
  const p = P();
  const body = p.step === 'casket' ? casketHTML() : p.step === 'lid_panel' ? panelsHTML() : reviewHTML();
  app.innerHTML = headerHTML() + `<div class="body">${body}</div>` + (S.director ? directorHTML() : '');
  S.animate = false;
  for (const [s, t, l] of scrolls) { const el = app.querySelector(s); if (el) { el.scrollTop = t; el.scrollLeft = l; } }
  if (k) {
    const el = app.querySelector(`[data-k="${CSS.escape(k)}"]`);
    if (el) el.focus({ preventScroll: true });
  }
  const strip = app.querySelector('.thumbs');
  const cur = app.querySelector('.thumb[aria-current="true"]');
  if (strip && cur) {
    const a = cur.parentElement.offsetLeft;
    if (a < strip.scrollLeft || a + cur.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = a - 12;
  }
  renderPlates();
  renderSame();
}

// While a director types in a rule, reprice the family side and the ledger without
// rebuilding the field being typed in.
function renderPartial() {
  const app = $('#app');
  const p = P();
  const thumbs = app.querySelector('.thumbs');
  const left = thumbs ? thumbs.scrollLeft : 0;
  app.querySelector('.body').innerHTML = p.step === 'casket' ? casketHTML() : p.step === 'lid_panel' ? panelsHTML() : reviewHTML();
  const t2 = app.querySelector('.thumbs');
  if (t2) t2.scrollLeft = left;
  if (S.director) {
    const h = H();
    const it = p.step === 'casket' ? item(room().items[p.idx]) : item(p.casket);
    const pr = priceFor(h, it, displayVariant(it));
    const set = (sel, txt) => { const el = app.querySelector(sel); if (el) el.textContent = txt; };
    set('[data-d-cost]', money(pr.cost));
    set('[data-d-retail]', money(pr.retail));
    set('[data-d-margin]', `${money(pr.margin)} (${marginPct(pr.margin, pr.retail)}%)`);
    set('[data-d-rule]', ruleText(pr.rule));
    app.querySelectorAll('[data-rule-id]').forEach((li) => li.classList.toggle('active', !!pr.rule && li.dataset.ruleId === pr.rule.id));
  }
  renderSame();
}

function renderPlates() {
  $('#plates').innerHTML = C.homes.map((h, i) => `<button class="nameplate" data-act="home" data-i="${i}" aria-pressed="${i === S.home}">${mark(h, 36)}<span><span class="np-name" style="font-family:${h.brand.font === 'Albert Sans' ? "'Albert Sans',sans-serif" : "'Cormorant Garamond',serif"};color:${h.brand.accent};${h.brand.font === 'Albert Sans' ? 'font-weight:500;font-size:13.5px;letter-spacing:.14em;text-transform:uppercase;' : 'font-weight:600;'}">${esc(h.name)}</span><span class="np-note">Sample funeral home</span></span></button>`).join(' ');
}

function renderSame() {
  const [a, b] = C.homes;
  const shared = a.rooms.flatMap((r) => r.items).find((id) => b.rooms.some((r) => r.items.includes(id)));
  if (!shared) return;
  const it = item(shared);
  const pa = priceFor(a, it, shownVariant(it)).retail;
  const pb = priceFor(b, it, shownVariant(it)).retail;
  $('#same-casket').textContent = `The same ${it.name} is ${money(pa)} at ${a.short} and ${money(pb)} at ${b.short}, from rules each home sets in its Director view.`;
}

/* Database ---------------------------------------------------------------------------------- */

async function fetchText(u) {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${u}: ${r.status}`);
  return r.text();
}

function ensureDb() {
  if (S.db.promise) return S.db.promise;
  S.db.status = 'loading';
  S.db.promise = (async () => {
    const [mod, shim, migration, seed] = await Promise.all([
      import('./vendor/pglite/index.js'), fetchText('db/local_auth_shim.sql'), fetchText('db/migration.sql'), fetchText('db/seed.sql'),
    ]);
    const db = await openDb(mod.PGlite, { shim, migration, seed });
    for (const h of C.homes) await pushSettings(db, h, true);
    S.db.inst = db;
    S.db.status = 'ready';
    for (const h of C.homes) await refreshHome(h);
    if (S.director) render();
    return db;
  })().catch((e) => {
    S.db.status = 'failed';
    S.db.error = String(e && e.message ? e.message : e).slice(0, 160);
    S.db.promise = null; // the next action tries again
    if (S.director) render();
    throw e;
  });
  return S.db.promise;
}

async function pushSettings(db, h, asService) {
  const stmts = [['update organizations set wholesale_basis_pct = $1 where id = $2 returning id', [Number(h.wholesale_basis_pct), h.id]]];
  for (const r of h.rules) {
    stmts.push(['update pricing_rules set markup_kind = $1, markup_value = $2, rounding = $3, floor_cents = $4 where id = $5 returning id',
      [r.kind, Number(r.value), r.rounding, Math.round(Number(r.floor) * 100), r.id]]);
  }
  if (asService) { for (const [s, a] of stmts) await runAsService(db, s, a); return; }
  // Each write must change its one row. Anything else is said to the director and the screen goes
  // back to what the database holds.
  const u = userOf(h);
  let failed = null;
  for (const [s, a] of stmts) {
    const r = await runAs(db, u, s, a, { commit: true });
    if (r.error || !r.rows || r.rows.length !== 1) { failed = r.error || 'no row changed'; break; }
  }
  if (failed) {
    await loadSettings(db, h);
    S.ruleError = `Not saved: the database refused this change, so the rooms keep the rules it holds.`;
    console.warn('pricing write refused:', failed);
    render();
  }
}

// The rules and cost basis the database holds for this home, read as the person signed in.
async function loadSettings(db, h) {
  const u = userOf(h);
  const r = await runAs(db, u, 'select id, markup_kind, markup_value::float8 as value, rounding, floor_cents from pricing_rules where org_id = $1', [h.id]);
  for (const row of r.rows || []) {
    const x = h.rules.find((q) => q.id === row.id);
    if (x) { x.kind = row.markup_kind; x.value = Number(row.value); x.rounding = row.rounding; x.floor = Number(row.floor_cents) / 100; }
  }
  const b = await runAs(db, u, 'select app.basis_pct($1)::float8 as b', [h.id]);
  if (b.rows && b.rows[0].b != null) h.wholesale_basis_pct = Number(b.rows[0].b);
}

// The bounds of the database (constraints markup_bounds and floor_bounds): whole numbers, up to
// 1,000 % or $100,000, floor up to $100,000. A value outside them is refused here before any write.
const BOUNDS = { percent: 1000, amount: 100000, floor: 100000 };
function ruleFieldError(t) {
  const raw = String(t.value).trim();
  const whole = /^\d+$/.test(raw);
  if (t.matches('[data-basis]')) {
    return whole && Number(raw) >= 1 && Number(raw) <= 100 ? null : 'Not saved: the cost basis is a whole percentage from 1 to 100.';
  }
  const r = H().rules[Number(t.dataset.rule)];
  if (t.dataset.f === 'floor') {
    return whole && Number(raw) <= BOUNDS.floor ? null : `Not saved: the floor is a whole number of dollars, up to ${money(BOUNDS.floor * 100)}.`;
  }
  const max = BOUNDS[r.kind];
  return whole && Number(raw) <= max ? null
    : `Not saved: the markup is a whole number, up to ${r.kind === 'percent' ? max.toLocaleString('en-US') + '%' : money(max * 100)}.`;
}

async function refreshHome(h) {
  const db = S.db.inst;
  if (!db) return;
  const u = userOf(h);
  const r = await runAs(db, u, ARRANGEMENTS_SQL);
  S.arr[h.id] = (r.rows || []).map((a) => ({ ...a, lines: typeof a.lines === 'string' ? JSON.parse(a.lines) : a.lines }));
  const c = await runAs(db, u, COSTS_SQL);
  S.costs[h.id] = Object.fromEntries((c.rows || []).map((x) => [x.line_id, { cost: x.cost_cents, public: x.public_price_cents }]));
}

function showRuleError() {
  const sec = $('#app .rules');
  if (!sec) return;
  let el = $('#app [data-rule-error]');
  if (!S.ruleError) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('p');
    el.className = 'd-err'; el.setAttribute('role', 'alert'); el.setAttribute('data-rule-error', '');
    sec.parentElement.insertBefore(el, sec);
  }
  el.textContent = S.ruleError;
}

let pushTimer = null;
function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    if (S.db.status !== 'ready') return;
    const h = H();
    await pushSettings(S.db.inst, h, false);
  }, 400);
}

async function save() {
  const h = H();
  const p = P();
  if (!p.casket || p.saving || p.saved) return;
  p.saving = true;
  render();
  // The variants the family was shown, and their order type: what is saved is what can be ordered.
  const plan = savePlan(sessionLines().map((l) => ({ step: l.step, item: l.it, variant: displayVariant(l.it) })));
  const lines = plan.lines;
  let db = null;
  try { db = await ensureDb(); } catch (_) { /* the database did not start: kept in the page, said in Director view */ }
  p.saveError = null;
  if (db) {
    try {
      const id = await transactionAs(db, userOf(h), async (q) => {
      const a = await q('insert into arrangements (org_id, family_label, order_type) values ($1, $2, $3) returning id', [h.id, 'Sample: ' + h.session_family, plan.order_type]);
      const aid = a.rows[0].id;
      for (const l of lines) {
        await q('insert into arrangement_lines (arrangement_id, org_id, step_key, item_id, variant_id, title_at_save, retail_cents, position) values ($1, $2, $3, $4, $5, $6, 0, $7)',
          [aid, h.id, l.step, l.item, l.variant, l.title, l.position]);
        }
        return aid;
      });
      p.saved = { id };
      await refreshHome(h);
    } catch (e) {
      p.saveError = 'Not saved: the database refused this arrangement. Nothing was kept.';
      console.warn('arrangement write refused:', e && e.message);
    }
  } else {
    const id = 'local-' + Date.now();
    S.local[h.id].unshift({ id, family_label: 'Sample: ' + h.session_family, order_type: plan.order_type, lines: lines.map((l) => ({ ...l, id: id + l.position, retail: retail(item(l.item)) })) });
    p.saved = { id, local: true };
  }
  p.saving = false;
  render();
}

async function setOrderType(id, value) {
  const h = H();
  if (S.db.status === 'ready') {
    // The database moves each Buy Now / Pre-Need line to the variant of the new type.
    const r = await runAs(S.db.inst, userOf(h), 'update arrangements set order_type = $1 where id = $2 returning id', [value, id], { commit: true });
    const refused = r.error || !r.rows || r.rows.length !== 1;
    if (refused) {
      const was = (S.arr[h.id] || []).find((x) => x.id === id);
      S.arrError = { id, text: `Not changed: the database refused it. The order type stays ${was && was.order_type ? was.order_type : 'as saved'}.` };
      console.warn('order type write refused:', r.error || 'no row changed');
    } else S.arrError = null;
    await refreshHome(h);
  } else {
    const a = (S.local[h.id] || []).find((x) => x.id === id);
    if (a) {
      a.order_type = value;
      for (const l of a.lines) {
        const v = (item(l.item)?.variants || []).find((x) => x.order_type === value);
        if (v) l.variant = String(v.id);
      }
    }
  }
  render();
}

/* Presentation to the family ----------------------------------------------------------------- */

function present(on) {
  if (on === S.present) return;
  S.present = on;
  document.body.classList.toggle('presenting', on);
  if (on) {
    S.director = false; S.checkout = null; S.compare = false;
    document.title = H().name;
    const el = document.documentElement;
    try {
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) { const r = req.call(el); if (r && r.catch) r.catch(() => {}); }
    } catch (_) { /* the page still hides everything but the home */ }
    window.scrollTo(0, 0);
  } else {
    document.title = PAGE_TITLE;
    try {
      const fs = document.fullscreenElement || document.webkitFullscreenElement;
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (fs && exit) { const r = exit.call(document); if (r && r.catch) r.catch(() => {}); }
    } catch (_) { /* nothing to leave */ }
  }
  render();
  if (!on) $('#present')?.focus({ preventScroll: true });
}

function fullscreenChanged() {
  if (S.present && !(document.fullscreenElement || document.webkitFullscreenElement) && S.wasFull) present(false);
  S.wasFull = !!(document.fullscreenElement || document.webkitFullscreenElement);
}
document.addEventListener('fullscreenchange', fullscreenChanged);
document.addEventListener('webkitfullscreenchange', fullscreenChanged);

/* Cross-tenant check ------------------------------------------------------------------------- */

async function runCheck() {
  const btn = $('#run-check');
  const A = C.homes[S.checkFrom ?? S.home];
  const B = C.homes.find((h) => h.id !== A.id);
  const list = $('#checks');
  const who = $('#who-line');
  btn.disabled = true;
  list.innerHTML = '';
  who.textContent = 'Starting the database in this page.';
  const verdict = $('#verdict');
  verdict.hidden = true;
  let db;
  try { db = await ensureDb(); } catch (e) {
    who.textContent = `The in-page database did not start in this browser (${S.db.error}). The same checks run in the repository tests.`;
    btn.disabled = false;
    return;
  }
  const owner = await runAsService(db, OWNER_COUNT, [B.id]);
  const n = owner.rows ? owner.rows[0].n : '?';
  const dir = A.users.find((u) => u.label === 'Director');
  who.textContent = `Signed in as ${A.short}’s director. ${B.short} holds ${n} ${n === 1 ? 'arrangement' : 'arrangements'}, counted by the service role, which bypasses row level security.`;
  const checks = crossTenantChecks(A, B);
  list.innerHTML = checks.map((c) => `<li data-check="${c.id}"><span class="q">${esc(c.question)}</span><span class="a wait">running</span><code>${esc(c.sql.replace(/\$1/g, `'${c.params[0] || ''}'`))}${c.user.label === 'Arranger' ? '\n-- signed in as the arranger' : ''}</code></li>`).join('');
  const got = {};
  let allPass = true;
  for (const c of checks) {
    const r = await runAs(db, c.user, c.sql, c.params);
    const li = list.querySelector(`[data-check="${c.id}"] .a`);
    const ok = c.pass(r);
    allPass = allPass && ok;
    got[c.id] = r;
    li.className = 'a ' + (ok ? 'pass' : 'fail');
    li.textContent = (r.error && !ok ? 'error: ' + r.error : c.answer(r)) + (ok ? '' : ' (unexpected)');
  }
  // The answer to the question, from the rows the database returned above.
  const rowsRead = got.read.rows ? got.read.rows[0].n : '?';
  const rowsChanged = got.update.rows ? got.update.rows.length : '?';
  const rulesRead = got.rules.rows ? got.rules.rows[0].n : '?';
  const pricesRead = got.prices.error ? 0 : (got.prices.rows || []).filter((x) => x.cost_cents != null).length;
  verdict.innerHTML = `${allPass ? '<b>No.</b>' : '<b>Unexpected answer, see below.</b>'} ${esc(B.short)}’s arrangements read: ${rowsRead} rows. Changed: ${rowsChanged} rows. Its prices and pricing rules: ${Number(rulesRead) + pricesRead} rows.`;
  verdict.hidden = false;
  btn.disabled = false;
  S.checkFrom = C.homes.indexOf(B);
  btn.textContent = `Ask the other way, as ${B.short}`;
}

/* Events ------------------------------------------------------------------------------------ */

function go(delta) {
  const p = P();
  const n = room().items.length;
  p.idx = (p.idx + delta + n) % n;
  render();
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  const h = H();
  const p = P();
  switch (act) {
    case 'home':
      S.home = Number(t.dataset.i); S.compare = false; S.checkout = null; S.ruleError = null; S.arrError = null;
      if (S.db.status === 'ready') refreshHome(H()).then(render);
      resetCheckButton();
      break;
    case 'room': p.room = t.dataset.id; p.idx = 0; p.step = 'casket'; S.compare = false; break;
    case 'prev': go(-1); return;
    case 'next': go(1); return;
    case 'focus': p.idx = Number(t.dataset.i); break;
    case 'keep': {
      const id = Number(t.dataset.id);
      if (p.kept.includes(id)) p.kept = p.kept.filter((x) => x !== id);
      else { p.kept.push(id); if (p.kept.length > 3) p.kept.shift(); }
      break;
    }
    case 'compare': if (p.kept.length >= 2) S.compare = true; break;
    case 'close-compare': S.compare = false; break;
    case 'uncompare': p.kept = p.kept.filter((x) => x !== Number(t.dataset.id)); if (p.kept.length < 2) S.compare = false; break;
    case 'choose': p.casket = Number(t.dataset.id); p.step = 'lid_panel'; S.compare = false; p.saved = null; break;
    case 'step': {
      const s = t.dataset.step;
      if (s === 'casket' || p.casket) { p.step = s; S.compare = false; }
      break;
    }
    case 'chip': S.chip = t.dataset.c; break;
    case 'panel': p.panel = t.dataset.id === 'none' ? 'none' : Number(t.dataset.id); p.saved = null; break;
    case 'to-review': if (p.panel) p.step = 'review'; break;
    case 'save': save(); return;
    case 'new': S.per[h.id] = newSession(h, p.room); break;
    case 'director': S.director = !S.director; S.animate = S.director; if (S.director) ensureDb().catch(() => {}); break;
    case 'close-director': S.director = false; S.checkout = null; break;
    case 'as-arranger': S.as[h.id] = userOf(h).label === 'Arranger' ? 'Director' : 'Arranger'; S.checkout = null;
      if (S.db.status === 'ready') { refreshHome(h).then(render); }
      break;
    case 'checkout': S.checkout = S.checkout === t.dataset.id ? null : t.dataset.id; break;
    case 'leave-present': present(false); return;
    default: return;
  }
  render();
});

function resetCheckButton() {
  S.checkFrom = S.home;
  $('#run-check').textContent = 'Ask the database';
}

document.addEventListener('input', (e) => {
  const t = e.target;
  const h = H();
  if (!t.matches('[data-rule], [data-basis]')) return;
  const numeric = t.matches('[data-basis]') || t.dataset.f === 'value' || t.dataset.f === 'floor';
  if (numeric && t.value === '' && !(t.validity && t.validity.badInput)) return; // still typing
  const bad = numeric ? ruleFieldError(t) : null;
  if (bad) {
    // Refused before any write: the field goes back to the value in force and the director is told.
    const r = t.matches('[data-basis]') ? null : h.rules[Number(t.dataset.rule)];
    t.value = r ? String(Number(r[t.dataset.f])) : String(Number(h.wholesale_basis_pct));
    S.ruleError = bad;
    showRuleError();
    return;
  }
  if (S.ruleError) { S.ruleError = null; showRuleError(); }
  if (t.matches('[data-rule]')) {
    const r = h.rules[Number(t.dataset.rule)];
    const f = t.dataset.f;
    r[f] = f === 'value' || f === 'floor' ? Number(t.value) : t.value;
    if (f === 'kind' && Number(r.value) > BOUNDS[r.kind]) {
      r.value = BOUNDS[r.kind];
      S.ruleError = `The markup is capped at ${r.kind === 'percent' ? '1,000%' : '$100,000'}.`;
      render();
    }
  } else h.wholesale_basis_pct = Number(t.value);
  schedulePush();
  renderPartial();
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches('[data-ordertype]')) setOrderType(t.dataset.ordertype, t.value);
  else if (t.matches('[data-variant]')) { P().variantPick[Number(t.dataset.variant)] = Number(t.value); render(); }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (S.present && !S.compare) { present(false); return; }
    if (S.director) { S.director = false; S.checkout = null; render(); $('[data-k="dv"]')?.focus(); }
    else if (S.compare) { S.compare = false; render(); }
    return;
  }
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '')) return;
  if (!document.activeElement || !document.activeElement.closest('#app')) return;
  if (P().step === 'casket' && !S.compare && !S.director) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
  }
});

let sx = null;
document.addEventListener('pointerdown', (e) => { if (e.target.closest('[data-swipe]') && !e.target.closest('button')) sx = e.clientX; });
document.addEventListener('pointerup', (e) => {
  if (sx == null) return;
  const dx = e.clientX - sx;
  sx = null;
  if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
});

/* Start -------------------------------------------------------------------------------------- */

async function start() {
  C = await (await fetch('data/catalog.json')).json();
  for (const h of C.homes) {
    S.per[h.id] = newSession(h);
    S.local[h.id] = h.samples.map((s) => ({ id: s.id, family_label: 'Sample: ' + s.family, order_type: s.order_type,
      lines: s.lines.map((l, i) => ({ id: s.id + i, step: l.step, item: String(l.item), variant: String(l.variant), title: l.title, retail: item(l.item) ? retail(item(l.item), h) : l.retail })) }));
  }
  render();
  $('#run-check').addEventListener('click', runCheck);
  $('#present').addEventListener('click', () => present(true));
  const io = new IntersectionObserver((ents) => { if (ents.some((x) => x.isIntersecting)) { ensureDb().catch(() => {}); io.disconnect(); } }, { rootMargin: '300px' });
  io.observe($('#apart'));
}

start();

"""The page in real browsers (Chromium and WebKit, the engine of Safari on iPad).

Run: python tests/test_page.py <url> [--only g2,g3] [--shots DIR]   (Playwright for Python)
Every request to overnightcaskets.com is blocked and counted: the page must never open the
supplier link by itself, and the tests never open it either.
  --only g2,g3   runs only the checks of G2 (a Pre-Need-only casket saves and can be ordered) and
                 G3 (the director panel never overflows), which also run on the earlier page.
  --only i1,i5   runs only I1 (presentation reachable at every size) and I5 (no silent write).
  --shots DIR    saves screenshots: 1440, 390, iPad family, iPad director, presentation.
  --mutants      serves the page with each fix of I1 and I5 undone (route rewrite, nothing on disk)
                 and checks that the I1 / I5 checks fail on every one of them.
"""
import argparse
import asyncio
import re
import sys
from pathlib import Path

from playwright.async_api import async_playwright

ap = argparse.ArgumentParser()
ap.add_argument("url", nargs="?", default="http://127.0.0.1:8813/")
ap.add_argument("--only", default="")
ap.add_argument("--shots", default="")
ap.add_argument("--engines", default="chromium,webkit")
ap.add_argument("--mutants", action="store_true")
ARGS = ap.parse_args()
URL = ARGS.url
ONLY = set(filter(None, ARGS.only.split(",")))
SIZES = [(1440, 900), (1180, 820), (820, 1180), (390, 844), (1024, 768), (768, 1024)]
JACKSON_PRE_NEED = "50035105333441"
fails = []


def check(cond, msg):
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond:
        fails.append(msg)


async def small_targets(pg):
    return await pg.evaluate("""() => [...document.querySelectorAll('#app button, #app select, #app input, #app a')]
      .filter(e => e.offsetParent !== null)
      .map(e => { const r = e.getBoundingClientRect(); return [e.dataset.k || e.className || e.tagName, Math.round(r.width), Math.round(r.height)]; })
      .filter(([, w, h]) => w < 44 || h < 44)""")


async def new_page(browser, w, h, hits=None, patches=None):
    """patches: {file name: [(old, new), ...]} rewrites what the page receives (tests of I5 and the mutants)."""
    ctx = await browser.new_context(viewport={"width": w, "height": h}, has_touch=w < 1260, is_mobile=w < 600)
    pg = await ctx.new_page()
    pg.missing = []
    def rewriter(name, edits):
        async def rewrite(route):
            resp = await route.fetch()
            body = await resp.text()
            for old, new in edits:
                if old and old not in body:
                    pg.missing.append(f"MISSING in {name}: {old[:50]}")
                    continue
                body = body.replace(old, new) if old else body + new
            await route.fulfill(response=resp, body=body)
        return rewrite
    for name, edits in (patches or {}).items():
        await pg.route(re.compile(r".*/" + re.escape(name) + r"(\?.*)?$"), rewriter(name, edits))

    async def block(route):
        if hits is not None:
            hits.append(route.request.url)
        await route.abort()

    await pg.route(re.compile(r"https?://(www\.)?overnightcaskets\.com/.*"), block)
    await pg.goto(URL, wait_until="networkidle")
    return ctx, pg


async def director_fits(pg):
    """G3: the director panel and its content stay inside the window."""
    return await pg.evaluate("""() => {
      const d = document.querySelector('.director'), b = document.querySelector('.d-body');
      const r = d.getBoundingClientRect();
      return { body: [b.scrollWidth, b.clientWidth], left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth,
               page: document.documentElement.scrollWidth };
    }""")


async def g3_overflow(browser, engine):
    for w, h in SIZES[:4]:
        ctx, pg = await new_page(browser, w, h)
        await pg.click("[data-act=director]")
        await pg.wait_for_selector(".arr", timeout=90000)
        lind = pg.locator(".arr > li", has_text="Lindqvist")
        await lind.locator("[data-act=checkout]").click()
        await pg.wait_for_selector("[data-checkout]")
        f = await director_fits(pg)
        ok = f["body"][0] <= f["body"][1] + 1 and f["left"] >= -1 and f["right"] <= f["vw"] + 1 and f["page"] <= w
        check(ok, f"G3 {engine} {w}x{h}: director panel fits with a line left out of the link {f}")
        await ctx.close()


async def g2_pre_need_only(browser, engine):
    hits = []
    ctx, pg = await new_page(browser, 1180, 820, hits)
    await pg.click(".nameplate >> nth=1")
    await pg.locator(".room-tab", has_text=re.compile(r"^\s*Wood\s*$")).click()
    await pg.locator(".thumb", has_text="Jackson").click()
    await pg.click(".info [data-act=choose]")
    await pg.click("[data-act=panel][data-id=none]")
    await pg.click("[data-act=to-review]")
    await pg.click("[data-act=save]")
    await pg.wait_for_selector("[data-saved]", timeout=90000)
    await pg.click("[data-act=director]")
    await pg.wait_for_selector(".arr", timeout=90000)
    card = pg.locator(".arr > li", has_text="Whitfield")
    gone = await card.locator(".gone").count()
    check(gone == 0, f"G2 {engine}: the Pre-Need-only Jackson casket just saved is not marked unavailable ({gone})")
    await card.locator("[data-act=checkout]").click()
    url = await card.locator("[data-cart-url]").inner_text() if await card.locator("[data-cart-url]").count() else ""
    check(url == f"https://overnightcaskets.com/cart/{JACKSON_PRE_NEED}:1", f"G2 {engine}: its supplier link orders the Pre-Need variant ({url or 'no link'})")
    text = await card.inner_text()
    check("Order type: Pre-Need" in text, f"G2 {engine}: the arrangement records Pre-Need, with no Buy Now choice offered")
    check(not hits, f"G2 {engine}: no request to overnightcaskets.com ({hits[:1]})")
    await ctx.close()


async def flow(browser, engine):
    store_hits = []
    errors = []
    ctx, pg = await new_page(browser, 1180, 820, store_hits)
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    pg.on("popup", lambda p: store_hits.append("popup " + p.url))

    check(await pg.title() == "Your caskets, under a funeral home’s own name", f"{engine}: page title renamed")
    fam = await pg.inner_text("#app")
    check("overnight" not in fam.lower(), f"{engine}: the family view never names Overnight Caskets")
    check(not re.search(r"\b(add to cart|buy|shop|best seller|sale|discount)\b", fam, re.I), f"{engine}: family vocabulary has no shop words")
    first_price = await pg.inner_text("[data-price]")
    check(first_price == "$3,509.95", f"{engine}: Cambridge at Fennimore Hollis shows $3,509.95 ({first_price})")
    for sel in ("footer .call a", ".repo-line a"):
        t, rel = await pg.get_attribute(sel, "target"), await pg.get_attribute(sel, "rel")
        check(t == "_blank" and "noopener" in (rel or ""), f"{engine}: {sel} opens in a new tab with noopener")

    await pg.click("[data-act=keep]")
    check(await pg.get_attribute("[data-act=keep]", "aria-pressed") == "true", f"{engine}: Keep for comparison toggles on")
    await pg.click("[data-act=next]")
    name2 = await pg.inner_text(".pname")
    check("Presidential" in name2, f"{engine}: next shows the second casket ({name2})")
    await pg.click("[data-act=keep]")
    await pg.click("[data-act=compare]")
    cols = await pg.locator(".compare-table thead th").count()
    check(cols == 3, f"{engine}: comparison shows two caskets ({cols - 1})")
    rows = await pg.locator(".compare-table tbody th").all_inner_texts()
    check(rows == ["Material", "Exterior finish", "Interior", "Bed", "Sealed", "Exterior size"], f"{engine}: comparison rows, no construction or hardware prose ({rows})")
    await pg.click(".compare [data-act=choose] >> nth=0")
    check(await pg.locator(".panels").count() == 1, f"{engine}: choosing moves to the head panel step")
    check(not await pg.is_enabled("[data-act=to-review]"), f"{engine}: review waits for a panel choice")
    await pg.click("[data-act=chip][data-c=Blue]")
    blue = await pg.locator(".ptile").count()
    check(blue == 1 + 9, f"{engine}: Blue filter shows 9 blue panels plus No head panel ({blue - 1})")
    await pg.click(".ptile >> nth=1")
    await pg.click("[data-act=to-review]")
    total = await pg.inner_text(".lines tfoot .l-price")
    check(total == "$3,712.95", f"{engine}: review total $3,509.95 + $203.00 = {total}")
    await pg.click("[data-act=save]")
    await pg.wait_for_selector("[data-saved]", timeout=90000)
    check(True, f"{engine}: Save arrangement saved through the in-page database")

    await pg.click("[data-act=director]")
    await pg.wait_for_selector(".arr", timeout=90000)
    dv = await pg.inner_text(".director")
    check("Sample: Morales family" in dv and "Sample: Lindqvist family" in dv, f"{engine}: director lists this home's arrangements")
    check("Haddad" not in dv and "Okafor" not in dv, f"{engine}: director never lists the other home's arrangements")
    check("Not available in the catalog read on 24 Nov 2026" in dv and "no longer" not in dv.lower(), f"{engine}: the unavailable casket is marked in the words of the one catalog read")
    check("$2,899.99" in dv and "$1,594.99" in dv and "$1,914.96 (54.6%)" in dv, f"{engine}: ledger shows public, cost and margin")
    check("Illustrative wholesale cost" in dv and "Illustrative margin" in dv and "Illustrative cost" in dv, f"{engine}: cost and margin are called illustrative next to the amounts")
    check("struck-through" not in dv, f"{engine}: no sentence about the struck-through price")

    morales = pg.locator(".arr > li", has_text="Morales")
    await morales.locator("select").select_option("Pre-Need")
    await pg.wait_for_timeout(500)
    morales = pg.locator(".arr > li", has_text="Morales")
    await morales.locator("[data-act=checkout]").click()
    url = await pg.inner_text("[data-cart-url]")
    check(url.startswith("https://overnightcaskets.com/cart/50196452901057:1,"), f"{engine}: Pre-Need puts the Pre-Need variant in the link ({url})")
    href = await pg.get_attribute("a.open", "href")
    check(href == url, f"{engine}: the open link is exactly the link shown")
    check(await pg.inner_text("a.open") == "Open public checkout (public prices)", f"{engine}: the button says public checkout, public prices")
    check("Partner prices would come from the wholesale account" in await pg.inner_text("[data-checkout]"), f"{engine}: the line under it says partner prices come from the wholesale account")
    check(await pg.get_attribute("a.open", "target") == "_blank", f"{engine}: the store opens only on the director's click, in a new tab")
    lind = pg.locator(".arr > li", has_text="Lindqvist")
    check(await lind.locator("select").count() == 0, f"{engine}: no Buy Now / Pre-Need choice on a product without it")
    await lind.locator("[data-act=checkout]").click()
    lt = await lind.inner_text()
    check("left out of the link" in lt and "Nothing in this arrangement can be ordered" in lt, f"{engine}: an unavailable casket is left out of the link")
    f = await director_fits(pg)
    check(f["body"][0] <= f["body"][1] + 1, f"{engine}: G3 director panel does not overflow with a line left out ({f['body']})")

    await pg.fill("[data-k=r2-value]", "150")
    await pg.wait_for_timeout(200)
    await pg.click("[data-act=close-director]")
    await pg.click("[data-act=step][data-step=casket]")
    p2 = await pg.inner_text("[data-price]")
    check(p2 != "$3,509.95", f"{engine}: editing the Solid wood rule reprices the room ({p2})")

    await pg.click("[data-act=director]")
    await pg.click("[data-act=as-arranger]")
    await pg.wait_for_timeout(400)
    dv2 = await pg.inner_text(".director")
    check("Illustrative wholesale cost" not in dv2 and "Pricing rules" not in dv2 and "Prepare supplier order" not in dv2,
          f"{engine}: arranger preview hides cost, rules and supplier order")
    await pg.click("[data-act=as-arranger]")
    await pg.keyboard.press("Escape")

    await pg.click(".nameplate >> nth=1")
    brand = await pg.inner_text(".brand-name")
    check(brand.lower() == "calder ruiz", f"{engine}: switching homes changes the brand ({brand})")
    await pg.click("[data-act=director]")
    await pg.wait_for_selector(".arr", timeout=90000)
    dv3 = await pg.inner_text(".director")
    check("Haddad" in dv3 and "Morales" not in dv3 and "Lindqvist" not in dv3, f"{engine}: Calder Ruiz sees only its own arrangements")
    okafor = await pg.locator(".arr > li", has_text="Okafor").inner_text()
    check("Not in the catalog read on 24 Nov 2026" in okafor and "$2,450.00" in okafor, f"{engine}: C1 an arrangement with a model absent from the read shows, marked")
    await pg.keyboard.press("Escape")

    for _ in range(2):
        await pg.click("#run-check")
        await pg.wait_for_function("document.querySelectorAll('#checks .a.pass, #checks .a.fail').length === 11", timeout=90000)
        res = await pg.evaluate("[...document.querySelectorAll('#checks .a')].map(a => a.className)")
        verdict = await pg.inner_text("#verdict")
        check(all("pass" in c for c in res) and verdict.startswith("No."), f"{engine}: cross-tenant check, 11 of 11 as expected ({verdict})")
        prices = await pg.inner_text("[data-check=prices] .a")
        check("permission denied" in prices, f"{engine}: G1 the other home's prices are refused ({prices[:60]})")

    # C5: presentation to the family
    await pg.click(".nameplate >> nth=0")
    await pg.click("#present")
    await pg.wait_for_timeout(400)
    title = await pg.title()
    visible = await pg.evaluate("document.body.innerText")
    check(title == "Fennimore Hollis Funeral Home" and "overnight" not in title.lower(), f"{engine}: presentation titles the tab with the home's name ({title})")
    check("overnight" not in visible.lower(), f"{engine}: presentation shows no Overnight Caskets name anywhere")
    check(await pg.locator("[data-act=director]").count() == 0, f"{engine}: presentation hides Director view")
    box = await pg.evaluate("(() => { const r = document.querySelector('#app').getBoundingClientRect(); return [r.left, r.top, r.width, r.height, innerWidth, innerHeight]; })()")
    check(abs(box[2] - box[4]) <= 1 and abs(box[3] - box[5]) <= 1 and box[0] == 0 and box[1] == 0, f"{engine}: the home fills the window ({box})")
    await pg.click("[data-act=leave-present]")
    await pg.wait_for_timeout(300)
    check(await pg.title() == "Your caskets, under a funeral home’s own name" and await pg.locator("#apart").is_visible(), f"{engine}: the corner button leaves the presentation")

    check(not store_hits, f"{engine}: no request to overnightcaskets.com was made ({store_hits[:2]})")
    check(not errors, f"{engine}: no page errors ({errors[:2]})")
    await ctx.close()


async def layout(browser, engine):
    for w, h in SIZES:
        ctx, pg = await new_page(browser, w, h)
        for state in ("casket", "compare", "panels", "review", "director", "checkout"):
            if state == "compare":
                await pg.click("[data-act=keep]"); await pg.click("[data-act=next]"); await pg.click("[data-act=keep]"); await pg.click("[data-act=compare]")
            if state == "panels":
                await pg.click(".compare [data-act=choose] >> nth=0")
            if state == "review":
                await pg.click(".ptile >> nth=0"); await pg.click("[data-act=to-review]")
            if state == "director":
                await pg.click("[data-act=director]")
                await pg.wait_for_selector(".arr", timeout=90000)
            if state == "checkout":
                await pg.locator(".arr > li", has_text="Lindqvist").locator("[data-act=checkout]").click()
                f = await director_fits(pg)
                check(f["body"][0] <= f["body"][1] + 1 and f["left"] >= -1 and f["right"] <= f["vw"] + 1, f"{engine} {w}x{h} checkout: G3 director panel fits {f}")
            sw = await pg.evaluate("document.documentElement.scrollWidth")
            check(sw <= w, f"{engine} {w}x{h} {state}: no horizontal scroll ({sw})")
            small = await small_targets(pg)
            check(not small, f"{engine} {w}x{h} {state}: touch targets at least 44 px {small[:3]}")
        framed = await pg.evaluate("getComputedStyle(document.querySelector('.device')).paddingTop")
        if w < 1260:
            check(framed == "0px", f"{engine} {w}x{h}: no drawn iPad frame on a tablet or phone")
        await ctx.close()


# I1: in presentation, every command of the family session is visible, uncovered and clickable at
# every size, and no two texts overlap; what does not fit scrolls with the wheel or a finger.
PRES_SIZES = [(390, 844), (430, 932), (600, 900), (844, 390), (932, 430), (820, 1180), (1180, 820), (1440, 900)]

WHERE_JS = """(sel) => { const e = document.querySelector(sel); if (!e) return 'missing';
  const b = e.getBoundingClientRect();
  if (b.width < 1 || b.height < 1) return 'hidden';
  if (b.bottom > innerHeight - 1) return ['below', Math.min(220, Math.ceil(b.bottom - innerHeight + 12))];
  if (b.top < 1) return ['above', Math.max(-220, Math.floor(b.top - 12))];
  return 'in'; }"""

REACH_JS = """(sel) => { const e = document.querySelector(sel); if (!e) return 'missing';
  const b = e.getBoundingClientRect();
  if (b.width < 1 || b.height < 1) return 'hidden';
  if (b.top < -1 || b.left < -1 || b.bottom > innerHeight + 1 || b.right > innerWidth + 1)
    return 'off-screen (top ' + Math.round(b.top) + ', bottom ' + Math.round(b.bottom) + ', window ' + innerHeight + ')';
  const t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
  return t && (t === e || e.contains(t)) ? 'ok' : 'covered by ' + (t ? (t.className || t.tagName) : 'nothing'); }"""

OVERLAP_JS = """(scope) => {
  const root = document.querySelector(scope); if (!root) return ['no ' + scope];
  const clip = (el) => { const r = el.getBoundingClientRect(); let x1 = r.left, y1 = r.top, x2 = r.right, y2 = r.bottom;
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') { const q = p.getBoundingClientRect();
        x1 = Math.max(x1, q.left); y1 = Math.max(y1, q.top); x2 = Math.min(x2, q.right); y2 = Math.min(y2, q.bottom); } }
    return [x1, y1, x2, y2]; };
  const own = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  const R = [...root.querySelectorAll('*')].filter((el) => own(el) && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
    .map((el) => [el, clip(el)]).filter(([, r]) => r[2] - r[0] > 1 && r[3] - r[1] > 1);
  const out = [];
  for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) {
    const [a, ra] = R[i], [b, rb] = R[j];
    if (a.contains(b) || b.contains(a)) continue;
    const w = Math.min(ra[2], rb[2]) - Math.max(ra[0], rb[0]), h = Math.min(ra[3], rb[3]) - Math.max(ra[1], rb[1]);
    if (w > 2 && h > 2) out.push(`"${a.textContent.trim().slice(0, 24)}" / "${b.textContent.trim().slice(0, 24)}"`);
  }
  return out.slice(0, 3); }"""


# Mobile WebKit has no wheel in Playwright: there a finger's scroll is played on the nearest box a
# person can scroll (overflow auto or scroll, or the page when it is not locked), never on a box
# whose overflow is hidden.
FINGER_JS = """([sel, dy]) => { const e = document.querySelector(sel);
  for (let p = e.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight + 1) {
      const b = p.scrollTop; p.scrollTop += dy; if (p.scrollTop !== b) return 'box'; } }
  if (getComputedStyle(document.body).overflowY !== 'hidden' && getComputedStyle(document.documentElement).overflowY !== 'hidden') {
    const se = document.scrollingElement, b = se.scrollTop; se.scrollTop += dy; if (se.scrollTop !== b) return 'page'; }
  return 'nothing'; }"""


async def bring_into_view(pg, sel):
    """Scrolls as a person would, with the wheel over the middle of the window, until sel is in view."""
    vw, vh = await pg.evaluate("[innerWidth, innerHeight]")
    for _ in range(40):
        where = await pg.evaluate(WHERE_JS, sel)
        if not isinstance(where, list):
            return
        dy = where[1]
        try:
            await pg.mouse.move(vw * 0.5, vh * 0.5)
            await pg.mouse.wheel(0, dy)
        except Exception:
            if await pg.evaluate(FINGER_JS, [sel, dy]) == "nothing":
                return
        await pg.wait_for_timeout(90)


async def i1_presentation(browser, engine, sizes=PRES_SIZES, patches=None):
    fails_here = []
    for w, h in sizes:
        ctx, pg = await new_page(browser, w, h, patches=patches)
        tag = f"I1 {engine} {w}x{h}"
        problems = []

        async def reach(sel, label):
            await bring_into_view(pg, sel)
            r = await pg.evaluate(REACH_JS, sel)
            if r != "ok":
                problems.append(f"{label}: {r}")
            return r == "ok"

        async def press(sel, label):
            if await reach(sel, label):
                await pg.click(sel, timeout=4000)
            else:
                await pg.eval_on_selector(sel, "e => e.click()")

        async def overlap(scope, state):
            o = await pg.evaluate(OVERLAP_JS, scope)
            if o:
                problems.append(f"{state}: texts overlap {o}")

        await pg.click("#present")
        await pg.wait_for_timeout(400)
        await overlap("#app", "casket")
        await reach(".info [data-act=choose]", "Choose this casket")
        await reach(".leave", "Leave")
        await press("[data-act=keep]", "Keep for comparison")
        if await pg.get_attribute("[data-act=keep]", "aria-pressed") != "true":
            problems.append("Keep did not toggle")
        await press("[data-act=next]", "Next casket")
        await press("[data-act=keep]", "Keep the second casket")
        await press("[data-act=compare]", "Compare side by side")
        if not await pg.locator(".compare").count():
            problems.append("Compare did not open")
        else:
            await overlap(".compare", "compare")
            await reach("[data-act=close-compare]", "Back to the room")
            await press(".compare [data-act=choose]", "Choose, in the comparison")
        if not await pg.locator(".panels").count():
            problems.append("choosing did not reach the head panel step")
        else:
            await overlap("#app", "panels")
            await reach("[data-act=step][data-step=casket]", "Casket step")
            await press(".panel-grid li:nth-child(2) .ptile", "A head panel")
            await press("[data-act=to-review]", "Continue to review")
        if not await pg.locator(".review").count():
            problems.append("the review step was not reached")
        else:
            await overlap("#app", "review")
            await press("[data-act=save]", "Save arrangement")
            try:
                await pg.wait_for_selector("[data-saved]", timeout=90000)
            except Exception:
                problems.append("Save arrangement did not save")
        await press(".leave", "Leave")
        await pg.wait_for_timeout(300)
        if await pg.evaluate("document.body.classList.contains('presenting')"):
            problems.append("Leave did not leave the presentation")
        problems += pg.missing
        msg = f"{tag}: every family command visible, uncovered, clickable; no text over another {problems[:4]}"
        if problems:
            fails_here.append(msg)
        await ctx.close()
    return fails_here


# I5: no write fails in silence. The page refuses a markup out of bounds before writing it, the
# database refuses it too, and any refusal of the database is said to the director, with the screen
# back on the value the database holds.
RULE_SEL = "[data-k=r2-value]"   # Fennimore Hollis, Solid wood: cost + 120%, Cambridge Solid Mahogany $3,509.95
REFUSE_ALL = """
create function app.refuse_for_test() returns trigger language plpgsql as $$
begin raise exception 'refused for the test'; end $$;
create trigger zz_refuse before update on public.pricing_rules for each row execute function app.refuse_for_test();
create trigger zz_refuse before update on public.arrangements for each row execute function app.refuse_for_test();
"""
NO_CLIENT_BOUND = ("const bad = numeric ? ruleFieldError(t) : null;", "const bad = null;")


async def open_rules(pg):
    await pg.click("[data-act=director]")
    await pg.wait_for_selector(".arr", timeout=90000)


async def i5_case(browser, engine, label, patches, value, want_refusal=True):
    problems = []
    ctx, pg = await new_page(browser, 1180, 820, patches=patches)
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    await open_rules(pg)
    await pg.fill(RULE_SEL, value)
    await pg.wait_for_timeout(900)
    msg = await pg.locator("[data-rule-error]").inner_text() if await pg.locator("[data-rule-error]").count() else ""
    if want_refusal and "Not saved" not in msg:
        problems.append(f"no refusal shown ({msg!r})")
    field = await pg.input_value(RULE_SEL)
    if field != "120":
        problems.append(f"the field shows {field}, the database holds 120")
    await pg.click("[data-act=close-director]")
    price = await pg.inner_text("[data-price]")
    if price != "$3,509.95":
        problems.append(f"the family sees {price}, the database prices $3,509.95")
    # what the family is shown is what the database saves
    await pg.click(".info [data-act=choose]")
    await pg.click("[data-act=panel][data-id=none]")
    await pg.click("[data-act=to-review]")
    shown = await pg.inner_text(".lines tfoot .l-price")
    await pg.click("[data-act=save]")
    await pg.wait_for_selector("[data-saved], [data-save-error]", timeout=90000)
    await open_rules(pg)
    card = pg.locator(".arr > li", has_text="Morales")
    saved = await card.locator(".a-top span").inner_text() if await card.count() else "nothing"
    if saved != shown:
        problems.append(f"the review showed {shown}, the database saved {saved}")
    if errors:
        problems.append(f"page errors {errors[:1]}")
    problems += pg.missing
    await ctx.close()
    return [f"I5 {engine} {label}: {p}" for p in problems]


async def i5_order_type(browser, engine, patches):
    """The database refuses every update: the order type change must be said and undone on screen."""
    problems = []
    ctx, pg = await new_page(browser, 1180, 820, patches=patches)
    await pg.click(".info [data-act=choose]")
    await pg.click("[data-act=panel][data-id=none]")
    await pg.click("[data-act=to-review]")
    await pg.click("[data-act=save]")
    await pg.wait_for_selector("[data-saved]", timeout=90000)
    await open_rules(pg)
    card = pg.locator(".arr > li", has_text="Morales")
    await card.locator("select").select_option("Pre-Need")
    await pg.wait_for_timeout(700)
    card = pg.locator(".arr > li", has_text="Morales")
    shown = await card.locator("select").input_value()
    if shown != "Buy Now":
        problems.append(f"the select shows {shown}, the database holds Buy Now")
    err = await card.locator("[data-arr-error]").inner_text() if await card.locator("[data-arr-error]").count() else ""
    if "Not changed" not in err:
        problems.append(f"no refusal shown on the arrangement ({err!r})")
    problems += pg.missing
    await ctx.close()
    return [f"I5 {engine} order type refused: {p}" for p in problems]


async def i5_all(browser, engine, extra=None):
    """extra: patches applied on top of each case (the mutants)."""
    def merge(base):
        out = {k: list(v) for k, v in (base or {}).items()}
        for k, v in (extra or {}).items():
            out.setdefault(k, []).extend(v)
        return out
    out = []
    out += await i5_case(browser, engine, "100000000% refused by the page", merge(None), "100000000")
    out += await i5_case(browser, engine, "1.005% refused by the page", merge(None), "1.005")
    out += await i5_case(browser, engine, "100000000% with the page's bound removed, refused by the database",
                         merge({"app.js": [NO_CLIENT_BOUND]}), "100000000")
    out += await i5_case(browser, engine, "150% refused by the database", merge({"migration.sql": [("", REFUSE_ALL)]}), "150")
    out += await i5_order_type(browser, engine, merge({"migration.sql": [("", REFUSE_ALL)]}))
    return out


# Each one undoes one fix of I1 or I5 in what the browser receives; the checks above must fail.
PAGE_MUTANTS = [
    ("I1: presentation keeps the fixed iPad layout on a phone", "i1", {"styles.css": [("@media (max-width: 699px), (max-height: 699px) {", "@media (max-width: 1px) and (max-height: 1px) {")]}),
    ("I5: rule write errors ignored", "i5db", {"app.js": [("if (failed) {", "if (false) {")]}),
    ("I5: order type errors ignored", "i5ot", {"app.js": [("if (refused) {", "if (false) {")]}),
    ("I5: the page's own bound removed, database bound removed", "i5both", {"app.js": [NO_CLIENT_BOUND],
        "migration.sql": [("constraint markup_bounds check", "constraint markup_bounds_gone check (true or")]}),
]


async def page_mutants(browser, engine):
    caught = 0
    for name, kind, patch in PAGE_MUTANTS:
        try:
            if kind == "i1":
                by = await i1_presentation(browser, engine, sizes=[(390, 844), (844, 390)], patches=patch)
            elif kind == "i5db":
                by = await i5_case(browser, engine, "mutant", {**patch, "migration.sql": [("", REFUSE_ALL)]}, "150")
            elif kind == "i5ot":
                by = await i5_order_type(browser, engine, {**patch, "migration.sql": [("", REFUSE_ALL)]})
            else:
                by = await i5_case(browser, engine, "mutant", patch, "100000000")
        except Exception as e:  # a mutant that breaks the flow is caught, unless its patch did not apply
            by = [f"flow broke: {str(e)[:120]}"]
        missing = any("MISSING" in b for b in by)
        ok = bool(by) and not missing
        caught += ok
        print(("caught   " if ok else "SURVIVED ") + f"{engine} {name}" + (f" (by {by[0][:150]})" if by else ""))
        if not ok:
            fails.append(f"page mutant survived: {engine} {name}")
    print(f"{caught} of {len(PAGE_MUTANTS)} page mutants caught ({engine})")


async def shots(browser, out):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    ctx, pg = await new_page(browser, 1440, 900)
    await pg.wait_for_timeout(800)
    await pg.screenshot(path=str(out / "osr_1440_fold.png"))
    await pg.click("#run-check")
    await pg.wait_for_function("document.querySelectorAll('#checks .a.pass, #checks .a.fail').length === 11", timeout=90000)
    await pg.evaluate("document.querySelector('#apart').scrollIntoView()")
    await pg.wait_for_timeout(300)
    await pg.screenshot(path=str(out / "osr_1440_section2.png"))
    await ctx.close()
    ctx, pg = await new_page(browser, 390, 844)
    await pg.wait_for_timeout(800)
    await pg.screenshot(path=str(out / "osr_390_fold.png"))
    await ctx.close()
    ctx, pg = await new_page(browser, 1180, 820)
    await pg.evaluate("document.querySelector('#app').scrollIntoView()")
    await pg.wait_for_timeout(800)
    await pg.screenshot(path=str(out / "osr_ipad_famille.png"))
    await pg.click("[data-act=director]")
    await pg.wait_for_selector(".arr", timeout=90000)
    await pg.locator(".arr > li", has_text="Lindqvist").locator("[data-act=checkout]").click()
    await pg.evaluate("document.querySelector('#app').scrollIntoView()")
    await pg.wait_for_timeout(400)
    await pg.screenshot(path=str(out / "osr_ipad_directeur.png"))
    await pg.keyboard.press("Escape")
    await pg.click(".nameplate >> nth=1")
    await pg.click("#present")
    await pg.wait_for_timeout(800)
    await pg.screenshot(path=str(out / "osr_presentation.png"))
    await ctx.close()
    print("screenshots in", out)


async def main():
    async with async_playwright() as p:
        for name in ARGS.engines.split(","):
            b = await getattr(p, name).launch()
            if ARGS.mutants:
                await page_mutants(b, name)
                await b.close()
                continue
            if ONLY:
                if "i1" in ONLY:
                    for m in await i1_presentation(b, name):
                        check(False, m)
                    check(True, f"I1 {name}: presentation checked at {len(PRES_SIZES)} sizes")
                if "i5" in ONLY:
                    for m in await i5_all(b, name):
                        check(False, m)
                    check(True, f"I5 {name}: refusals checked")
                if "g2" in ONLY:
                    await g2_pre_need_only(b, name)
                if "g3" in ONLY:
                    await g3_overflow(b, name)
            else:
                await flow(b, name)
                await g2_pre_need_only(b, name)
                await layout(b, name)
                i1 = await i1_presentation(b, name)
                for m in i1:
                    check(False, m)
                check(not i1, f"I1 {name}: presentation reachable at {len(PRES_SIZES)} sizes")
                i5 = await i5_all(b, name)
                for m in i5:
                    check(False, m)
                check(not i5, f"I5 {name}: no silent write (bounds on the page and in the database, refusals shown and undone)")
            if ARGS.shots and name == "webkit":
                await shots(b, ARGS.shots)
            await b.close()
    print(f"\n{'FAILED: ' + str(len(fails)) if fails else 'all page checks passed'}")
    sys.exit(1 if fails else 0)


asyncio.run(main())

// Run: node --test tests/   (Node 20+, no dependencies)
import test from "node:test";
import assert from "node:assert/strict";
import {
  setProducts, validatePlan, estimateCommission, payoutPercent, PRODUCTS, fmt, toHundredths, itemsFromSelection, creditsOf, cycleKey, cycleStart, cycleEnd,
  cycleTotals, emptyState, ensureCycle, validateState, attainment, nextMilestone,
} from "../core.js";

// Synthetic sample plan: made-up products and numbers. No real plan values live in this repo.
const SAMPLE = {
  plan_version: 1, name: "sample",
  products: [
    { id: "a", name: "Alpha", bucket: "m1", unit: 125 }, { id: "b", name: "Bravo", bucket: "m1", unit: 50 },
    { id: "c", name: "Charlie", bucket: "m2", unit: 100 }, { id: "d", name: "Delta", bucket: "m3", unit: 100 },
    { id: "e", name: "Echo", bucket: "m3", unit: 25 }, { id: "f", name: "Foxtrot", bucket: "m1", unit: 25 },
  ],
  tic_share: { m1: 50, m2: 25, m3: 25 },
  curves: {
    m1: { points: [[0, 0], [50, 25], [100, 100]], tail_slope: 2 },
    m2: { points: [[0, 0], [50, 25], [100, 100]], tail_slope: 2 },
    m3: { points: [[0, 0], [100, 100]], tail_slope: 1 },
  },
};
setProducts(SAMPLE.products);

const impact = (sel) => {
  const c = creditsOf(itemsFromSelection(sel));
  return `M1 +${fmt(c.m1)} | M2 +${fmt(c.m2)} | M3 +${fmt(c.m3)}`;
};

test("credit arithmetic from the loaded plan", () => {
  assert.equal(impact({ a: 1 }), "M1 +1.25 | M2 +0.00 | M3 +0.00");
  assert.equal(impact({ a: 1, c: 1 }), "M1 +1.25 | M2 +1.00 | M3 +0.00");
  assert.equal(impact({ a: 3 }), "M1 +3.75 | M2 +0.00 | M3 +0.00");
  assert.equal(impact({ b: 2 }), "M1 +1.00 | M2 +0.00 | M3 +0.00");
  assert.equal(impact({ e: 4 }), "M1 +0.00 | M2 +0.00 | M3 +1.00");
  assert.equal(PRODUCTS.length, 6);
});

test("plan validation rejects malformed plans", () => {
  assert.equal(validatePlan(SAMPLE), null);
  assert.ok(validatePlan({ ...SAMPLE, plan_version: 2 }));
  assert.ok(validatePlan({ ...SAMPLE, products: [{ id: "x", name: "X", bucket: "m9", unit: 1 }] }));
  assert.ok(validatePlan({ ...SAMPLE, tic_share: { m1: 50, m2: 25, m3: 20 } }));
  assert.ok(validatePlan({ ...SAMPLE, curves: { ...SAMPLE.curves, m3: { points: [[0, 0], [0, 5]], tail_slope: 1 } } }));
});

test("payout curve: interpolates, then follows the tail slope", () => {
  assert.equal(payoutPercent(SAMPLE.curves.m1, 25), 12.5);
  assert.equal(payoutPercent(SAMPLE.curves.m1, 75), 62.5);
  assert.equal(payoutPercent(SAMPLE.curves.m1, 120), 140);
  assert.equal(payoutPercent(SAMPLE.curves.m3, 130), 130);
});

test("estimate: TIC x share x curve(attainment + PTO), rounded like a statement", () => {
  const totals = { total: { m1: 2500, m2: 500, m3: 1000 }, targets: { m1: 5000, m2: 1000, m3: 1000 } };
  const e = estimateCommission(totals, SAMPLE, { tic: 1000, pto: 10 });
  assert.deepEqual([e.rows.m1.achievement, e.rows.m1.payout, e.rows.m1.earnings], [60, 40, 200]);
  assert.deepEqual([e.rows.m3.achievement, e.rows.m3.payout, e.rows.m3.earnings], [110, 110, 275]);
  assert.equal(e.total, 200 + 100 + 275);
  assert.equal(estimateCommission(totals, SAMPLE, { tic: 0 }), null);
  assert.equal(estimateCommission({ ...totals, targets: null }, SAMPLE, { tic: 1000 }), null);
});

test("fractional credits never drift (40 x 0.25 = exactly 10.00)", () => {
  assert.equal(fmt(creditsOf(itemsFromSelection({ f: 40 })).m1), "10.00");
  assert.equal(toHundredths("42.5"), 4250);
  assert.equal(toHundredths("12.75"), 1275);
  assert.equal(toHundredths("1.255"), null);
  assert.equal(toHundredths("-1"), null);
});

test("cycle boundaries: Nov 21 -> Nov 22, and December -> January", () => {
  assert.equal(cycleKey(new Date(2026, 10, 21, 23, 59, 59)), "2026-10-22");
  assert.equal(cycleKey(new Date(2026, 10, 22, 0, 0, 0)), "2026-11-22");
  assert.equal(cycleKey(new Date(2026, 11, 22, 0, 0)), "2026-12-22");
  assert.equal(cycleKey(new Date(2027, 0, 21, 12, 0)), "2026-12-22");
  assert.equal(cycleKey(new Date(2027, 0, 22, 0, 0)), "2027-01-22");
  const s = cycleStart(new Date(2026, 11, 30));
  assert.equal(cycleEnd(s).getTime(), new Date(2027, 0, 22).getTime());
});

function sale(id, date, sel, extra = {}) {
  return { id, saleDate: date.toISOString(), createdAt: date.toISOString(), items: itemsFromSelection(sel), ref: "", deletedAt: null, history: [], ...extra };
}

test("new cycle starts at zero; old cycle keeps its data", () => {
  const st = emptyState();
  st.sales.push(sale("a", new Date(2026, 10, 21, 18), { a: 1 }));
  st.sales.push(sale("b", new Date(2026, 10, 22, 9), { c: 1 }));
  assert.equal(cycleTotals(st, "2026-10-22").total.m1, 125);
  const nov = cycleTotals(st, "2026-11-22");
  assert.deepEqual(nov.total, { m1: 0, m2: 100, m3: 0 });
});

test("starting credits plus every sale in the cycle (no double-counting, nothing skipped)", () => {
  const st = emptyState();
  st.cycles["2026-10-22"] = { targets: { m1: 5750, m2: 2500, m3: 1875 }, snapshot: { m1: 1100, m2: 1200, m3: 300 } };
  st.sales.push(sale("a", new Date(2026, 10, 6, 13), { a: 1, c: 1 }));
  st.sales.push(sale("b", new Date(2026, 10, 7, 10), { d: 1 }));
  const t = cycleTotals(st, "2026-10-22");
  assert.deepEqual(t.total, { m1: 1225, m2: 1300, m3: 400 });
  assert.equal(attainment(t.total.m1, 5750), 21.3);
});

test("delete removes credits; undo restores them once", () => {
  const st = emptyState();
  const s = sale("x", new Date(2026, 10, 10), { d: 1 });
  st.sales.push(s);
  s.deletedAt = new Date().toISOString();
  assert.equal(cycleTotals(st, "2026-10-22").total.m3, 0);
  s.deletedAt = null;
  assert.equal(cycleTotals(st, "2026-10-22").total.m3, 100);
  assert.equal(st.sales.length, 1);
});

test("editing quantity or product recalculates; backdating moves the sale to its cycle", () => {
  const st = emptyState();
  const s = sale("e", new Date(2026, 10, 10), { a: 1 });
  st.sales.push(s);
  s.items = itemsFromSelection({ a: 2, d: 1 });
  assert.deepEqual(cycleTotals(st, "2026-10-22").total, { m1: 250, m2: 0, m3: 100 });
  s.saleDate = new Date(2026, 9, 3).toISOString(); // Oct 3 -> Sep 22 cycle
  assert.equal(cycleTotals(st, "2026-10-22").count, 0);
  assert.equal(cycleTotals(st, "2026-09-22").total.m1, 250);
});

test("new cycle carries targets forward as unconfirmed, never credits", () => {
  const st = emptyState();
  st.cycles["2026-10-22"] = { targets: { m1: 5750, m2: 2500, m3: 1875 }, targetsConfirmed: true, snapshot: { m1: 1100, m2: 1200, m3: 250 } };
  const c = ensureCycle(st, "2026-11-22");
  assert.deepEqual(c.targets, { m1: 5750, m2: 2500, m3: 1875 });
  assert.equal(c.targetsConfirmed, false);
  assert.equal(c.snapshot, undefined);
  assert.deepEqual(cycleTotals(st, "2026-11-22").total, { m1: 0, m2: 0, m3: 0 });
});

test("next milestone picks the closest unreached 25% step", () => {
  const st = emptyState();
  st.cycles["2026-10-22"] = { targets: { m1: 5750, m2: 2500, m3: 1875 }, snapshot: { m1: 1100, m2: 1200, m3: 250 } };
  const m = nextMilestone(cycleTotals(st, "2026-10-22"));
  assert.deepEqual([m.bucket, m.pct, m.gap], ["m2", 50, 50]); // 12.00 -> 12.50
});

test("restore validation accepts a good backup and rejects malformed ones", () => {
  const st = emptyState();
  st.sales.push(sale("ok", new Date(2026, 10, 10), { a: 1 }));
  st.cycles["2026-10-22"] = { targets: { m1: 5750, m2: 2500, m3: 1875 } };
  assert.equal(validateState(JSON.parse(JSON.stringify(st))), null);
  const bad = (mut) => { const c = JSON.parse(JSON.stringify(st)); mut(c); return validateState(c); };
  assert.ok(bad((c) => { c.version = 2; }));
  assert.ok(bad((c) => { c.sales[0].items[0].qty = 0; }));
  assert.ok(bad((c) => { c.sales[0].items[0].bucket = "m4"; }));
  assert.ok(bad((c) => { c.sales[0].saleDate = "soon"; }));
  assert.ok(bad((c) => { c.sales.push({ ...c.sales[0] }); }));
  assert.ok(bad((c) => { c.cycles["2026-10-21"] = {}; }));
  assert.ok(validateState("not json"));
});

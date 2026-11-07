// Pure logic: products, credit math, commission cycles, totals, validation.
// No DOM here, so it runs in the browser and under `node --test`.
// Credits are stored as integer hundredths (1.25 -> 125) so fractions never drift.

// No products, credits or pay rules live in this file. They come from the plan file the user loads
// (kept private, on the device). See validatePlan() for its shape.
export let PRODUCTS = [];
export function setProducts(list) { PRODUCTS = list; }

export const BUCKETS = ["m1", "m2", "m3"];
export const MAX_QTY = 99;

export function fmt(hundredths) {
  const sign = hundredths < 0 ? "-" : "";
  const v = Math.abs(hundredths);
  return `${sign}${Math.floor(v / 100)}.${String(v % 100).padStart(2, "0")}`;
}

export function toHundredths(value) {
  // "57.5" -> 5750. Rejects anything that is not a plain non-negative number with <= 2 decimals.
  const s = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

// Items saved on a sale carry their own name/bucket/unit, so a later change to the product
// list never rewrites history.
export function itemsFromSelection(selection, products = PRODUCTS) {
  const out = [];
  for (const p of products) {
    const qty = selection[p.id] || 0;
    if (qty > 0) out.push({ id: p.id, name: p.name, bucket: p.bucket, unit: p.unit, qty });
  }
  return out;
}

export function creditsOf(items) {
  const c = { m1: 0, m2: 0, m3: 0 };
  for (const it of items) c[it.bucket] += it.unit * it.qty;
  return c;
}

// ---- cycles: 00:00 local on the 22nd through the end of the 21st ----
export function cycleStart(date) {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = d.getMonth();
  return d.getDate() >= 22 ? new Date(y, m, 22) : new Date(y, m - 1, 22);
}

export function cycleEnd(start) {
  // exclusive end: 00:00 on the next 22nd
  return new Date(start.getFullYear(), start.getMonth() + 1, 22);
}

export function cycleKey(date) {
  const s = cycleStart(date);
  return `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, "0")}-22`;
}

export function keyToStart(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 22);
}

export function cycleLabel(key) {
  const s = keyToStart(key);
  const last = new Date(cycleEnd(s).getTime() - 1);
  const o = { month: "short", day: "numeric" };
  const yr = s.getFullYear() !== last.getFullYear() ? { ...o, year: "numeric" } : o;
  return `${s.toLocaleDateString("en-US", yr)} – ${last.toLocaleDateString("en-US", { ...o, year: "numeric" })}`;
}

export function liveSales(state) {
  return state.sales.filter((s) => !s.deletedAt);
}

// Totals for one cycle: the starting credits you typed in (if any) plus every sale logged in it.
export function cycleTotals(state, key) {
  const cyc = state.cycles[key] || {};
  const start = cyc.snapshot || null; // "starting credits"; field name kept for saved data
  const logged = { m1: 0, m2: 0, m3: 0 };
  let count = 0;
  for (const s of liveSales(state)) {
    if (cycleKey(s.saleDate) !== key) continue;
    count++;
    const c = creditsOf(s.items);
    for (const b of BUCKETS) logged[b] += c[b];
  }
  const base = start ? { m1: start.m1, m2: start.m2, m3: start.m3 } : { m1: 0, m2: 0, m3: 0 };
  const total = {};
  for (const b of BUCKETS) total[b] = base[b] + logged[b];
  return { base, logged, total, count, start, targets: cyc.targets || null };
}

export function attainment(total, target) {
  if (!target) return null;
  return Math.round((total / target) * 10000) / 100; // percent, 2 dp
}

export function nextMilestone(totals) {
  // nearest 25/50/75/100% step not yet reached, across buckets with targets
  let best = null;
  for (const b of BUCKETS) {
    const t = totals.targets?.[b];
    if (!t) continue;
    for (const pct of [25, 50, 75, 100]) {
      const need = Math.ceil((t * pct) / 100);
      if (totals.total[b] < need) {
        const gap = need - totals.total[b];
        if (!best || gap < best.gap) best = { bucket: b, pct, need, gap };
        break;
      }
    }
  }
  return best;
}

export function emptyState() {
  return { version: 1, sales: [], cycles: {}, createdAt: new Date().toISOString() };
}

// Targets carry forward to a new cycle as UNCONFIRMED defaults; credits never carry forward.
export function ensureCycle(state, key) {
  if (state.cycles[key]) return state.cycles[key];
  const prior = Object.keys(state.cycles).filter((k) => k < key && state.cycles[k].targets).sort().pop();
  state.cycles[key] = prior
    ? { targets: { ...state.cycles[prior].targets }, targetsConfirmed: false }
    : { targets: null, targetsConfirmed: false };
  return state.cycles[key];
}

// ---- import validation: reject the whole file on the first problem ----
const ISO = (v) => typeof v === "string" && !Number.isNaN(new Date(v).getTime());
const INT = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

export function validateState(obj) {
  if (!obj || typeof obj !== "object") return "File is not a tracker backup.";
  if (obj.version !== 1) return "Unknown backup version.";
  if (!Array.isArray(obj.sales)) return "Backup has no sales list.";
  if (!obj.cycles || typeof obj.cycles !== "object") return "Backup has no cycles.";
  if (obj.plan != null && validatePlan(obj.plan)) return "Backup plan: " + validatePlan(obj.plan);
  const ids = new Set();
  for (const [i, s] of obj.sales.entries()) {
    const at = `Sale ${i + 1}`;
    if (typeof s.id !== "string" || !s.id) return `${at}: missing id.`;
    if (ids.has(s.id)) return `${at}: duplicate id.`;
    ids.add(s.id);
    if (!ISO(s.saleDate) || !ISO(s.createdAt)) return `${at}: bad date.`;
    if (s.deletedAt != null && !ISO(s.deletedAt)) return `${at}: bad deleted date.`;
    if (s.verified != null && typeof s.verified !== "boolean") return `${at}: bad status.`;
    if (s.ref != null && (typeof s.ref !== "string" || s.ref.length > 40)) return `${at}: bad reference.`;
    if (!Array.isArray(s.items) || s.items.length === 0) return `${at}: no products.`;
    for (const it of s.items) {
      if (typeof it.id !== "string" || typeof it.name !== "string") return `${at}: bad product.`;
      if (!BUCKETS.includes(it.bucket)) return `${at}: bad bucket.`;
      if (!INT(it.unit, 0, 100000) || !INT(it.qty, 1, MAX_QTY)) return `${at}: bad quantity or credit.`;
    }
  }
  for (const [k, c] of Object.entries(obj.cycles)) {
    if (!/^\d{4}-\d{2}-22$/.test(k)) return `Cycle ${k}: bad key.`;
    if (c.targets != null) for (const b of BUCKETS) if (!INT(c.targets[b], 0, 10000000)) return `Cycle ${k}: bad target.`;
    if (c.snapshot != null) {
      for (const b of BUCKETS) if (!INT(c.snapshot[b], 0, 10000000)) return `Cycle ${k}: bad starting credits.`;
    }
  }
  return null;
}

// ---- plan file: products, credit values, TIC split and payout curves (private, user-loaded) ----
export function validatePlan(plan) {
  if (!plan || typeof plan !== "object" || plan.plan_version !== 1) return "Not a plan file (plan_version 1 expected).";
  if (!Array.isArray(plan.products) || !plan.products.length) return "Plan has no products.";
  const ids = new Set();
  for (const p of plan.products) {
    if (typeof p.id !== "string" || !p.id || ids.has(p.id)) return "Plan product ids must be unique.";
    ids.add(p.id);
    if (typeof p.name !== "string" || !p.name) return `Product ${p.id}: missing name.`;
    if (!BUCKETS.includes(p.bucket)) return `Product ${p.id}: bad bucket.`;
    if (!Number.isInteger(p.unit) || p.unit < 0 || p.unit > 100000) return `Product ${p.id}: credit must be whole hundredths.`;
  }
  if (plan.tic_share) {
    const sum = BUCKETS.reduce((a, b) => a + (plan.tic_share[b] || 0), 0);
    if (Math.abs(sum - 100) > 0.001) return "TIC shares must add up to 100.";
  }
  if (plan.curves) {
    for (const b of BUCKETS) {
      const c = plan.curves[b];
      if (!c || !Array.isArray(c.points) || c.points.length < 2) return `Curve ${b}: needs at least two points.`;
      for (let k = 1; k < c.points.length; k++) if (!(c.points[k][0] > c.points[k - 1][0])) return `Curve ${b}: points must increase.`;
      if (typeof c.tail_slope !== "number" || c.tail_slope < 0) return `Curve ${b}: bad tail_slope.`;
    }
  }
  return null;
}

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

// Piecewise-linear payout % of opportunity at a given achievement % (attainment + PTO accelerator).
export function payoutPercent(curve, achievement) {
  const pts = curve.points;
  if (achievement <= pts[0][0]) return pts[0][1];
  for (let k = 1; k < pts.length; k++) {
    const [x0, y0] = pts[k - 1], [x1, y1] = pts[k];
    if (achievement <= x1) return y0 + ((achievement - x0) * (y1 - y0)) / (x1 - x0);
  }
  const [xl, yl] = pts[pts.length - 1];
  return yl + (achievement - xl) * curve.tail_slope;
}

// Estimate following the statement's arithmetic: opportunity = TIC x share (to the cent), attainment and
// payout % rounded to 2 decimals, earnings = opportunity x payout % (to the cent). Totals are hundredths.
export function estimateCommission(totals, plan, { tic, pto = 0 }) {
  if (!plan?.curves || !plan?.tic_share || !(tic > 0) || !totals.targets) return null;
  const rows = {};
  let sum = 0;
  for (const b of BUCKETS) {
    const target = totals.targets[b];
    if (!target) return null;
    const attainment = round2((totals.total[b] / target) * 100);
    const achievement = round2(attainment + pto);
    const payout = round2(payoutPercent(plan.curves[b], achievement));
    const opportunity = round2((tic * plan.tic_share[b]) / 100);
    const earnings = round2((opportunity * payout) / 100);
    rows[b] = { attainment, achievement, payout, opportunity, earnings };
    sum += earnings;
  }
  return { rows, total: round2(sum) };
}

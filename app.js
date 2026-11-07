import {
  PRODUCTS, BUCKETS, MAX_QTY, fmt, toHundredths, itemsFromSelection, creditsOf, cycleKey, cycleLabel,
  keyToStart, cycleEnd, cycleTotals, attainment, nextMilestone, emptyState,
  ensureCycle, validateState, liveSales, setProducts, validatePlan, estimateCommission,
} from "./core.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const NAMES = { m1: "M1", m2: "M2", m3: "M3" };

// ---------------- storage: IndexedDB, with localStorage only if IndexedDB is unavailable ----------------
const DB = "sales-tracker", STORE = "kv", KEY = "state";
let dbp = null;
function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    if (!("indexedDB" in window)) return rej(new Error("no indexedDB"));
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function loadState() {
  try {
    const db = await openDB();
    const v = await new Promise((res, rej) => {
      const t = db.transaction(STORE).objectStore(STORE).get(KEY);
      t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error);
    });
    return v ? JSON.parse(v) : null;
  } catch {
    const v = localStorage.getItem(KEY);
    return v ? JSON.parse(v) : null;
  }
}
async function putRaw(key, value) {
  const db = await openDB();
  await new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function writeState(s) {
  const json = JSON.stringify(s);
  try {
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(json, KEY);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error("aborted"));
    });
  } catch (e) {
    if (e && e.message === "no indexedDB") localStorage.setItem(KEY, json);
    else throw e;
  }
}

// ---------------- state ----------------
let state = emptyState();
let selection = {};
let customTime = null;
let salesFilter = null;
let toastTimer = null;
const nowKey = () => cycleKey(new Date());

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

// commit runs the mutation, then persists; on failure it restores the previous state.
async function commit(mutate) {
  const before = JSON.stringify(state);
  mutate(state);
  try { await writeState(state); return true; }
  catch (e) { state = JSON.parse(before); throw e; }
}

// ---------------- home ----------------
function renderHome() {
  const key = nowKey();
  ensureCycle(state, key);
  const t = cycleTotals(state, key);
  const cyc = state.cycles[key];
  const end = new Date(cycleEnd(keyToStart(key)).getTime() - 1);
  const days = Math.max(0, Math.ceil((cycleEnd(keyToStart(key)) - new Date()) / 86400000));
  $("cycleLabel").textContent = cycleLabel(key);
  $("cycleSub").textContent = `Closes ${end.toLocaleDateString("en-US", { month: "short", day: "numeric" })} · ${days} day${days === 1 ? "" : "s"} left`;

  const untouched = !cyc.targets && t.count === 0;
  $("planNotice").classList.toggle("hidden", !!state.plan);
  $("setupNotice").classList.toggle("hidden", !untouched || !state.plan);
  $("targetsNotice").classList.toggle("hidden", !(cyc.targets && cyc.targetsConfirmed === false));

  $("scoreboard").innerHTML = BUCKETS.map((b) => {
    const target = t.targets?.[b];
    const pct = target ? attainment(t.total[b], target) : null;
    const width = target ? Math.min(100, (t.total[b] / target) * 100) : 0;
    const foot = t.start
      ? `start ${fmt(t.base[b])} + sales ${fmt(t.logged[b])}`
      : `${t.count} sale${t.count === 1 ? "" : "s"} this cycle`;
    return `<div class="score">
      <div class="score-head"><span class="score-name">${NAMES[b]}</span>
        <span class="score-num">${fmt(t.total[b])} <small>/ ${target ? fmt(target) : "set target"}</small></span></div>
      <div class="bar"><i style="width:${width}%;background:var(--${b})"></i></div>
      <div class="score-foot"><span>${foot}</span><span>${pct === null ? "" : pct.toFixed(2) + "%"}</span></div>
    </div>`;
  }).join("");

  const m = nextMilestone(t);
  $("milestone").textContent = m ? `Next: ${NAMES[m.bucket]} ${m.pct}% at ${fmt(m.need)} · ${fmt(m.gap)} to go` : (t.targets ? "All targets reached 🎯" : "");

  const pay = state.pay || {};
  const est = state.plan ? estimateCommission(t, state.plan, { tic: pay.tic, pto: pay.pto || 0 }) : null;
  $("snapLine").innerHTML = est
    ? `<strong>Estimated commission: $${est.total.toFixed(2)}</strong> · ${BUCKETS.map((b) => `${NAMES[b]} $${est.rows[b].earnings.toFixed(2)}`).join(" · ")}<br><span class="small">Estimate from your plan file and the credits here. Your statement is the official number.</span>`
    : (state.plan && t.targets && !(pay.tic > 0) ? `<span class="small">Add your TIC in ⚙︎ to see estimated commission.</span>` : "");
  renderGrid();
}

function renderGrid() {
  $("grid").innerHTML = PRODUCTS.map((p) => {
    const q = selection[p.id] || 0;
    return `<div class="tile ${q ? "on" : ""}" data-id="${p.id}" role="checkbox" aria-checked="${q > 0}" tabindex="0">
      <div class="tile-top"><span class="box">${q ? "✓" : ""}</span>
        <div><div class="tile-name">${esc(p.name)}</div><div class="tile-meta">${NAMES[p.bucket]} +${fmt(p.unit)}</div></div></div>
      ${q ? `<div class="qty"><button data-dec="${p.id}" aria-label="Less ${esc(p.name)}">−</button><span>${q}</span><button data-inc="${p.id}" aria-label="More ${esc(p.name)}">+</button></div>` : ""}
    </div>`;
  }).join("");
  const c = creditsOf(itemsFromSelection(selection));
  $("impact").textContent = `M1 +${fmt(c.m1)} | M2 +${fmt(c.m2)} | M3 +${fmt(c.m3)}`;
  $("save").disabled = !Object.values(selection).some((q) => q > 0);
}

$("grid").addEventListener("click", (e) => {
  const inc = e.target.closest("[data-inc]"), dec = e.target.closest("[data-dec]");
  if (inc) { const id = inc.dataset.inc; selection[id] = Math.min(MAX_QTY, (selection[id] || 0) + 1); }
  else if (dec) { const id = dec.dataset.dec; selection[id] = Math.max(0, (selection[id] || 0) - 1); }
  else { const tile = e.target.closest(".tile"); if (!tile) return; const id = tile.dataset.id; selection[id] = selection[id] ? 0 : 1; }
  renderGrid();
});

$("changeTime").addEventListener("click", () => {
  const inp = $("saleTime");
  inp.classList.toggle("hidden");
  if (!inp.classList.contains("hidden") && !inp.value) inp.value = localInput(new Date());
});
$("saleTime").addEventListener("change", () => {
  const v = $("saleTime").value;
  customTime = v ? new Date(v) : null;
  $("saleTimeLabel").textContent = customTime ? customTime.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "now";
});

function localInput(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function resetForm() {
  selection = {}; customTime = null;
  $("ref").value = ""; $("saleTime").value = ""; $("saleTime").classList.add("hidden"); $("saleTimeLabel").textContent = "now";
  $("saveErr").classList.add("hidden");
}

$("save").addEventListener("click", async () => {
  const items = itemsFromSelection(selection);
  if (!items.length) return;
  const ref = $("ref").value.trim().slice(0, 40);
  const now = new Date();
  const sale = {
    id: uid(), saleDate: (customTime || now).toISOString(), createdAt: now.toISOString(),
    items, ref, deletedAt: null, history: [],
  };
  $("save").disabled = true;
  try {
    await commit((s) => { s.sales.push(sale); ensureCycle(s, cycleKey(sale.saleDate)); });
    resetForm();
    toast("Sale Saved ✓");
    renderAll();
  } catch (e) {
    $("saveErr").textContent = `Not saved: ${e?.message || "storage error"}. Your selections are still here, try again.`;
    $("saveErr").classList.remove("hidden");
    $("save").disabled = false;
  }
});

// ---------------- sales ----------------
function saleLine(s) {
  const c = creditsOf(s.items);
  const when = new Date(s.saleDate).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const credits = BUCKETS.filter((b) => c[b]).map((b) => `${NAMES[b]} +${fmt(c[b])}`).join(" · ");
  return `<div class="sale" data-id="${s.id}">
    <div class="sale-head"><span>${esc(when)}${s.ref ? ` · ${esc(s.ref)}` : ""}</span></div>
    <div class="sale-items">${s.items.map((i) => `${esc(i.name)}${i.qty > 1 ? ` ×${i.qty}` : ""}`).join(", ")}</div>
    <div class="sale-credits">${credits}</div>
    <div class="sale-actions">
      <button data-act="edit">Edit</button>
      <button data-act="delete">Delete</button>
    </div></div>`;
}

function cycleKeysWithData() {
  const keys = new Set([nowKey(), ...Object.keys(state.cycles)]);
  for (const s of liveSales(state)) keys.add(cycleKey(s.saleDate));
  return [...keys].sort().reverse();
}

function renderSales() {
  const keys = cycleKeysWithData();
  if (!salesFilter) salesFilter = nowKey();
  $("salesFilter").innerHTML = [`<option value="all">All sales</option>`, ...keys.map((k) => `<option value="${k}">${cycleLabel(k)}</option>`)].join("");
  $("salesFilter").value = salesFilter;
  const list = liveSales(state)
    .filter((s) => salesFilter === "all" || cycleKey(s.saleDate) === salesFilter)
    .sort((a, b) => new Date(b.saleDate) - new Date(a.saleDate));
  $("salesList").innerHTML = list.length ? list.map((s) => saleLine(s)).join("") : `<div class="empty">No sales here yet.</div>`;
}
$("salesFilter").addEventListener("change", (e) => { salesFilter = e.target.value; renderSales(); });

$("salesList").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]"); if (!btn) return;
  const id = btn.closest(".sale").dataset.id;
  const sale = state.sales.find((s) => s.id === id); if (!sale) return;
  const act = btn.dataset.act;
  try {
    if (act === "delete") {
      await commit((st) => { st.sales.find((x) => x.id === id).deletedAt = new Date().toISOString(); });
      renderAll();
      toast("Sale deleted", "Undo", async () => {
        await commit((st) => { st.sales.find((x) => x.id === id).deletedAt = null; });
        renderAll(); toast("Restored ✓");
      });
    } else if (act === "edit") openEdit(sale);
  } catch (err) { toast(`Not saved: ${err?.message || "storage error"}`); }
});

function openEdit(sale) {
  const qty = Object.fromEntries(sale.items.map((i) => [i.id, i.qty]));
  const draw = () => {
    $("sheetBody").innerHTML = `<h3>Edit sale</h3>
      <div class="field"><label>Sale date and time</label><input type="datetime-local" id="eDate" value="${localInput(new Date(sale.saleDate))}"></div>
      <div class="field"><label>Reference (no customer info)</label><input id="eRef" maxlength="40" value="${esc(sale.ref)}"></div>
      ${PRODUCTS.map((p) => `<div class="edit-row"><span>${esc(p.name)} <span class="small">${NAMES[p.bucket]} +${fmt(p.unit)}</span></span>
        <span class="qty"><button data-edec="${p.id}">−</button><span>${qty[p.id] || 0}</span><button data-einc="${p.id}">+</button></span></div>`).join("")}
      <div id="eErr" class="err hidden"></div>
      <div class="sheet-actions"><button class="btn" id="eCancel">Cancel</button><button class="btn primary" id="eSave">Save changes</button></div>`;
    // Products already on the sale keep the credit they were saved with.
  };
  draw();
  openSheet();
  $("sheetBody").onclick = async (e) => {
    const inc = e.target.closest("[data-einc]"), dec = e.target.closest("[data-edec]");
    if (inc || dec) {
      const keep = { d: $("eDate").value, r: $("eRef").value };
      const id = (inc || dec).dataset[inc ? "einc" : "edec"];
      qty[id] = Math.max(0, Math.min(MAX_QTY, (qty[id] || 0) + (inc ? 1 : -1)));
      draw(); $("eDate").value = keep.d; $("eRef").value = keep.r; return;
    }
    if (e.target.id === "eCancel") return closeSheet();
    if (e.target.id === "eSave") {
      const d = new Date($("eDate").value);
      if (Number.isNaN(d.getTime())) return showErr("eErr", "Pick a valid date.");
      const prior = Object.fromEntries(sale.items.map((i) => [i.id, i]));
      const items = [];
      for (const p of PRODUCTS) {
        const q = qty[p.id] || 0;
        if (q > 0) items.push(prior[p.id] ? { ...prior[p.id], qty: q } : { id: p.id, name: p.name, bucket: p.bucket, unit: p.unit, qty: q });
      }
      if (!items.length) return showErr("eErr", "A sale needs at least one product. Use Delete to remove it.");
      try {
        await commit((st) => {
          const s = st.sales.find((x) => x.id === sale.id);
          s.history.push({ at: new Date().toISOString(), before: { saleDate: s.saleDate, ref: s.ref, items: s.items } });
          s.saleDate = d.toISOString(); s.ref = $("eRef").value.trim().slice(0, 40); s.items = items;
          ensureCycle(st, cycleKey(s.saleDate));
        });
        closeSheet(); renderAll(); toast("Changes saved ✓");
      } catch (err) { showErr("eErr", `Not saved: ${err?.message || "storage error"}`); }
    }
  };
}

// ---------------- archive ----------------
function renderArchive() {
  const keys = cycleKeysWithData();
  $("archiveList").innerHTML = keys.map((k) => {
    const t = cycleTotals(state, k);
    if (!t.count && !t.start && k !== nowKey()) return "";
    const nums = BUCKETS.map((b) => `${NAMES[b]} ${fmt(t.total[b])}${t.targets?.[b] ? `/${fmt(t.targets[b])}` : ""}`).join(" · ");
    return `<button class="cycle-card" data-key="${k}">
      <div class="row-between"><strong>${cycleLabel(k)}</strong><span class="small">${k === nowKey() ? "current" : "closed"}</span></div>
      <div class="nums">${nums}</div>
      <div class="small">${t.count} sale${t.count === 1 ? "" : "s"}</div>
    </button>`;
  }).join("") || `<div class="empty">No cycles yet.</div>`;
}
$("archiveList").addEventListener("click", (e) => {
  const card = e.target.closest(".cycle-card"); if (!card) return;
  salesFilter = card.dataset.key; showTab("sales");
});

// ---------------- settings: goals, starting credits, backup ----------------
function openSettings(focusKey) {
  const key = focusKey || nowKey();
  const draw = (k) => {
    ensureCycle(state, k);
    const c = state.cycles[k];
    const sn = c.snapshot || {};
    const v = (h) => (h == null ? "" : fmt(h));
    $("sheetBody").innerHTML = `<h3>Goals · ${cycleLabel(k)}</h3>
      <div class="field"><label>Goal (M1 · M2 · M3)</label><div class="three">
        <input id="tM1" inputmode="decimal" value="${v(c.targets?.m1)}" placeholder="M1"><input id="tM2" inputmode="decimal" value="${v(c.targets?.m2)}" placeholder="M2"><input id="tM3" inputmode="decimal" value="${v(c.targets?.m3)}" placeholder="M3"></div></div>
      <div class="field"><label>Starting credits, optional (M1 · M2 · M3)</label><div class="three">
        <input id="cM1" inputmode="decimal" value="${v(sn.m1)}" placeholder="0"><input id="cM2" inputmode="decimal" value="${v(sn.m2)}" placeholder="0"><input id="cM3" inputmode="decimal" value="${v(sn.m3)}" placeholder="0"></div></div>
      <p class="small">Starting credits are what you already have this cycle. Every sale you save adds on top.</p>
      <div class="field"><label>Pay, from your statement (TIC $ · PTO accelerator %)</label><div class="three" style="grid-template-columns:1fr 1fr">
        <input id="pTic" inputmode="decimal" value="${state.pay?.tic ?? ""}" placeholder="TIC $"><input id="pPto" inputmode="decimal" value="${state.pay?.pto ?? ""}" placeholder="PTO %"></div></div>
      <div id="sErr" class="err hidden"></div>
      <div class="sheet-actions"><button class="btn" id="sCancel">Close</button><button class="btn primary" id="sSave">Save</button></div>
      <p class="small">Your sales live only on this phone. Save a backup now and then (to Files or iCloud Drive). Deleting the app or clearing Safari data erases them.</p>
      <h3 style="margin-top:22px">Plan file</h3>
      <p class="small">${state.plan ? `Loaded: ${esc(state.plan.name || "plan")}` : "No plan file loaded."} It stays on this phone only.</p>
      <label class="btn" style="display:block;text-align:center">${state.plan ? "Replace plan file" : "Load plan file"}<input type="file" id="sPlan" accept="application/json,.json" class="hidden"></label>
      ${state.plan ? `<p class="small" style="margin-top:12px">Share your setup with a coworker. They tap the link once and can start tracking. Send it privately (text), not in public.</p>
      <div class="sheet-actions"><button class="btn" id="shareBasic">Share products only</button><button class="btn" id="shareFull">Share with pay curves</button></div>` : ""}
      <h3 style="margin-top:22px">Backup</h3>
      <div class="sheet-actions"><button class="btn" id="bExport">Save backup</button><label class="btn" style="text-align:center">Restore<input type="file" id="bImport" accept="application/json,.json" class="hidden"></label></div>`;
    $("sCancel").onclick = closeSheet;
    $("sSave").onclick = () => saveNumbers(k);
    $("bExport").onclick = exportBackup;
    $("bImport").onchange = importBackup;
    $("sPlan").onchange = (e) => { const f = e.target.files?.[0]; if (f) loadPlanFile(f, "sErr"); };
    if (state.plan) { $("shareBasic").onclick = () => shareSetup(false); $("shareFull").onclick = () => shareSetup(true); }
  };
  draw(key);
  openSheet();
}

async function saveNumbers(k) {
  const read = (ids) => ids.map((id) => ($(id).value.trim() === "" ? undefined : toHundredths($(id).value)));
  const tgt = read(["tM1", "tM2", "tM3"]);
  const cur = read(["cM1", "cM2", "cM3"]);
  if (tgt.some((x) => x === null) || cur.some((x) => x === null)) return showErr("sErr", "Use plain numbers like 40 or 12.5.");
  if (tgt.some((x) => x === undefined)) return showErr("sErr", "Enter all three goals.");
  const anyCur = cur.some((x) => x !== undefined);
  const ticRaw = $("pTic").value.replace(/[$,\s]/g, ""), ptoRaw = $("pPto").value.replace(/[%\s]/g, "");
  const tic = ticRaw === "" ? null : Number(ticRaw), pto = ptoRaw === "" ? 0 : Number(ptoRaw);
  if ((tic !== null && !(tic > 0 && tic < 1e7)) || !(pto >= 0 && pto <= 100)) return showErr("sErr", "TIC like 1000.00 and PTO like 10.");
  try {
    await commit((st) => {
      const c = st.cycles[k];
      c.targets = { m1: tgt[0], m2: tgt[1], m3: tgt[2] }; c.targetsConfirmed = true;
      c.snapshot = anyCur ? { m1: cur[0] ?? 0, m2: cur[1] ?? 0, m3: cur[2] ?? 0, enteredAt: new Date().toISOString() } : null;
      st.pay = { tic, pto };
    });
    closeSheet(); renderAll(); toast("Saved ✓");
  } catch (e) { showErr("sErr", `Not saved: ${e?.message || "storage error"}`); }
}

async function exportBackup() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const name = `sales-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([blob], name, { type: "application/json" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "Sales tracker backup" }); return; } catch (e) { if (e?.name === "AbortError") return; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function importBackup(e) {
  const f = e.target.files?.[0]; if (!f) return;
  let obj;
  try { obj = JSON.parse(await f.text()); } catch { return showErr("sErr", "That file isn't a readable backup."); }
  const problem = validateState(obj);
  if (problem) return showErr("sErr", `Backup rejected: ${problem} Nothing was changed.`);
  const n = obj.sales.filter((s) => !s.deletedAt).length;
  $("sErr").classList.add("hidden");
  $("sheetBody").insertAdjacentHTML("beforeend", `<div class="warn" id="rConfirm">Replace everything on this phone with this backup (${n} sales)? <div class="sheet-actions"><button class="btn" id="rNo">Cancel</button><button class="btn danger" id="rYes">Replace</button></div></div>`);
  $("rNo").onclick = () => $("rConfirm").remove();
  $("rYes").onclick = async () => {
    try { await commit((st) => { Object.keys(st).forEach((k) => delete st[k]); Object.assign(st, obj); }); closeSheet(); renderAll(); toast("Backup restored ✓"); }
    catch (err) { showErr("sErr", `Restore failed: ${err?.message || "storage error"}. Nothing was changed.`); }
  };
}

// ---------------- plan file (private; lives only on this device) ----------------
async function loadPlanFile(file, errId) {
  let plan;
  try { plan = JSON.parse(await file.text()); } catch { return showErr(errId, "That file isn't a readable plan file."); }
  const problem = validatePlan(plan);
  if (problem) return showErr(errId, `Plan file rejected: ${problem}`);
  try {
    await commit((st) => { st.plan = plan; });
    setProducts(plan.products);
    renderAll(); toast("Plan loaded ✓");
  } catch (e) { showErr(errId, `Not saved: ${e?.message || "storage error"}`); }
}
$("planInput").addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) loadPlanFile(f, "planErr"); });

// ---------------- setup link: the plan travels in the #fragment, which browsers never send to a server ----
function b64urlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function setupLink(includeCurves) {
  const p = { ...state.plan };
  if (!includeCurves) { delete p.curves; delete p.tic_share; }
  return `${location.origin}${location.pathname}#setup=${b64urlEncode(JSON.stringify(p))}`;
}
async function shareSetup(includeCurves) {
  const url = setupLink(includeCurves);
  if (navigator.share) { try { await navigator.share({ title: "Sales tracker setup", url }); return; } catch (e) { if (e?.name === "AbortError") return; } }
  try { await navigator.clipboard.writeText(url); toast("Setup link copied ✓"); } catch { prompt("Copy this setup link:", url); }
}
async function readSetupFromLink() {
  const m = location.hash.match(/^#setup=([A-Za-z0-9_-]+)$/);
  if (!m) return;
  history.replaceState(null, "", location.pathname + location.search); // don't keep the plan in the address bar
  let plan;
  try { plan = JSON.parse(b64urlDecode(m[1])); } catch { return toast("That setup link is damaged."); }
  if (validatePlan(plan)) return toast("That setup link isn't a valid plan.");
  const apply = async () => {
    await commit((st) => { st.plan = plan; });
    setProducts(plan.products); renderAll(); toast("Setup loaded ✓ Ready to track");
  };
  if (!state.plan) return apply();
  $("planErr").textContent = "";
  $("planNotice").classList.remove("hidden");
  $("planNotice").innerHTML = `<strong>Replace your current plan with the one from this link?</strong> Your sales stay as they are.
    <div class="sheet-actions"><button class="btn" id="setupNo">Keep mine</button><button class="btn primary" id="setupYes">Replace</button></div>`;
  $("setupNo").onclick = () => { $("planNotice").classList.add("hidden"); };
  $("setupYes").onclick = () => { apply(); $("planNotice").classList.add("hidden"); };
}

// ---------------- chrome ----------------
function showErr(id, msg) { const el = $(id); el.textContent = msg; el.classList.remove("hidden"); }
function openSheet() { $("sheet").classList.remove("hidden"); }
function closeSheet() { $("sheet").classList.add("hidden"); $("sheetBody").onclick = null; $("sheetBody").innerHTML = ""; }
$("sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") closeSheet(); });

function toast(text, actionLabel, action) {
  const el = $("toast");
  clearTimeout(toastTimer);
  el.innerHTML = `<span>${esc(text)}</span>${actionLabel ? `<button class="link" id="toastAct">${esc(actionLabel)}</button>` : ""}`;
  el.classList.remove("hidden");
  if (actionLabel) $("toastAct").onclick = () => { el.classList.add("hidden"); action(); };
  toastTimer = setTimeout(() => el.classList.add("hidden"), actionLabel ? 8000 : 2200);
}

function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  if (name === "sales") renderSales();
  if (name === "archive") renderArchive();
  window.scrollTo(0, 0);
}
document.querySelector(".tabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) showTab(b.dataset.tab); });
$("openSettings").onclick = () => openSettings();
$("startSetup").onclick = () => openSettings();
$("confirmTargets").onclick = () => openSettings();

function renderAll() { renderHome(); renderSales(); renderArchive(); }

// Re-render when the app comes back to the foreground, so a new cycle on the 22nd shows up.
document.addEventListener("visibilitychange", () => { if (!document.hidden) renderHome(); });

(async () => {
  try {
    const saved = await loadState();
    if (saved && !validateState(saved)) { state = saved; if (state.plan) setProducts(state.plan.products); }
    else if (saved) {
      // Keep the unreadable copy under its own key before anything can overwrite it.
      await putRaw(`damaged-${Date.now()}`, JSON.stringify(saved)).catch(() => {});
      toast("Saved data looked damaged; a copy was set aside. Restore a backup.");
    }
  } catch { toast("Couldn't read saved data."); }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  renderAll();
  await readSetupFromLink();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();

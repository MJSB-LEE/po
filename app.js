// ====================================================
// AutoCount PO & GRN Audit Portal  (v5 – locations read from the CSV)
// Built for AutoCount "Purchase Order Detail Listing" and
// "Goods Received Note Detail Listing" CSV exports (with a Location
// column added at the far right), plus the "Stock Location Listing"
// for location descriptions.
// ====================================================

const APP_VERSION = 'Version 5.1 · 18/11/2026';
let rawPOList = [];     // one entry per PO line  (has .loc = location code)
let rawGRNList = [];    // one entry per GRN line (has .loc = location code)
let dataVersion = 0;    // bumps whenever data changes (for pickers)
let currentActiveTab = 'tab-location-summary';
let exportStore = {};   // tableId -> { summary: [...], detail: [...] }

// Saved data: one entry per company (company name comes from the CSV header)
let db = { version: 6, current: '', companies: {} };
let store = emptyCompany();          // = db.companies[db.current]
function emptyCompany() { return { po: [], grn: [], meta: {}, locMaster: {}, cancels: {}, poCreditors: {} }; }
function locFollowsGrn() { return !store.meta || store.meta.locFollowGrn !== false; }
function setLocFollowGrn(on) {
  store.meta.locFollowGrn = !!on;
  logAction(`Location ${on ? 'follows the GRN' : 'follows the PO'}`, null, 'meta');
  rebuildCombined(); saveStore(); refreshLocationUI(); renderActiveTab();
}

// ---------- Creditor name rules (e.g. every "Shopee ..." shop shows as Shopee) ----------
const DEFAULT_CRED_RULES = [
  { type: 'contains', match: 'shopee', name: 'Shopee', code: '' },
  { type: 'contains', match: 'taobao', name: 'Taobao', code: '' },
  { type: 'contains', match: 'cash', name: 'Cash Sales', code: '' }
];
function credRules() { return Array.isArray(store.credRules) ? store.credRules : DEFAULT_CRED_RULES; }
function matchCredRule(code, name) {
  const n = up(name), c = up(code);
  return credRules().find(r => r.match && (r.type === 'code' ? c === up(r.match) : n.includes(up(r.match))));
}
function applyCredRules(x) {
  if (!x || (!x.creditorName && !x.creditorCode)) return;
  const r = matchCredRule(x.creditorCode, x.creditorName);
  if (!r) return;
  x.origCreditor = (x.creditorCode ? x.creditorCode + ' ' : '') + (x.creditorName || '');
  x.creditorName = r.name;
  x.creditorCode = r.code || '';
}
function renderCredRules() {
  const box = document.getElementById('credRules');
  if (!box) return;
  const rules = credRules();
  const count = r => {
    const pos = new Set();
    rawPOList.forEach(p => { if (p.creditorName === r.name && p.origCreditor) pos.add(p.docNo); });
    return pos.size;
  };
  box.innerHTML = `<table class="audit-table loc-master-table"><thead><tr><th>If creditor</th><th>Text / code</th><th>Show as</th><th>Code to show (optional)</th><th class="text-right">POs</th><th></th></tr></thead><tbody>` +
    rules.map((r, i) => `<tr>
      <td><select data-ri="${i}" data-rf="type" onchange="editCredRule(this)"><option value="contains" ${r.type !== 'code' ? 'selected' : ''}>name contains</option><option value="code" ${r.type === 'code' ? 'selected' : ''}>code is</option></select></td>
      <td><input data-ri="${i}" data-rf="match" value="${esc(r.match)}" onchange="editCredRule(this)"></td>
      <td><input data-ri="${i}" data-rf="name" value="${esc(r.name)}" onchange="editCredRule(this)"></td>
      <td><input data-ri="${i}" data-rf="code" value="${esc(r.code || '')}" onchange="editCredRule(this)" placeholder="e.g. 411-C001"></td>
      <td class="text-right">${count(r) || '-'}</td>
      <td class="text-right"><button class="btn btn-danger btn-sm" onclick="deleteCredRule(${i})">Delete</button></td></tr>`).join('') +
    `</tbody></table>
    <div class="loc-add"><button class="btn btn-excel btn-sm" onclick="addCredRule()">＋ Add rule</button>
      <span class="muted small-text">Rules are checked from top to bottom. "Cash Sales" staff names (ramai-ramai) can be grouped with a <b>code is</b> rule on your cash-sales creditor code.</span></div>`;
}
function saveCredRules(rules, what) {
  store.credRules = rules;
  logAction(what, null, 'rules');
  rebuildCombined();
  saveStore();
  renderActiveTab();
}
function editCredRule(el) {
  const rules = credRules().map(r => Object.assign({}, r));
  const r = rules[+el.dataset.ri]; if (!r) return;
  r[el.dataset.rf] = el.value.trim();
  if (!r.name) return alert('"Show as" cannot be empty.');
  saveCredRules(rules, `Changed creditor rule: ${r.type === 'code' ? 'code is' : 'name contains'} "${r.match}" → ${r.name}`);
}
function addCredRule() {
  const match = prompt('Creditor name contains (e.g. lazada) — or a creditor code (e.g. 411-C001):');
  if (!match) return;
  const isCode = /^\d{2,4}-[A-Z0-9]+$/i.test(match.trim());
  const name = prompt('Show it as:', isCode ? 'Cash Sales' : match.trim().replace(/^./, c => c.toUpperCase()));
  if (!name) return;
  const rules = credRules().map(r => Object.assign({}, r)).concat([{ type: isCode ? 'code' : 'contains', match: match.trim(), name: name.trim(), code: isCode ? match.trim() : '' }]);
  saveCredRules(rules, `Added creditor rule: ${isCode ? 'code is' : 'name contains'} "${match.trim()}" → ${name.trim()}`);
}
function deleteCredRule(i) {
  const rules = credRules().map(r => Object.assign({}, r));
  const r = rules[i]; if (!r || !confirm(`Delete rule "${r.match}" → ${r.name}?`)) return;
  rules.splice(i, 1);
  saveCredRules(rules, `Deleted creditor rule "${r.match}" → ${r.name}`);
}

// Location selection: null = all locations, otherwise a Set of codes
let locSel = null;
const LOCSEL_KEY = 'autocount_portal_locsel';

const OLD_STORAGE_KEY = 'autocount_portal_data_v3';
const COMPANY_KEY = 'autocount_portal_company';
const EPS = 0.000001;
const NO_LOC = '';      // lines without a location code

// ----------------------------------------------------
// Small helpers
// ----------------------------------------------------
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmt(n) {
  return (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function rm(n) { return 'RM ' + fmt(n); }
function qtyFmt(n) { return (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 4 }); }
function num(s) {
  if (s == null) return 0;
  const v = parseFloat(String(s).replace(/,/g, '').trim());
  return isNaN(v) ? 0 : v;
}
function isNum(s) { return /^-?[\d,]+(\.\d+)?%?$/.test(String(s || '').trim()); }
function cell(r, i) { return r[i] == null ? '' : String(r[i]).trim(); }
function isDate(s) { return /^\d{1,2}[\/-]\d{1,2}[\/-]\d{4}$/.test(s); }
function isPONo(s) { return /^PO[-\/]?\d/i.test(String(s || '').trim()); }
function isCurrency(s) { return /^[A-Z]{2,3}$/.test(s) && !/^PO|^GRN/.test(s); }

// dd/mm/yyyy -> yyyy-mm-dd
function toISO(dStr) {
  if (!dStr) return '';
  const s = String(dStr).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const p = s.split(/[\/-]/);
  if (p.length === 3 && p[2].length === 4) return `${p[2]}-${p[1].padStart(2, '0')}-${p[0].padStart(2, '0')}`;
  return '';
}
function isoToYYMM(iso) { return iso ? iso.substring(2, 4) + iso.substring(5, 7) : '0000'; }
function yymmLabel(yymm) {
  const names = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const m = parseInt(yymm.substring(2), 10);
  return `${names[m - 1] || '?'} 20${yymm.substring(0, 2)} (${yymm})`;
}
function up(s) { return String(s == null ? '' : s).trim().toUpperCase(); }
// Which PO line does a GRN line belong to (same PO + item, several lines)? Same unit price first,
// then same location, then same description — like AutoCount, where each GRN line is transferred from one PO line.
function samePrice(p, g) { const gp = +g.unitPrice; return isFinite(gp) && (Math.abs((+p.unitCost || 0) - gp) < 0.005 || Math.abs((+p.unitPrice || 0) - gp) < 0.005); }
function grnLineScore(p, g, desc) { return (samePrice(p, g) ? 4 : 0) + (p.loc === g.loc ? 2 : 0) + (up(p.description) === desc ? 1 : 0); }
function lineKey(poNo, item) { return `${up(poNo)}|${up(item)}`; }
// A PO can have lines for different locations, so documents are grouped per location
function docKey(loc, docNo) { return `${loc}|${up(docNo)}`; }
// In "All Locations" a PO counts once; when one location is selected, only its lines count
function viewDocKey(p) { return '*|' + up(p.docNo); }
function dateDMY(iso) { return iso ? iso.split('-').reverse().join('/') : '-'; }

// ----------------------------------------------------
// Locations (code comes from the CSV, description from Stock Location Listing)
// ----------------------------------------------------
function locDesc(code) {
  if (code === NO_LOC) return 'No location';
  return (store.locMaster && store.locMaster[code]) || '';
}
// "S03TUN — TUNGKU"
function locName(code) {
  if (code === NO_LOC) return '(No location)';
  const d = locDesc(code);
  return d ? `${code} — ${d}` : code;
}
let locCodesCache = { ver: -1, list: [] };
function allLocCodes() {
  if (locCodesCache.ver === dataVersion && locCodesCache.n === rawPOList.length + rawGRNList.length) return locCodesCache.list.slice();
  const list = allLocCodesRaw();
  locCodesCache = { ver: dataVersion, n: rawPOList.length + rawGRNList.length, list };
  return list.slice();
}
function allLocCodesRaw() {
  const s = new Set();
  rawPOList.forEach(p => s.add(p.loc));
  rawGRNList.forEach(g => s.add(g.loc));
  return [...s].sort((a, b) => (a === NO_LOC) - (b === NO_LOC) || a.localeCompare(b));
}
function hasMultiLoc() { allLocCodes(); return locCodesCache.list.length > 1; }
function locAllowed(code) { return !locSel || locSel.has(code); }
// 'ALL', a single code, or 'MULTI'
function getLocFilter() { return !locSel ? 'ALL' : (locSel.size === 1 ? [...locSel][0] : 'MULTI'); }
function isMultiLocView() { return hasMultiLoc() && (!locSel || locSel.size > 1); }
function locSelText(long) {
  if (!locSel) return long ? 'ALL LOCATIONS' : '🌐 All Locations';
  const codes = [...locSel].sort();
  if (codes.length === 1) return long ? 'LOCATION: ' + locName(codes[0]).toUpperCase() : locName(codes[0]);
  if (long) return `${codes.length} LOCATIONS: ` + codes.map(c => c || '(NO LOC)').join(', ');
  return `${codes.length} locations: ` + codes.slice(0, 3).map(c => c || 'NO LOC').join(', ') + (codes.length > 3 ? ' …' : '');
}
function setLocSel(sel, silent, keepList) {
  const codes = allLocCodes();
  if (sel && (!sel.size || sel.size >= codes.length && codes.every(c => sel.has(c)))) sel = null;
  locSel = sel;
  try {
    const all = JSON.parse(localStorage.getItem(LOCSEL_KEY) || '{}');
    if (locSel) all[db.current] = [...locSel]; else delete all[db.current];
    localStorage.setItem(LOCSEL_KEY, JSON.stringify(all));
  } catch (e) {}
  renderLocMenu(keepList);
  updateReportLocLabels();
  if (!silent) onGlobalFilterChange();
}
function restoreLocSel() {
  locSel = null;
  try {
    const saved = (JSON.parse(localStorage.getItem(LOCSEL_KEY) || '{}'))[db.current];
    const codes = allLocCodes();
    if (Array.isArray(saved)) {
      const keep = saved.filter(c => codes.includes(c));
      if (keep.length && keep.length < codes.length) locSel = new Set(keep);
    }
  } catch (e) {}
}

// --- Multi-select dropdown in the top bar ---
function renderLocMenu(keepList) {
  const btn = document.getElementById('locMSBtn');
  const list = document.getElementById('locMSList');
  const box = document.querySelector('.header-loc-box');
  const codes = allLocCodes();
  if (box) box.style.display = codes.length > 1 ? '' : 'none';
  if (btn) {
    btn.innerHTML = `<span class="loc-ms-text">${esc(locSelText())}</span><span class="loc-ms-caret">▾</span>`;
    btn.classList.toggle('filtered', !!locSel);
    btn.title = locSel ? [...locSel].sort().map(locName).join('\n') : 'All locations';
  }
  const cnt0 = document.getElementById('locMSCount');
  if (cnt0) cnt0.innerText = locSel ? `${locSel.size} of ${codes.length} selected` : `All ${codes.length} locations`;
  if (!list || keepList === true) return;
  const q = up((document.getElementById('locMSSearch') || {}).value || '');
  list.innerHTML = codes.map(c => {
    const name = locName(c);
    const hide = q && !up(name).includes(q);
    return `<label class="loc-ms-item${hide ? ' hidden' : ''}">
      <input type="checkbox" value="${esc(c)}" ${locAllowed(c) && locSel ? 'checked' : ''} onchange="onLocCheck()">
      <b>${esc(c || '(blank)')}</b><span>${esc(c ? locDesc(c) : 'No location')}</span></label>`;
  }).join('');
  const cnt = document.getElementById('locMSCount');
  if (cnt) cnt.innerText = locSel ? `${locSel.size} of ${codes.length} selected` : `All ${codes.length} locations`;
}
function toggleLocMenu(force) {
  const p = document.getElementById('locMSPanel');
  if (!p) return;
  const open = force !== undefined ? force : !p.classList.contains('open');
  p.classList.toggle('open', open);
  if (open) {
    const s = document.getElementById('locMSSearch');
    if (s) { s.value = ''; renderLocMenu(); setTimeout(() => s.focus(), 30); }
    else renderLocMenu();
  }
}
function onLocCheck() {
  const checked = [...document.querySelectorAll('#locMSList input:checked')].map(i => i.value);
  setLocSel(checked.length ? new Set(checked) : null, false, true);
}
function locMSTickShown() {
  const shown = [...document.querySelectorAll('#locMSList .loc-ms-item:not(.hidden) input')].map(i => i.value);
  const cur = new Set(locSel ? [...locSel] : []);
  shown.forEach(c => cur.add(c));
  setLocSel(cur);
}
function locMSClear() { setLocSel(null); }
function locMSOnly(kind) {
  const codes = allLocCodes().filter(c => c && (kind === 'direct' ? /-D$/i.test(c) : !/-D$/i.test(c)));
  setLocSel(new Set(codes));
}
document.addEventListener('click', e => {
  const p = document.getElementById('locMSPanel');
  if (p && p.classList.contains('open') && e.target.isConnected && !e.target.closest('#locMS')) toggleLocMenu(false);
});
function locTag(loc) {
  if (!isMultiLocView()) return '';
  const list = Array.isArray(loc) ? loc : [loc];
  return list.map(l => ` <span class="loc-tag" title="${esc(locDesc(l))}">${esc(l === NO_LOC ? 'NO LOC' : l)}</span>`).join('');
}

function refreshLocationUI() {
  if (locSel) {
    const codes = allLocCodes();
    const keep = [...locSel].filter(c => codes.includes(c));
    locSel = keep.length && keep.length < codes.length ? new Set(keep) : null;
  }
  renderLocMenu();
  renderCompanyUI();
  renderLocationSettings();
  updateReportLocLabels();
}

function updateReportLocLabels() {
  const txt = !hasMultiLoc() ? '' : locSelText(true);
  document.querySelectorAll('.report-header').forEach(h => {
    let el = h.querySelector('.report-loc');
    if (!el) { el = document.createElement('div'); el.className = 'report-loc'; h.appendChild(el); }
    el.innerText = txt;
  });
}

// List of PO lines that were received at another location (PO location → GRN location)
function missingPONote() {
  const miss = {};
  rawGRNList.forEach(g => { if (g.poNo && !g.matched) { const k = up(g.poNo); const m = miss[k] || (miss[k] = { po: g.poNo, iso: g.poIso || '', locs: new Set(), creds: new Set() }); m.locs.add(g.loc); m.creds.add(g.creditorName); } });
  const list = Object.values(miss).sort((a, b) => a.iso.localeCompare(b.iso));
  if (!list.length) return '';
  const first = list[0].iso, last = list[list.length - 1].iso;
  return `<div class="cmp-note note-warn" style="margin:8px 0 0 22px;">⚠ ${list.length} PO(s) quoted on your GRNs are <b>not uploaded</b> (PO dates ${first ? dateDMY(first) : '?'} – ${last ? dateDMY(last) : '?'}), so the portal cannot see their PO location and they cannot appear in this list.
    Upload a PO Detail Listing that covers those dates to include them. <details style="margin-top:4px;"><summary style="cursor:pointer;">Show the missing POs</summary>
    <div class="small-text" style="max-height:220px;overflow:auto;margin-top:4px;">${list.map(m => `<div><b>${esc(m.po)}</b> ${m.iso ? dateDMY(m.iso) : ''} · ${esc([...m.creds].join(', '))} · received at ${esc([...m.locs].sort().join(', '))}</div>`).join('')}</div></details></div>`;
}
function movedPOTable() {
  if (!locFollowsGrn()) return '';
  const mv = [];
  rawPOList.forEach(p => { if (p.xfer) Object.keys(p.xfer).sort().forEach(l => mv.push({ p, l, q: p.xfer[l] })); });
  mv.sort((a, b) => a.p.iso.localeCompare(b.p.iso) || a.p.docNo.localeCompare(b.p.docNo));
  if (!mv.length) return missingPONote();
  return missingPONote() + `<details class="moved-po"${mv.length <= 15 ? ' open' : ''}><summary>PO received at another location (${new Set(mv.map(x => x.p.docNo)).size} PO, ${mv.length} line${mv.length > 1 ? 's' : ''}) — click to show</summary>
    <div class="moved-scroll"><table class="audit-table cmp-table"><thead><tr><th>PO No.</th><th>PO Date</th><th>Creditor</th><th>Item</th><th>PO location</th><th></th><th>GRN location</th><th class="text-right">Qty received</th><th class="text-right">GRN value (RM)</th></tr></thead><tbody>` +
    mv.map(({ p, l, q }) => `<tr><td>${poLink(p.docNo)}</td><td>${esc(p.docDate)}</td><td><span class="wrap">${esc(p.creditorName)}</span>${p.creditorCode ? ` <span class="muted">${esc(p.creditorCode)}</span>` : ''}</td>
      <td>${esc(p.itemCode)} <span class="wrap">${esc(p.description)}</span></td><td><b>${esc(p.loc || 'No location')}</b><div class="muted small-text">${esc(locDesc(p.loc) || '')}</div></td><td>→</td>
      <td><b>${esc(l)}</b><div class="muted small-text">${esc(locDesc(l) || '')}</div></td><td class="text-right">${qtyFmt(q)}<div class="muted small-text">of ${qtyFmt(p.qty)}</div></td><td class="text-right">${fmt(Math.min(q, p.qty) * p.unitCost)}</td></tr>`).join('') + '</tbody></table></div></details>';
}

// --- Settings page: location code list ---
function renderLocationSettings() {
  const box = document.getElementById('locationList');
  if (!box) return;
  const tg = document.getElementById('locFollowGrn');
  if (tg) {
    const moved = new Set(rawPOList.filter(p => p.xfer).map(p => p.docNo)).size;
    tg.innerHTML = `<label class="auth-check"><input type="checkbox" ${locFollowsGrn() ? 'checked' : ''} onchange="setLocFollowGrn(this.checked)">
      <b>GRN follows the receiving location</b> — when a PO is received at another location, the PO amount and its balance stay at the PO location, and the location that received the goods shows the GRN amount in both Previous PO Bal. B/F and GRN (Summary PO vs GRN).</label>
      ${locFollowsGrn() ? `<div class="muted small-text" style="margin-left:22px;">${moved} PO(s) received at another location.</div>` : ''}${movedPOTable()}`;
  }
  const master = store.locMaster || {};
  const codes = [...new Set(Object.keys(master).concat(allLocCodes().filter(c => c !== NO_LOC)))].sort();
  const poCnt = {}, grnCnt = {};
  rawPOList.forEach(p => poCnt[p.loc] = (poCnt[p.loc] || 0) + 1);
  rawGRNList.forEach(g => grnCnt[g.loc] = (grnCnt[g.loc] || 0) + 1);
  const info = document.getElementById('locMasterInfo');
  if (info) info.innerHTML = Object.keys(master).length
    ? `✓ ${Object.keys(master).length} locations from <b>${esc((store.meta && store.meta.locFile) || 'Stock Location Listing')}</b>${store.meta && store.meta.locLoadedAt ? ` <span class="muted">(uploaded ${esc(store.meta.locLoadedAt)})</span>` : ''}`
    : '<span style="color:#c2410c;">Not uploaded yet — locations show as codes only.</span>';
  if (!codes.length) { box.innerHTML = '<p class="muted">No locations yet.</p>'; return; }
  box.innerHTML = `<table class="audit-table loc-master-table"><thead><tr>
      <th>Code</th><th>Description</th><th class="text-right">PO lines</th><th class="text-right">GRN lines</th></tr></thead><tbody>` +
    codes.map(c => `<tr class="${poCnt[c] || grnCnt[c] ? '' : 'loc-unused'}">
      <td><b>${esc(c)}</b></td>
      <td>${master[c] ? esc(master[c]) : '<span style="color:#c2410c;">not in Stock Location Listing</span>'}</td>
      <td class="text-right">${poCnt[c] || '-'}</td><td class="text-right">${grnCnt[c] || '-'}</td></tr>`).join('') +
    ((poCnt[NO_LOC] || grnCnt[NO_LOC]) ? `<tr><td><i>(blank)</i></td><td class="muted">Lines without a location</td>
      <td class="text-right">${poCnt[NO_LOC] || '-'}</td><td class="text-right">${grnCnt[NO_LOC] || '-'}</td></tr>` : '') +
    '</tbody></table>';
}

// ----------------------------------------------------
// Navigation
// ----------------------------------------------------
const TAB_TITLES = {
  'tab-upload': 'Upload Monthly Files',
  'tab-settings': 'Settings',
  'tab-location-summary': 'All Locations Summary',
  'tab-month-compare': 'Month Comparison',
  'tab-po-grn-summary': 'Summary PO vs GRN',
  'tab-po-outstanding': 'PO Outstanding',
  'tab-po-completed': 'PO Completed',
  'tab-grn-details': 'GRN Received Listing',
  'tab-price-check': 'Price Check (PO vs GRN)',
  'tab-creditor-bal': 'Creditor Balances'
};

// Sidebar groups (parent / child) — open or closed, remembered on this PC
function menuGroupState() { try { return JSON.parse(localStorage.getItem('menuGroupsClosed') || '{}'); } catch (e) { return {}; } }
function applyMenuGroups() {
  const closed = menuGroupState();
  document.querySelectorAll('.menu-group').forEach(g => {
    const k = g.getAttribute('data-group'), isClosed = !!closed[k];
    g.classList.toggle('closed', isClosed);
    const c = g.querySelector('.caret'); if (c) c.textContent = isClosed ? '▸' : '▾';
    document.querySelectorAll(`.menu-item[data-parent="${k}"]`).forEach(el => { el.style.display = isClosed && !el.classList.contains('active') ? 'none' : ''; });
  });
}
function toggleMenuGroup(k) {
  const closed = menuGroupState();
  closed[k] = !closed[k];
  try { localStorage.setItem('menuGroupsClosed', JSON.stringify(closed)); } catch (e) { }
  applyMenuGroups();
}
function switchNavTab(tabId, element) {
  document.querySelectorAll('.menu-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-view').forEach(el => el.classList.remove('active'));
  const menuEl = element || document.querySelector(`.menu-item[data-tab="${tabId}"]`);
  if (menuEl) menuEl.classList.add('active');
  applyMenuGroups();
  const target = document.getElementById(tabId);
  if (target) target.classList.add('active');
  currentActiveTab = tabId;
  const titleEl = document.getElementById('pageTitleDisplay');
  if (titleEl) titleEl.innerText = TAB_TITLES[tabId] || '';
  document.body.classList.toggle('on-settings', tabId === 'tab-settings' || tabId === 'tab-month-compare' || tabId === 'tab-po-grn-summary');
  renderActiveTab();
}

const RENDERERS = {
  'tab-location-summary': () => renderLocationSummary(),
  'tab-month-compare': () => renderMonthCompare(),
  'tab-po-grn-summary': () => renderPoGrnSummary(),
  'tab-po-outstanding': () => renderPOOutstanding(),
  'tab-po-completed': () => renderPOCompleted(),
  'tab-grn-details': () => renderGRNDetails(),
  'tab-price-check': () => renderPriceCheck(),
  'tab-creditor-bal': () => renderCreditorBalances(),
  'tab-upload': () => { updateUploadSummary(); renderUploadPage(); updateKPIs(getScopedPOLines()); },
  'tab-settings': () => {
    if (cloudMode) renderCloudInfo(); else renderFolderInfo().catch(e => { const b = document.getElementById('folderInfo'); if (b) b.innerHTML = '<p class="note-warn">Error: ' + esc(e.message) + '</p>'; });
    renderLocationSettings(); renderCompanyUI(); renderUserAdmin(); renderActivityLog(); renderCredRules(); renderBackupCard(); updateKPIs(getScopedPOLines());
  }
};

const TAB_TBODY = {
  'tab-location-summary': 'locSummaryTbody',
  'tab-month-compare': 'cmpBody',
  'tab-settings': 'folderInfo',
  'tab-po-grn-summary': 'sumBody',
  'tab-po-outstanding': 'poOutBody',
  'tab-po-completed': 'poDoneBody',
  'tab-grn-details': 'grnDetailTbody',
  'tab-price-check': 'pcBody',
  'tab-creditor-bal': 'creditorBalTbody'
};

// Wrapping every render in try/catch means one bad row can never freeze the portal
function renderActiveTab() {
  const fn = RENDERERS[currentActiveTab];
  if (!fn) return;
  try {
    recalculateTransfers();
    fn();
  } catch (err) {
    console.error(err);
    const tb = document.getElementById(TAB_TBODY[currentActiveTab]);
    if (tb) tb.innerHTML = `<tr><td colspan="8" class="empty-state" style="color:#dc2626;">Something went wrong building this report: ${esc(err.message)}</td></tr>`;
  }
}

let filterTimer = null;
function onGlobalFilterChange() {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(renderActiveTab, 200);
}

function resetFilters() {
  document.getElementById('headerSearchInput').value = '';
  setDefaultDateRange();
  renderActiveTab();
}

// Sets the date boxes to cover all loaded data
function setDefaultDateRange() {
  const poDates = rawPOList.map(p => p.iso).filter(Boolean).sort();
  const grnDates = rawGRNList.map(g => g.grnIso).filter(Boolean).sort();
  const all = poDates.concat(grnDates).sort();
  const first = all.length ? all[0].substring(0, 8) + '01' : '2020-01-01';
  const last = all.length ? all[all.length - 1] : '2028-12-31';
  document.getElementById('grnEndDate').value = last;
  const f = document.getElementById('dateFrom');
  if (f) f.value = first;
}

// ----------------------------------------------------
// Printing
// ----------------------------------------------------
function triggerPrint(mode) {
  document.body.classList.remove('print-mode-simple', 'print-mode-details');
  document.body.classList.add(mode === 'details' ? 'print-mode-details' : 'print-mode-simple');
  setTimeout(() => window.print(), 100);
}
window.addEventListener('afterprint', () => {
  document.body.classList.remove('print-mode-simple', 'print-mode-details');
});

// ----------------------------------------------------
// Filters
// ----------------------------------------------------
function getSearchFilter() {
  const el = document.getElementById('headerSearchInput');
  return el ? el.value.trim().toUpperCase() : '';
}
function getRange(startId, endId) {
  const s = document.getElementById(startId), e = document.getElementById(endId);
  return { start: (s && s.value) || '1970-01-01', end: (e && e.value) || '2099-12-31' };
}
// Date From – To.
//  To   = "as at": every GRN up to this date counts as received (balances stay correct).
//  From = start of the period shown: POs (PO date) and GRNs (GRN date) from this date are listed.
function asAtDate() { const e = document.getElementById('grnEndDate'); return (e && e.value) || '2099-12-31'; }
function fromDate() { const e = document.getElementById('dateFrom'); return (e && e.value) || '1970-01-01'; }
function getPODateRange() { return { start: fromDate(), end: asAtDate() }; }
function getGRNDateRange() { return { start: fromDate(), end: asAtDate() }; }

function poMatchesSearch(p, q) {
  if (!q) return true;
  return up(p.docNo).includes(q) || up(p.creditorCode).includes(q) || up(p.creditorName).includes(q) ||
    up(p.itemCode).includes(q) || up(p.description).includes(q) || up(locName(p.loc)).includes(q);
}
function grnMatchesSearch(g, q) {
  if (!q) return true;
  return up(g.grnNo).includes(q) || up(g.poNo).includes(q) || up(g.creditorCode).includes(q) ||
    up(g.creditorName).includes(q) || up(g.itemCode).includes(q) || up(g.description).includes(q) ||
    up(locName(g.loc)).includes(q);
}

// PO lines inside the location + PO date range + search box
function getScopedPOLines(month, ignoreLoc) {
  const r = getPODateRange();
  const q = getSearchFilter();
  return rawPOList.filter(p =>
    (ignoreLoc || locAllowed(p.loc)) &&
    p.iso >= r.start && p.iso <= r.end &&
    (!month || month === 'ALL' || p.yymm === month) &&
    poMatchesSearch(p, q));
}
function getScopedGRNLines(ignoreLoc) {
  const r = getGRNDateRange();
  const q = getSearchFilter();
  return rawGRNList.filter(g =>
    (ignoreLoc || locAllowed(g.loc)) &&
    g.grnIso >= r.start && g.grnIso <= r.end && grnMatchesSearch(g, q));
}

// ----------------------------------------------------
// File loading
// ----------------------------------------------------
function handlePOFile(e) { const f = e.target.files[0]; e.target.value = ''; if (f) uploadFiles([f], 'po'); }
function handleGRNFile(e) { const f = e.target.files[0]; e.target.value = ''; if (f) uploadFiles([f], 'grn'); }

// --- 4. Creditor Listing (code → official name) ---
function parseCreditorListing(rows) {
  const out = {};
  rows.forEach(r => {
    if (!r) return;
    const code = cell(r, 0), name = cell(r, 1);
    if (/^\d{2,4}-[A-Z0-9]+$/i.test(code) && name) out[code.toUpperCase()] = name;
  });
  return out;
}
function handleCredFile(e) { const f = e.target.files[0]; e.target.value = ''; if (f) uploadFiles([f], 'cred'); }
function handleLocFile(e) { const f = e.target.files[0]; e.target.value = ''; if (f) uploadFiles([f], 'loc'); }

// Keep every month: lines dated inside the new file's date range are replaced,
// everything before / after that range is kept.
function mergeByDate(oldList, newList, dateKey, what) {
  const dates = newList.map(x => x[dateKey]).filter(Boolean).sort();
  if (!oldList || !oldList.length || !dates.length) return { list: newList, label: 'first upload' };
  const from = dates[0], to = dates[dates.length - 1];
  const kept = oldList.filter(x => !x[dateKey] || x[dateKey] < from || x[dateKey] > to);
  const replaced = oldList.length - kept.length;
  const oldDates = oldList.map(x => x[dateKey]).filter(Boolean).sort();
  const msg = `Saved ${what} data: ${dateDMY(oldDates[0])} – ${dateDMY(oldDates[oldDates.length - 1])} (${oldList.length} lines)\n` +
    `New file: ${dateDMY(from)} – ${dateDMY(to)} (${newList.length} lines)\n\n` +
    `OK = KEEP the other months and update only ${dateDMY(from)} – ${dateDMY(to)}  (recommended)\n` +
    `       → ${kept.length} older/other lines kept, ${replaced} lines in this period replaced\n\n` +
    `Cancel = choose whether to REPLACE ALL saved ${what} data with this file`;
  if (confirm(msg)) return { list: kept.concat(newList), label: `kept other months, updated ${dateDMY(from)} – ${dateDMY(to)}` };
  if (confirm(`REPLACE ALL saved ${what} data (${oldList.length} lines) with only this file?\nOlder months will be removed.\n\nOK = replace all · Cancel = do nothing`))
    return { list: newList, label: 'replaced all' };
  return null;
}
// Upload page: which months are saved
function monthCoverageHtml() {
  const m = {};
  store.po.forEach(p => { const k = p.yymm; if (k && k !== '0000') (m[k] = m[k] || { po: 0, grn: 0, poDocs: new Set() }).po++, m[k].poDocs.add(p.docNo); });
  store.grn.forEach(g => { const k = g.grnYYMM; if (k && k !== '0000') (m[k] = m[k] || { po: 0, grn: 0, poDocs: new Set() }).grn++; });
  const ks = Object.keys(m).sort();
  if (!ks.length) return '';
  const all = [];
  for (let k = ks[0]; k <= ks[ks.length - 1]; k = addMonth(k, 1)) all.push(k);
  return `<div class="cov-title">Saved months (${esc(companyDisplay(db.current))})</div><div class="cov-grid">` + all.map(k => {
    const x = m[k] || { po: 0, grn: 0, poDocs: new Set() };
    const cls = x.po && x.grn ? 'ok' : (x.po || x.grn ? 'half' : 'none');
    return `<div class="cov ${cls}" title="${x.poDocs.size} POs · ${x.po} PO lines · ${x.grn} GRN lines"><b>${monApos(k)}</b>
      <span>PO ${x.po ? '✓' : '✗'} · GRN ${x.grn ? '✓' : '✗'}</span></div>`;
  }).join('') + '</div><div class="muted small-text">Each month: export just that month (PO + GRN) and upload — earlier months are kept. Re-uploading a month replaces that month only.</div>';
}

// Excel (.xlsx) export from AutoCount: read it in the browser (no internet needed) and turn
// every sheet into the same rows a CSV gives. Old .xls uses the SheetJS library if it loaded.
async function unzipEntries(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('this is not an .xlsx file');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const files = {};
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    files[dec.decode(u8.subarray(p + 46, p + 46 + nl))] = { method, csize, off };
    p += 46 + nl + xl + cl;
  }
  const raw = name => {
    const f = files[name];
    if (!f) return null;
    const start = f.off + 30 + dv.getUint16(f.off + 26, true) + dv.getUint16(f.off + 28, true);
    const data = u8.subarray(start, start + f.csize);
    if (f.method === 0) return new Blob([data]).stream();
    if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot open .xlsx — please update Chrome/Edge or export as CSV');
    return new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  };
  // whole file as text (small parts)
  const read = async name => { const st = raw(name); return st ? new TextDecoder().decode(await new Response(st).arrayBuffer()) : null; };
  // big sheet: hand the text over piece by piece
  const each = async (name, onText) => {
    const st = raw(name); if (!st) return;
    const rd = st.getReader(), td = new TextDecoder();
    for (;;) { const { done, value } = await rd.read(); if (done) break; onText(td.decode(value, { stream: true })); }
    onText(td.decode());
  };
  return { names: Object.keys(files), read, each };
}
function xmlText(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) =>
    e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'amp' ? '&' : e === 'quot' ? '"' : e === 'apos' ? "'" :
    String.fromCharCode(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));
}
async function xlsxRows(u8) {
  const z = await unzipEntries(u8);
  // shared strings (rich text: join every <t>)
  const sst = (await z.read('xl/sharedStrings.xml')) || '';
  const shared = [];
  sst.replace(/<si>([\s\S]*?)<\/si>/g, (m, inner) => {
    let t = ''; inner.replace(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, (m2, x) => { t += x; return ''; });
    shared.push(xmlText(t)); return '';
  });
  // which cell styles are dates
  const st = (await z.read('xl/styles.xml')) || '';
  const fmts = {};
  st.replace(/<numFmt\s[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g, (m, id, code) => { fmts[id] = xmlText(code); return ''; });
  const isDateFmt = id => {
    id = +id;
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || (id >= 27 && id <= 36) || (id >= 50 && id <= 58)) return true;
    const code = (fmts[id] || '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    return /[dmy]/i.test(code) && !/^[#0.,\s%]*$/.test(code);
  };
  const xfsBlock = (st.match(/<cellXfs[\s\S]*?<\/cellXfs>/) || [''])[0];
  const dateStyle = (xfsBlock.match(/<xf\s[^>]*?\/?>/g) || []).map(x => isDateFmt((x.match(/numFmtId="(\d+)"/) || [0, 0])[1]));
  const d1904 = /date1904="(1|true)"/.test((await z.read('xl/workbook.xml')) || '');
  const pad = v => String(v).padStart(2, '0');
  const serialToDMY = v => {
    const d = new Date((Math.floor(v + 1e-9) + (d1904 ? 1462 : 0) - 25569) * 86400000);
    return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
  };
  const colNum = ref => { let c = 0; for (let i = 0; i < ref.length; i++) { const k = ref.charCodeAt(i); if (k < 65 || k > 90) break; c = c * 26 + k - 64; } return c - 1; };
  const cellRe = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  const doRow = (body, rows) => {
    const row = [];
    if (body && body.indexOf('<v') >= 0 || (body && body.indexOf('<is>') >= 0)) {
      let m; cellRe.lastIndex = 0;
      while ((m = cellRe.exec(body))) {
        const attrs = m[1], inner = m[2];
        if (!inner) continue;
        const t = (attrs.match(/\bt="(\w+)"/) || [0, 'n'])[1];
        const ref = (attrs.match(/\br="([A-Z]+)/) || [0, ''])[1];
        let v = '';
        if (t === 'inlineStr') v = xmlText((inner.match(/<is>([\s\S]*?)<\/is>/) || [0, ''])[1]);
        else {
          const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
          if (!vm) continue;
          v = vm[1];
          if (t === 's') v = shared[+v] || '';
          else if (t === 'n') { const num = +v; const s = +((attrs.match(/\bs="(\d+)"/) || [0, 0])[1]); v = dateStyle[s] ? serialToDMY(num) : String(Number(num.toPrecision(15))); }
          else v = xmlText(v);
        }
        v = String(v).trim();
        const dm = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2})$/.exec(v);        // 06-03-26 -> 06-03-2026
        if (dm) v = `${pad(dm[1])}-${pad(dm[2])}-20${dm[3]}`;
        if (v === '') continue;
        const ci = ref ? colNum(ref) : row.length;
        while (row.length < ci) row.push('');
        row[ci] = v;
      }
    }
    if (row.length) rows.push(row);                     // AutoCount's Excel has many empty spacer rows: skip them
  };
  const sheets = z.names.filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)));
  const rows = [];
  for (const name of sheets) {
    let buf = '';
    await z.each(name, txt => {
      buf += txt;
      let start = 0;
      for (;;) {
        const i = buf.indexOf('<row', start);
        if (i < 0) { buf = buf.slice(-8); break; }
        const gt = buf.indexOf('>', i);
        if (gt < 0) { buf = buf.slice(i); break; }
        if (buf[gt - 1] === '/') { start = gt + 1; continue; }           // <row ... /> = empty row
        const end = buf.indexOf('</row>', gt);
        if (end < 0) { buf = buf.slice(i); break; }
        doRow(buf.slice(gt + 1, end), rows);
        start = end + 6;
      }
    });
  }
  return rows;
}
function xlsRowsWithSheetJS(u8) {
  if (typeof XLSX === 'undefined') throw new Error('old .xls files need internet to open. In AutoCount please export as .xlsx or CSV instead.');
  const wb = XLSX.read(u8, { type: 'array' });
  const rows = [];
  wb.SheetNames.forEach(n => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '', dateNF: 'dd-mm-yyyy' })
    .forEach(r => rows.push(r.map(x => String(x).trim()))));
  return rows;
}
function readCSV(file, callback) {
  if (/\.xlsx?$/i.test(file.name)) {
    const xr = new FileReader();
    xr.onload = async ev => {
      let rows;
      try {
        const u8 = new Uint8Array(ev.target.result);
        rows = (u8[0] === 0x50 && u8[1] === 0x4b) ? await xlsxRows(u8) : xlsRowsWithSheetJS(u8);
      } catch (err) { console.error(err); return alert('Could not read this Excel file: ' + err.message); }
      try { callback(rows); } catch (err) { console.error(err); alert('Could not read this file: ' + err.message); }
    };
    xr.readAsArrayBuffer(file);
    return;
  }
  const reader = new FileReader();
  reader.onload = ev => {
    try { callback(parseCSVText(ev.target.result)); }
    catch (err) { console.error(err); alert('Could not read this file: ' + err.message); }
  };
  reader.readAsText(file);
}

// Proper CSV parser: handles quoted commas, "" escapes and line breaks inside quotes
function parseCSVText(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur.trim()); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur.trim()); rows.push(row); row = []; cur = '';
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur.trim()); rows.push(row); }
  return rows;
}

function detectReportTitle(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const t = rows[i].find(c => /Listing/i.test(c || ''));
    if (t) return t;
  }
  return '';
}

function detectCompany(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    if (rows[i].some(c => /^Page \d+ of/i.test(c || '')) && rows[i][0]) {
      return rows[i][0].replace(/\s*\([^)]*\)\s*$/, '').trim();
    }
  }
  return '';
}

// Every AutoCount export has the company name on row 4 ("MASIH JAYA SDN BHD (142558-H)").
// Uploads are saved under that company, so each company keeps its own data.
function useCompanyFromFile(rows) {
  const name = detectCompany(rows) || db.current || 'My Company';
  if (name === db.current) return;
  const cur = db.companies[db.current];
  const curEmpty = !cur || (!cur.po.length && !cur.grn.length && !Object.keys(cur.locMaster || {}).length);
  if (!db.companies[name] && (!cur || curEmpty || !cur.meta.company)) {
    // first upload, or data saved by an older version without a company name: adopt this name
    db.companies[name] = cur || store;
    if (cur) { delete db.companies[db.current]; pendingLog.push({ hidden: true, part: 'rename', from: db.current, company: name }); }
  } else if (!db.companies[name]) {
    db.companies[name] = emptyCompany();
    showToast(`New company "${name}" added. Its data is saved separately — use the Company box at the top to switch.`);
  } else {
    showToast(`Switched to company "${name}".`);
  }
  db.companies[name].meta.company = name;
  switchCompany(name, true);
}

function showToast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.innerText = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 5000);
}

// Index of the currency cell ("RM") that is followed by the sub total
// The currency column (RM) sits just before the amount. Take the right-most 2–3 letter code that is
// followed by a number, so a short description such as "KEY" or "OIL" is not mistaken for it.
const KNOWN_CUR = /^(RM|MYR|USD|SGD|CNY|RMB|EUR|GBP|JPY|THB|IDR|HKD|AUD|TWD|NTD|INR|PHP|VND|KRW|NZD|CHF|CAD|BND)$/;
function findCurrency(r, from) {
  let best = -1, bestKnown = -1;
  for (let i = from; i < r.length; i++) {
    if (!isCurrency(cell(r, i))) continue;
    for (let j = i + 1; j < r.length; j++) {
      if (cell(r, j) === '') continue;
      if (isNum(cell(r, j))) { best = i; if (KNOWN_CUR.test(cell(r, i))) bestKnown = i; }
      break;
    }
  }
  return bestKnown >= 0 ? bestKnown : best;
}
function nonEmptyIdx(r, from, to) {
  const out = [];
  for (let i = from; i <= Math.min(to, r.length - 1); i++) if (cell(r, i) !== '') out.push(i);
  return out;
}
function isKnownLoc(code) { return !!(store.locMaster && store.locMaster[code]); }

// --- Stock Location Listing: [0]=code [1]=description ---
function parseStockLocationCSV(rows) {
  const out = {};
  let started = false;
  rows.forEach(r => {
    if (!r) return;
    const c0 = cell(r, 0), c1 = cell(r, 1);
    if (/^Location$/i.test(c0) && /^Description$/i.test(c1)) { started = true; return; }
    if (!started) return;
    if (r.some(c => /End of Report/i.test(c || ''))) { started = false; return; }
    if (c0 && c1) out[c0] = c1;
  });
  return out;
}

// --- PO Detail Listing ---
// Columns are found by their content (not fixed positions), so adding the
// Location column does not break anything:
//  [item] [desc] [qty] [unit price] [disc?] [RM] [sub total] [PO no] [PO date] [creditor code] [creditor name] [location]
function parseAutoCountPOCSV(rows) {
  // Layout grouped by Location ("Location  HQ  Headquarter" rows, date before PO no.)
  const byLoc = rows.some(r => r && /^Location$/i.test(cell(r, 0)) && nonEmptyIdx(r, 1, r.length).length);
  // date BEFORE the PO number (e.g. "01-08-2026, PO2608-001, item ... RM, 500.00, S14KEL"), with or without location groups
  const dateFirst = rows.some(r => {
    if (!r) return false;
    for (let i = 1; i < Math.min(r.length, 10); i++) {
      if (isPONo(cell(r, i))) return nonEmptyIdx(r, 0, i - 1).some(j => isDate(cell(r, j)));
    }
    return false;
  });
  return (byLoc || dateFirst) ? parsePOByLocation(rows) : parsePOByCreditor(rows);
}

// --- PO Detail Listing grouped by LOCATION ---
//  group row: [Location] [code] [description]
//  line row A: [PO date] [PO no] [item code] ... [RM] [sub total] [location] (+ optional creditor code / name)
//  line row B: [description] [unit price] [qty]          (or everything on one row)
function parsePOByLocation(rows) {
  const out = [];
  const names = {};
  let grp = '', cur = null, credGrp = { code: '', name: '' };
  const finish = () => {
    if (cur && (cur.qty || cur.lineSubTotal)) {
      cur.unitCost = cur.qty ? cur.lineSubTotal / cur.qty : cur.unitPrice;
      out.push(cur);
    }
    cur = null;
  };
  const fillDetail = (r, idx) => {
    if (!idx.length) return;
    const txt = idx.filter(i => !isNum(cell(r, i)) && !isDate(cell(r, i)));
    const nums = idx.filter(i => isNum(cell(r, i)));
    const plain = nums.filter(i => !/%$/.test(cell(r, i)));
    if (txt.length && !cur.description) cur.description = cell(r, txt[0]);
    if (plain.length) cur.qty = num(r[plain[plain.length - 1]]);
    if (plain.length > 1) cur.unitPrice = num(r[plain[plain.length - 2]]);
    const d = nums.map(i => cell(r, i)).find(v => /%$/.test(v));
    if (d) cur.disc = d;
  };

  rows.forEach(r => {
    if (!r || r.length < 3) return;
    const c0 = cell(r, 0);
    if (/^Location$/i.test(c0)) {
      finish();
      const nz = nonEmptyIdx(r, 1, r.length);
      grp = nz.length ? cell(r, nz[0]) : '';
      if (grp && nz.length > 1) names[grp] = cell(r, nz[1]);
      return;
    }
    // grouped by creditor: "Creditor Code | 411-A001 | Agri Horticultural ..."
    if (/^Creditor( Code)?\s*:?$/i.test(c0)) {
      finish();
      const nz = nonEmptyIdx(r, 1, r.length);
      credGrp = { code: nz.length ? cell(r, nz[0]) : '', name: nz.length > 1 ? cell(r, nz[1]) : '' };
      return;
    }
    if (/Count:/i.test(c0) || r.some(c => /(Group|Grand) Total/i.test(c || ''))) { finish(); return; }
    if (r.some(c => /^(Page \d+ of.*|Date :|User ID :|Unit Price|Sub Total|Doc No\.)$/i.test((c || '').trim()))) return;

    let pi = -1;
    for (let i = 0; i < Math.min(r.length, 10); i++) if (isPONo(cell(r, i))) { pi = i; break; }

    if (pi >= 0) {
      finish();
      const ci = findCurrency(r, pi + 1);
      const dates = nonEmptyIdx(r, 0, r.length).filter(i => isDate(cell(r, i)));
      const docDate = dates.length ? cell(r, dates[0]) : '';
      const itemIdx = nonEmptyIdx(r, pi + 1, r.length).find(i => !isDate(cell(r, i)));
      const subIdx = ci >= 0 ? nonEmptyIdx(r, ci + 1, r.length)[0] : -1;
      const tail = subIdx >= 0 ? nonEmptyIdx(r, subIdx + 1, r.length).map(i => cell(r, i)) : [];
      const isCredCode = v => /^\d{2,4}-[A-Z0-9]+$/i.test(v);
      let loc = tail.includes(grp) ? grp : (tail.find(isKnownLoc) || tail.find(v => !isCredCode(v)) || grp);
      const credI = tail.findIndex(v => isCredCode(v) && v !== loc);
      const nameCand = credI >= 0 ? tail[credI + 1] : '';
      const credName = nameCand && nameCand !== loc && !isKnownLoc(nameCand) && !isCredCode(nameCand) ? nameCand : '';
      const iso = toISO(docDate);
      cur = {
        docNo: cell(r, pi), docDate, iso, yymm: isoToYYMM(iso),
        creditorCode: credI >= 0 ? tail[credI] : credGrp.code,
        creditorName: credI >= 0 ? credName : credGrp.name,
        itemCode: itemIdx !== undefined ? cell(r, itemIdx) : 'MISC',
        description: '', qty: 0, unitPrice: 0, disc: '',
        lineSubTotal: subIdx >= 0 ? num(r[subIdx]) : 0,
        loc: (loc || '').trim()
      };
      if (ci >= 0 && itemIdx !== undefined) fillDetail(r, nonEmptyIdx(r, itemIdx + 1, ci - 1));
      return;
    }
    if (cur) fillDetail(r, nonEmptyIdx(r, 0, r.length));
  });
  finish();
  out.locNames = names;
  return out;
}

// --- PO Detail Listing grouped by CREDITOR (original layout) ---
function parsePOByCreditor(rows) {
  const out = [];
  let credCode = '', credName = '';

  rows.forEach(r => {
    if (!r || r.length < 5) return;
    const c0 = cell(r, 0);
    if (c0 === 'Creditor Code') {
      const nz = nonEmptyIdx(r, 1, r.length);
      credCode = nz.length ? cell(r, nz[0]) : '';
      credName = nz.length > 1 ? cell(r, nz[1]) : '';
      return;
    }
    // PO number followed by a date
    let di = -1, dti = -1;
    for (let i = 4; i < r.length; i++) {
      if (isPONo(cell(r, i))) {
        const nxt = nonEmptyIdx(r, i + 1, r.length)[0];
        if (nxt !== undefined && isDate(cell(r, nxt))) { di = i; dti = nxt; break; }
      }
    }
    if (di < 0) return;
    const docNo = cell(r, di), docDate = cell(r, dti);

    const ci = findCurrency(r, 4);
    if (ci < 0 || ci > di) return;
    const subIdx = nonEmptyIdx(r, ci + 1, di - 1)[0];
    const sub = subIdx !== undefined ? num(r[subIdx]) : 0;

    // item code / description = first two text cells; then qty, price, disc
    const before = nonEmptyIdx(r, 0, ci - 1);
    const itemIdx = before[0];
    const descIdx = before.length > 1 && !isNum(cell(r, before[1])) ? before[1] : -1;
    const nums = before.filter(i => i !== itemIdx && i !== descIdx);
    const qty = nums.length ? num(r[nums[0]]) : 0;
    const unitPrice = nums.length > 1 && !/%$/.test(cell(r, nums[1])) ? num(r[nums[1]]) : 0;
    const disc = nums.slice(1).map(i => cell(r, i)).find(s => /%$/.test(s)) || (nums.length > 2 ? cell(r, nums[2]) : '');
    if (qty === 0 && sub === 0) return;

    // after the date: creditor code, creditor name, then location
    const after = nonEmptyIdx(r, dti + 1, r.length);
    let loc = '';
    const rest = after.slice(2).map(i => cell(r, i));
    if (rest.length) loc = rest.find(isKnownLoc) || rest[rest.length - 1];
    else {
      // location column placed somewhere else: look for a known location code
      const k = r.map(c => (c || '').trim()).find((c, i) => i > ci && i !== dti && isKnownLoc(c) && c !== credCode);
      if (k) loc = k;
    }

    const iso = toISO(docDate);
    out.push({
      docNo, docDate, iso, yymm: isoToYYMM(iso),
      creditorCode: after.length ? cell(r, after[0]) : credCode,
      creditorName: after.length > 1 ? cell(r, after[1]) : credName,
      itemCode: itemIdx !== undefined ? cell(r, itemIdx) : 'MISC',
      description: descIdx >= 0 ? cell(r, descIdx) : '',
      qty, unitPrice, disc,
      lineSubTotal: sub || (cell(r, subIdx) === '' ? qty * unitPrice : 0),
      unitCost: qty ? (sub || 0) / qty : unitPrice,
      loc
    });
  });
  return out;
}

// --- Cancelled Purchase Order Detail Listing ---
//   [PO no] [item] [desc] [RM] [unit price] [qty] [sub total] [location] [cancel date] [cancel doc XPO..]
function parseCancelPOCSV(rows) {
  const out = [];
  let credCode = '', credName = '';
  rows.forEach(r => {
    const c0 = cell(r, 0);
    if (c0 === 'Creditor Code') { const v = nonEmptyIdx(r, 1, r.length); credCode = v.length ? cell(r, v[0]) : ''; credName = v.length > 1 ? cell(r, v[1]) : ''; return; }
    if (!isPONo(c0)) return;
    const cur = findCurrency(r, 1);
    if (cur < 0) return;
    const before = nonEmptyIdx(r, 1, r.length).filter(i => i < cur);
    const after = nonEmptyIdx(r, cur + 1, r.length);
    const nums = after.filter(i => isNum(cell(r, i)));
    if (nums.length < 3) return;
    const [pi, qi, si] = nums;
    const rest = after.filter(i => i > si).map(i => cell(r, i));
    const dateStr = rest.find(isDate) || '';
    const loc = rest.find(x => !isDate(x) && !/^X?PO/i.test(x) && x !== '') || '';
    const doc = rest.slice().reverse().find(x => !isDate(x) && x !== loc) || '';
    out.push({ poNo: c0, itemCode: before.length ? cell(r, before[0]) : '', description: before.length > 1 ? cell(r, before[before.length - 1]) : '',
      unitPrice: num(cell(r, pi)), qty: num(cell(r, qi)), amt: num(cell(r, si)), loc, iso: toISO(dateStr), date: dateStr, doc, creditorCode: credCode, creditorName: credName });
  });
  return out;
}

// --- GRN Detail Listing ---
// Each GRN line is ONE row or TWO rows:
//   row A: [GRN date] [GRN no] [item code] ... [location]
//   row B: [PO date] [PO no] [desc] [unit price] [qty] [RM] [sub total]
// Direct GRNs (not from a PO) have no PO date / PO no.
function parseAutoCountGRNCSV(rows) {
  const out = [];
  let credCode = '', credName = '';
  let pending = null; // GRN no/date/item/location waiting for its detail row

  rows.forEach(r => {
    if (!r || r.length < 5) return;
    const c0 = cell(r, 0);
    if (c0 === 'Creditor Code') {
      const nz = nonEmptyIdx(r, 1, r.length);
      credCode = nz.length ? cell(r, nz[0]) : '';
      credName = nz.length > 1 ? cell(r, nz[1]) : '';
      pending = null;
      return;
    }
    if (/Count:/i.test(c0) || r.some(c => /(Group|Grand) Total/i.test(c || ''))) { pending = null; return; }

    // GRN header part
    let gi = -1;
    for (let i = 1; i < Math.min(r.length, 12); i++) if (/^GRN/i.test(cell(r, i))) { gi = i; break; }

    const ci = findCurrency(r, 12);
    const subIdx = ci >= 0 ? nonEmptyIdx(r, ci + 1, r.length)[0] : -1;

    if (gi >= 0) {
      const dIdx = nonEmptyIdx(r, 0, gi - 1).filter(i => isDate(cell(r, i)));
      const itemIdx = nonEmptyIdx(r, gi + 1, r.length)[0];
      // two-row layout: the location is the last cell after the item code
      const tail = ci < 0 && itemIdx !== undefined ? nonEmptyIdx(r, itemIdx + 1, r.length).map(i => cell(r, i)) : [];
      pending = {
        grnNo: cell(r, gi),
        grnDate: dIdx.length ? cell(r, dIdx[dIdx.length - 1]) : '',
        itemCode: itemIdx !== undefined ? cell(r, itemIdx) : '',
        itemIdx: itemIdx !== undefined ? itemIdx : gi,
        loc: tail.length ? tail[tail.length - 1] : ''
      };
    }

    if (ci < 0 || !pending) return;   // no amounts on this row

    // PO no / date (left side)
    let poNo = '', poDate = '';
    for (let i = 0; i < Math.min(r.length, 6); i++) {
      const v = cell(r, i);
      if (!poNo && isPONo(v)) poNo = v;
      if (!poDate && isDate(v) && i < (gi >= 0 ? gi - 1 : 99)) poDate = v;
    }
    if (!poNo) poDate = '';

    // qty = last value before currency, unit price = the one before it
    const left = nonEmptyIdx(r, 0, ci - 1);
    const qtyIdx = left[left.length - 1];
    const prevIdx = left[left.length - 2];
    const qty = num(r[qtyIdx]);
    const unitPrice = prevIdx !== undefined && isNum(cell(r, prevIdx)) && prevIdx > 6 ? num(r[prevIdx]) : 0;
    const sub = subIdx >= 0 ? num(r[subIdx]) : qty * unitPrice;

    // description: first text cell after the item code / PO no that is not a number
    const descStart = gi >= 0 ? pending.itemIdx + 1 : 3;
    const descIdx = nonEmptyIdx(r, descStart, ci - 1).find(i => !isNum(cell(r, i)) && !isDate(cell(r, i)) && !(isPONo(cell(r, i)) && i < 6));
    // a location written on the detail row wins
    const detailTail = subIdx >= 0 ? nonEmptyIdx(r, subIdx + 1, r.length).map(i => cell(r, i)).filter(s => !isNum(s)) : [];
    const loc = (detailTail.length ? detailTail[detailTail.length - 1] : pending.loc) || '';

    const grnIso = toISO(pending.grnDate);
    out.push({
      grnNo: pending.grnNo, grnDate: pending.grnDate, grnIso, grnYYMM: isoToYYMM(grnIso),
      poNo, poDate, poIso: toISO(poDate),
      creditorCode: credCode, creditorName: credName,
      itemCode: pending.itemCode || 'MISC',
      description: descIdx !== undefined ? cell(r, descIdx) : '',
      qty, unitPrice, subTotal: sub, loc
    });
    pending = null; // a GRN header belongs to exactly one detail row
  });
  return out;
}

// ----------------------------------------------------
// Save / load data in this browser (IndexedDB – room for big files)
// ----------------------------------------------------
const IDB_NAME = 'autocount_portal', IDB_STORE = 'kv', IDB_KEY = 'store_v6';

function idbOpen() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error('IndexedDB not available'));
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(k) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const r = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(k);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbSet(k, v) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(v, k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbDel(k) {
  const db = await idbOpen();
  return new Promise(resolve => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function loadStore() {
  let d = null;
  try { d = await idbGet(IDB_KEY); } catch (e) { console.warn(e); }
  if (!d) { try { const raw = localStorage.getItem(IDB_KEY); if (raw) d = JSON.parse(raw); } catch (e) {} }
  if (d && d.companies) {
    db = d;
    Object.values(db.companies).forEach(fixCompany);
    if (!db.companies[db.current]) db.current = Object.keys(db.companies)[0] || '';
    store = db.companies[db.current] || emptyCompany();
    return;
  }

  // Data from v5 (one company)
  let s = null;
  try { s = await idbGet('store_v5'); } catch (e) {}
  if (!s) { try { const raw = localStorage.getItem('store_v5'); if (raw) s = JSON.parse(raw); } catch (e) {} }

  // Bring over data from earlier versions (no location codes in those)
  if (!s) {
    let po = [], grn = [], meta = {};
    try {
      const v4 = await idbGet('store_v4');
      if (v4 && v4.data) {
        Object.values(v4.data).forEach(d => { po = po.concat(d.po || []); grn = grn.concat(d.grn || []); meta = Object.assign(meta, d.meta || {}); });
        await idbDel('store_v4');
      }
    } catch (e) {}
    try {
      const raw = localStorage.getItem(OLD_STORAGE_KEY);
      if (raw && !po.length && !grn.length) {
        const old = JSON.parse(raw);
        po = old.po || []; grn = old.grn || []; meta = old.meta || {};
      }
      localStorage.removeItem(OLD_STORAGE_KEY);
    } catch (e) {}
    if (po.length || grn.length) {
      s = { version: 5, po: po.map(stripPO), grn: grn.map(stripGRN), meta, locMaster: {} };
      idbSet(IDB_KEY, s).catch(() => {});
    }
  }
  if (s) {
    fixCompany(s);
    let display = '';
    try { display = localStorage.getItem(COMPANY_KEY) || ''; } catch (e) {}
    const name = s.meta.company || display || 'My Company';
    if (display && display !== name) s.meta.displayName = display;
    db = { version: 6, current: name, companies: { [name]: s } };
    store = s;
    try { await idbSet(IDB_KEY, db); await idbDel('store_v5'); localStorage.removeItem('store_v5'); } catch (e) {}
  }
}
function fixCompany(c) {
  c.po = c.po || []; c.grn = c.grn || []; c.meta = c.meta || {}; c.locMaster = c.locMaster || {}; c.cancels = c.cancels || {}; c.poCreditors = c.poCreditors || {}; c.credMaster = c.credMaster || {};
  delete c.version;
}

// ----------------------------------------------------
// Companies
// ----------------------------------------------------
function companyDisplay(key) {
  const c = db.companies[key];
  return (c && c.meta.displayName) || key || 'My Company';
}
function switchCompany(name, keepView) {
  if (!db.companies[name]) return;
  db.current = name;
  store = db.companies[name];
  setCompanyName(companyDisplay(name));
  rebuildCombined();
  restoreLocSel();
  if (!keepView) {
    setDefaultDateRange();
    recalculateTransfers();
    refreshLocationUI();
    updateUploadSummary();
    renderActiveTab();
  }
}
function onCompanyPick(sel) { switchCompany(sel.value); }
function renderCompanyUI() {
  const keys = Object.keys(db.companies).sort();
  const box = document.querySelector('.header-co-box');
  const pick = document.getElementById('companyPicker');
  if (box) box.style.display = keys.length > 1 ? '' : 'none';
  if (pick) {
    pick.innerHTML = keys.map(k => `<option value="${esc(k)}">${esc(companyDisplay(k))}</option>`).join('');
    pick.value = db.current;
  }
  const list = document.getElementById('companyList');
  if (list) {
    list.innerHTML = !keys.length ? '<p class="muted">No company yet — it is added automatically when you upload a file.</p>' :
      `<table class="audit-table loc-master-table"><thead><tr><th>Company (from CSV)</th><th class="text-right">PO lines</th><th class="text-right">GRN lines</th><th class="text-right">Locations</th><th></th></tr></thead><tbody>` +
      keys.map(k => {
        const c = db.companies[k];
        return `<tr class="${k === db.current ? 'loc-selected' : ''}">
          <td><b>${esc(k)}</b>${c.meta.displayName ? `<br><span class="muted">shown as: ${esc(c.meta.displayName)}</span>` : ''}${k === db.current ? ' <span class="status-badge done">viewing</span>' : ''}</td>
          <td class="text-right">${c.po.length || '-'}</td><td class="text-right">${c.grn.length || '-'}</td>
          <td class="text-right">${Object.keys(c.locMaster || {}).length || '-'}</td>
          <td class="text-right">${k !== db.current ? `<button class="btn btn-settings btn-sm" onclick="switchCompany('${esc(k).replace(/'/g, "\\'")}')">View</button> ` : ''}<button class="btn btn-danger btn-sm" onclick="deleteCompany('${esc(k).replace(/'/g, "\\'")}')">Delete</button></td></tr>`;
      }).join('') + '</tbody></table>';
  }
}
function deleteCompany(name) {
  const c = db.companies[name];
  if (!c) return;
  if (!confirm(`Delete company "${companyDisplay(name)}" and all its saved data (${c.po.length} PO lines, ${c.grn.length} GRN lines)?`)) return;
  logAction(`Deleted company "${companyDisplay(name)}"`, name, 'delete');
  delete db.companies[name];
  const keys = Object.keys(db.companies);
  if (!keys.length) { db.current = ''; store = emptyCompany(); }
  if (db.current === name || !keys.length) {
    if (keys.length) switchCompany(keys[0]);
    else { afterDataChange(); }
  } else { saveStore(); renderCompanyUI(); }
}

// Keep only the fields we save (calculated fields are rebuilt each time)
function stripPO(p) {
  const { docNo, docDate, iso, yymm, creditorCode, creditorName, itemCode, description, qty, unitPrice, disc, lineSubTotal, unitCost } = p;
  return { docNo, docDate, iso, yymm, creditorCode, creditorName, itemCode, description, qty, unitPrice, disc, lineSubTotal, unitCost, loc: '' };
}
function stripGRN(g) {
  const { grnNo, grnDate, grnIso, grnYYMM, poNo, poDate, poIso, creditorCode, creditorName, itemCode, description, qty, unitPrice, subTotal } = g;
  return { grnNo, grnDate, grnIso, grnYYMM, poNo, poDate, poIso, creditorCode, creditorName, itemCode, description, qty, unitPrice, subTotal, loc: '' };
}

// Build the working lists used by every report
function rebuildCombined() {
  let seq = 0;
  rawPOList = store.po.map(p => Object.assign({}, p, {
    loc: (p.loc || '').trim(), locGuess: false, id: seq++, transferredQty: 0, balQty: p.qty, balCost: p.lineSubTotal, transVal: 0 }));
  rawGRNList = store.grn.map(g => Object.assign({}, g, { loc: (g.loc || '').trim(), matched: false }));
  // stable key per PO line (used to remember cancelled lines)
  const seen = {};
  rawPOList.forEach(p => { const k = up(p.docNo) + '|' + up(p.itemCode); seen[k] = (seen[k] || 0) + 1; p.ckey = k + '|' + seen[k]; });
  applyCancelImport();

  // PO file without a Location column: take the location from the GRN of that line
  if (rawPOList.length && rawPOList.every(p => !p.loc)) {
    const byLine = {}, byDoc = {};
    rawGRNList.forEach(g => {
      if (!g.poNo || !g.loc) return;
      const k = lineKey(g.poNo, g.itemCode);
      (byLine[k] = byLine[k] || {})[g.loc] = (byLine[k][g.loc] || 0) + 1;
      (byDoc[up(g.poNo)] = byDoc[up(g.poNo)] || {})[g.loc] = (byDoc[up(g.poNo)][g.loc] || 0) + 1;
    });
    const top = o => o ? Object.keys(o).sort((a, b) => o[b] - o[a])[0] : '';
    rawPOList.forEach(p => {
      const l = top(byLine[lineKey(p.docNo, p.itemCode)]) || top(byDoc[up(p.docNo)]);
      if (l) { p.loc = l; p.locGuess = true; }
    });
  } else if (locFollowsGrn()) {
    // Same GRN-to-PO-line matching as the reports (same location first).
    const index = {}, got = {}, byLoc = {};
    rawPOList.forEach(p => { const k = lineKey(p.docNo, p.itemCode); (index[k] = index[k] || []).push(p); got[p.id] = 0; });
    rawGRNList.filter(g => g.poNo && g.loc).sort((a, b) => (a.grnIso || '').localeCompare(b.grnIso || '')).forEach(g => {
      const lines = index[lineKey(g.poNo, g.itemCode)];
      if (!lines) return;
      let left = g.qty || 0;
      const desc = up(g.description);
      const score = p => grnLineScore(p, g, desc);
      const ordered = lines.slice().sort((x, y) => score(y) - score(x) || x.id - y.id);
      const give = (p, q) => { got[p.id] += q; const o = byLoc[p.id] || (byLoc[p.id] = {}); o[g.loc] = (o[g.loc] || 0) + q; };
      for (const p of ordered) {
        if (left <= EPS) break;
        const take = Math.min(p.qty - got[p.id], left);
        if (take <= EPS) continue;
        give(p, take); left -= take;
      }
      if (left > EPS) give(ordered[0], left);
    });
    // The PO line stays at its own location. Remember where it was received (p.xfer = { loc: qty })
    // so the GRN amount can be shown at the location that received the goods.
    rawPOList.forEach(p => {
      const o = byLoc[p.id];
      if (!o) return;
      const x = {};
      Object.keys(o).forEach(l => { if (l !== p.loc && o[l] > EPS) x[l] = o[l]; });
      if (Object.keys(x).length) p.xfer = x;
    });
  }
  // PO file without creditor columns: take the creditor from the GRN of that PO
  // Official names from the Creditor Listing (box 4) win over names in the PO / GRN files
  const master = store.credMaster || {};
  if (Object.keys(master).length) {
    rawPOList.forEach(p => { const n = p.creditorCode && master[up(p.creditorCode)]; if (n) p.creditorName = n; });
    rawGRNList.forEach(g => { const n = g.creditorCode && master[up(g.creditorCode)]; if (n) g.creditorName = n; });
  }
  // PO file with Creditor Code only: take the name from the GRN data
  if (rawPOList.some(p => p.creditorCode && !p.creditorName)) {
    const nameOf = {};
    rawGRNList.forEach(g => { if (g.creditorCode && g.creditorName) nameOf[up(g.creditorCode)] = g.creditorName; });
    rawPOList.forEach(p => { if (p.creditorCode && p.creditorName) nameOf[up(p.creditorCode)] = nameOf[up(p.creditorCode)] || p.creditorName; });
    rawPOList.forEach(p => { if (p.creditorCode && !p.creditorName) p.creditorName = nameOf[up(p.creditorCode)] || p.creditorCode; });
  }
  // 1) from the GRN of that PO  2) last supplier who delivered the same item  3) set by hand (wins)
  rawPOList.forEach(p => { p.credSource = p.creditorCode ? 'po' : ''; });
  if (rawPOList.some(p => !p.creditorCode)) {
    const cred = {}, byItem = {};
    rawGRNList.forEach(g => {
      if (!g.creditorCode) return;
      if (g.poNo && !cred[up(g.poNo)]) cred[up(g.poNo)] = [g.creditorCode, g.creditorName];
      const k = up(g.itemCode), cur = byItem[k];
      if (k && k !== 'MISC' && (!cur || g.grnIso > cur[2])) byItem[k] = [g.creditorCode, g.creditorName, g.grnIso];
    });
    const docGuess = {};
    rawPOList.forEach(p => {
      if (p.creditorCode) return;
      const c = cred[up(p.docNo)];
      if (c) { p.creditorCode = c[0]; p.creditorName = c[1]; p.credSource = 'grn'; return; }
      const it = byItem[up(p.itemCode)];
      if (it && !docGuess[up(p.docNo)]) docGuess[up(p.docNo)] = it;
    });
    rawPOList.forEach(p => {   // one creditor per PO
      if (p.credSource) return;
      const it = docGuess[up(p.docNo)];
      if (it) { p.creditorCode = it[0]; p.creditorName = it[1]; p.credSource = 'item'; }
      else { p.creditorCode = ''; p.creditorName = '(No GRN yet — set creditor)'; p.credSource = 'none'; }
    });
  }
  rawPOList.forEach(applyCredRules);
  const ov = store.poCreditors || {};
  rawPOList.forEach(p => {
    const o = ov[up(p.docNo)];
    if (o && o.name) { p.creditorCode = o.code || ''; p.creditorName = o.name; p.credSource = 'manual'; }
  });
  rawGRNList.forEach(applyCredRules);
  dataVersion++;
}

function clearAllData() {
  if (!store.po.length && !store.grn.length) return;
  if (!confirm('Remove the saved PO and GRN data from this browser?\n(The location list is kept.)')) return;
  logAction('Cleared PO & GRN data', null, 'clear');
  store.po = []; store.grn = [];
  ['poFile', 'poLoadedAt', 'grnFile', 'grnLoadedAt'].forEach(k => delete store.meta[k]);
  afterDataChange();
}

function afterDataChange() {
  if (!db.current && (store.po.length || store.grn.length || Object.keys(store.locMaster).length)) {
    db.current = store.meta.company || 'My Company';
    db.companies[db.current] = store;
  }
  rebuildCombined();
  saveStore();
  setDefaultDateRange();
  recalculateTransfers();
  refreshLocationUI();
  updateUploadSummary();
  if (currentActiveTab !== 'tab-upload') renderActiveTab();
  else updateKPIs(getScopedPOLines());
}

// Upload page summary
function updateUploadSummary() {
  const sPO = document.getElementById('statusPO');
  const sGRN = document.getElementById('statusGRN');
  const sLoc = document.getElementById('statusLoc');
  const nLoc = Object.keys(store.locMaster || {}).length;
  if (sPO) sPO.innerText = store.meta.poFile ? `Last PO file: ${store.meta.poFile} · ${store.meta.poLoadedAt || ''}` : '';
  if (sGRN) sGRN.innerText = store.meta.grnFile ? `Last GRN file: ${store.meta.grnFile} · ${store.meta.grnLoadedAt || ''}` : '';
  if (sLoc) sLoc.innerText = store.meta.locFile ? `Stock Location Listing: ${store.meta.locFile}` : '';
  const sCred = document.getElementById('statusCred');
  const nCred = Object.keys(store.credMaster || {}).length;
  if (sCred) sCred.innerText = store.meta.credFile ? `Creditor Listing: ${store.meta.credFile}` : '';

  const box = document.getElementById('uploadSummaryText');
  if (!box) return;
  if (!store.po.length && !store.grn.length) {
    box.innerHTML = '<p>No data yet. Upload the PO and GRN files above. They are saved in this browser, so next time you only upload when you have newer data.</p>';
    return;
  }
  const poDates = rawPOList.map(p => p.iso).sort();
  const grnDates = rawGRNList.map(g => g.grnIso).sort();
  const poHasLoc = store.po.some(p => p.loc);
  const grnHasLoc = store.grn.some(g => g.loc);
  const guessed = rawPOList.filter(p => p.locGuess).length;
  const poNoLoc = rawPOList.filter(p => !p.loc).length;
  const grnNoLoc = rawGRNList.filter(g => !g.loc).length;
  const oldGRN = rawGRNList.filter(g => g.poNo && !g.matched);
  const direct = rawGRNList.filter(g => !g.poNo).length;
  const unknownLocs = allLocCodes().filter(c => c !== NO_LOC && nLoc && !isKnownLoc(c));
  const notes = [];

  if (store.po.length && !poHasLoc) notes.push(`<span class="note-warn">The PO file has <b>no Location column</b>. ${guessed} PO lines took their location from their GRN; ${poNoLoc} lines (mostly not yet received) show as "(No location)". Add the Location column to the PO report too for exact results.</span>`);
  else if (poNoLoc) notes.push(`<span class="note-warn">${poNoLoc} PO line(s) have no location.</span>`);
  const poNoCred = store.po.length && store.po.every(p => !p.creditorCode);
  if (poNoCred) {
    const docs = src => new Set(rawPOList.filter(p => p.credSource === src).map(p => p.docNo)).size;
    const none = docs('none');
    notes.push(`<span class="${none ? 'note-warn' : 'muted'}">The PO file has no Creditor column, so creditors are filled in automatically: ${docs('grn')} POs from their GRN, ${docs('item')} POs from the last supplier of the same item${docs('manual') ? `, ${docs('manual')} set by hand` : ''}.${none ? ` <b>${none} PO(s)</b> have no GRN and no item history — click the PO number and use "✎ Change creditor".` : ''}</span>`);
  }
  if (store.grn.length && !grnHasLoc) notes.push('<span class="note-warn">The GRN file has <b>no Location column</b>.</span>');
  else if (grnNoLoc) notes.push(`<span class="muted">${grnNoLoc} GRN line(s) have no location.</span>`);
  if (!nLoc) notes.push('<span class="note-warn">Upload the <b>Stock Location Listing</b> (drop it in the box above) to show location names instead of codes.</span>');
  if (unknownLocs.length) notes.push(`<span class="note-warn">No name yet for location code(s): ${esc(unknownLocs.join(', '))}. Upload the Stock Location Listing (box 3) to show their names.</span>`);
  if (store.po.length && oldGRN.length) notes.push(`<span class="muted">${oldGRN.length} GRN line(s) are for POs not in the PO file (older POs or a shorter PO date range). They show in GRN Listing but don't affect PO outstanding.</span>`);
  if (direct) notes.push(`<span class="muted">${direct} GRN line(s) are direct GRNs (not from a PO).</span>`);

  box.innerHTML = `
    ${notes.length ? '<ul class="note-list">' + notes.map(n => `<li>${n}</li>`).join('') + '</ul>' : ''}
    <div style="margin-top:12px;"><button class="btn btn-danger btn-sm" onclick="clearAllData()">🗑 Clear PO &amp; GRN data</button></div>`;
}

// ----------------------------------------------------
// Core calculation: match each GRN line to a PO line
// ----------------------------------------------------
// Only GRNs inside the GRN date range count, so the GRN "to" date works as an
// "outstanding as at" cut-off date.
function recalculateTransfers() {
  const gr = { start: '1970-01-01', end: asAtDate() };   // From does not limit what counts as received
  const index = {};
  rawPOList.forEach(p => {
    p.transferredQty = 0;
    const k = lineKey(p.docNo, p.itemCode);
    (index[k] = index[k] || []).push(p);
  });

  rawGRNList.forEach(g => { g.matched = !!(g.poNo && index[lineKey(g.poNo, g.itemCode)]); });

  const grns = rawGRNList
    .filter(g => g.poNo && g.grnIso >= gr.start && g.grnIso <= gr.end)
    .slice().sort((a, b) => a.grnIso.localeCompare(b.grnIso));

  grns.forEach(g => {
    const lines = index[lineKey(g.poNo, g.itemCode)];
    if (!lines) return;
    let qtyLeft = g.qty;
    const desc = up(g.description);
    // Same item can appear on several lines of one PO: fill the line with the
    // same location + description first, then any other line with balance.
    const score = p => grnLineScore(p, g, desc);
    const ordered = lines.slice().sort((a, b) => score(b) - score(a) || a.id - b.id);
    for (const p of ordered) {
      if (qtyLeft <= EPS) break;
      const room = p.qty - p.transferredQty;
      if (room <= EPS) continue;
      const take = Math.min(room, qtyLeft);
      p.transferredQty += take;
      qtyLeft -= take;
    }
    if (qtyLeft > EPS) ordered[0].transferredQty += qtyLeft; // over-received
  });

  rawPOList.forEach(p => {
    const recv = Math.min(p.transferredQty, p.qty);
    p.balQty = Math.max(0, p.qty - p.transferredQty);
    if (p.balQty < EPS) p.balQty = 0;
    p.balCost = p.balQty * p.unitCost;
    p.transVal = recv * p.unitCost;
    p.cancelled = null; p.cancelQty = 0;
    const c = cancelOf(p);
    if (c && c.date <= gr.end) {
      p.cancelled = c; p.cancelQty = c.qty ? Math.min(c.qty, p.balQty) : p.balQty;
      p.balQty = Math.max(0, p.balQty - p.cancelQty); if (p.balQty < EPS) p.balQty = 0;
      p.balCost = p.balQty * p.unitCost;
    }
  });
}

// Status of a whole PO document (always uses ALL its lines)
function buildStatusMap() {
  const m = {};
  rawPOList.forEach(p => {
    if (!locAllowed(p.loc)) return;   // status only looks at the selected locations
    const k = viewDocKey(p);
    const s = m[k] || (m[k] = { any: false, all: true });
    if (p.transferredQty > EPS) s.any = true;
    if (p.balQty > EPS) s.all = false;
  });
  const out = {};
  Object.keys(m).forEach(k => out[k] = m[k].all ? 'full' : (m[k].any ? 'partial' : 'none'));
  return out;
}
function statusBadge(status) {
  if (status === 'full') return '<span class="status-badge done">Fully Transferred</span>';
  if (status === 'partial') return '<span class="status-badge partial">Partial Transfer</span>';
  return '<span class="status-badge untrans">Untransferred</span>';
}
function statusText(status) {
  return status === 'full' ? 'Fully Transferred' : status === 'partial' ? 'Partial Transfer' : 'Untransferred';
}

// Group PO lines into documents (per location)
function groupDocs(lines) {
  const docs = {};
  lines.forEach(p => {
    const k = viewDocKey(p);
    const d = docs[k] || (docs[k] = {
      key: k, loc: p.loc, locSet: new Set(), docNo: p.docNo, docDate: p.docDate, iso: p.iso, yymm: p.yymm,
      creditorCode: p.creditorCode, creditorName: p.creditorName,
      totalPOVal: 0, totalTransVal: 0, totalBalCost: 0, items: []
    });
    d.totalPOVal += p.lineSubTotal;
    d.totalTransVal += p.transVal;
    d.totalBalCost += p.balCost;
    d.items.push(p);
    d.locSet.add(p.loc);
  });
  Object.values(docs).forEach(d => { if (d.locSet.size > 1) d.loc = [...d.locSet].sort(); });
  return Object.values(docs).sort((a, b) => a.iso.localeCompare(b.iso) || a.docNo.localeCompare(b.docNo));
}

// ----------------------------------------------------
// KPI cards (always describe what the current report shows)
// ----------------------------------------------------
function updateKPIs(lines) {
  let po = 0, recv = 0, bal = 0, cnt = 0;
  lines.forEach(p => { po += p.lineSubTotal; recv += p.transVal; bal += p.balCost; if (p.balQty > EPS) cnt++; });
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.innerText = v; };
  set('kpiTotalPO', rm(po));
  set('kpiTotalGRN', rm(recv));
  set('kpiTotalBal', rm(bal));
  set('kpiUntransCount', `${cnt.toLocaleString()} Lines`);
}

// ----------------------------------------------------
// Click handling (expand/collapse + PO drill-down)
// ----------------------------------------------------
document.addEventListener('click', e => {
  const po = e.target.closest('[data-po]');
  if (po) { e.stopPropagation(); if (po.closest('summary')) e.preventDefault(); openPODrillDown(po.getAttribute('data-po')); return; }
  const tg = e.target.closest('[data-toggle]');
  if (tg) {
    const row = document.getElementById(tg.getAttribute('data-toggle'));
    if (!row) return;
    const open = !row.classList.contains('active');
    row.classList.toggle('active', open);
    const arrow = tg.classList.contains('arrow-toggle') ? tg : tg.querySelector('.arrow-toggle');
    if (arrow) arrow.classList.toggle('open', open);
  }
});

function arrow(id) { return `<span class="arrow-toggle" data-toggle="${id}">▶</span>`; }
function poLink(no, loc) {
  return no ? `<span class="doc-link" data-po="${esc(no)}" data-loc="${esc(loc)}">${esc(no)}</span>` : '<i class="muted">No PO</i>';
}
function emptyRow(tbody, tfoot, cols, msg) {
  tbody.innerHTML = `<tr><td colspan="${cols}" class="empty-state">${msg}</td></tr>`;
  if (tfoot) tfoot.innerHTML = '';
}
function noDataMsg() {
  return !locSel
    ? 'No data loaded. Go to "Upload CSV Files" and upload the PO and GRN files.'
    : `No PO data for the selected location(s): ${esc([...locSel].join(', '))}.`;
}
function hasScopedData() { return rawPOList.some(p => locAllowed(p.loc)); }

let podAllLoc = false;
function openPODrillDown(poNo) {
  const modal = document.getElementById('docDetailModal');
  const title = document.getElementById('docModalTitle');
  const tbody = document.getElementById('docModalTbody');
  const thead = document.getElementById('modalTableHead');
  if (!modal) return;
  const clean = up(poNo);
  const allLines = rawPOList.filter(p => up(p.docNo) === clean);
  const allGrns = rawGRNList.filter(g => up(g.poNo) === clean).sort((a, b) => a.grnIso.localeCompare(b.grnIso));
  // With a location chosen in the top bar, show only that location (button to show all)
  const onlyLoc = !!locSel && !podAllLoc;
  let lines = onlyLoc ? allLines.filter(p => locAllowed(p.loc)) : allLines;
  if (onlyLoc && !lines.length) lines = allLines.filter(p => p.xfer && Object.keys(p.xfer).some(locAllowed));   // PO from another location received here
  const grns = onlyLoc ? allGrns.filter(g => locAllowed(g.loc)) : allGrns;
  const hidden = (allLines.length - lines.length) + (allGrns.length - grns.length);
  const multi = hasMultiLoc();
  const locCell = (loc, guess, poLoc) => multi ? `<td><span class="loc-tag" title="${esc(locDesc(loc))}">${esc(loc || 'NO LOC')}</span>${guess ? '<span class="muted" title="Location taken from the GRN"> *</span>' : ''}${poLoc ? `<div class="muted small-text" title="Location on the PO">PO: ${esc(poLoc || '-')}</div>` : ''}</td>` : '';

  const first = lines[0] || allLines[0];
  title.innerText = `PO ${clean}` + (first ? ` · ${first.creditorName} · ${first.docDate}` : '');
  thead.innerHTML = '';
  const cols = multi ? 10 : 9;

  let html = '';
  if (locSel && (hidden || podAllLoc)) html += `<tr class="modal-section"><td colspan="${cols}" class="muted">${onlyLoc ? `Showing only <b>${esc([...locSel].sort().join(', '))}</b> · ${hidden} line(s) at other locations hidden` : 'Showing <b>all locations</b>'}
    <button class="btn btn-small" style="margin-left:8px;" onclick="podAllLoc=${onlyLoc ? 'true' : 'false'};openPODrillDown('${esc(clean)}')">${onlyLoc ? 'Show all locations' : 'Only my location'}</button></td></tr>`;
  if (lines.length) {
    const anyRecv = lines.some(p => p.transferredQty > EPS), allDone = lines.every(p => p.balQty <= EPS);
    const status = allDone ? 'full' : (anyRecv ? 'partial' : 'none');
    html += creditorRowHtml(lines[0], cols);
    html += `<tr class="modal-section"><td colspan="${cols}"><b>PO LINES</b> — ${statusBadge(status)}</td></tr>
      <tr class="modal-head"><td></td>${multi ? '<td>Location</td>' : ''}<td>Item Code</td><td colspan="2">Description</td><td class="text-right">Unit Cost</td>
      <td class="text-right">PO Qty</td><td class="text-right">Received</td><td class="text-right">Bal Qty</td><td class="text-right">Bal Cost (RM)</td></tr>`;
    lines.forEach(p => {
      const canTick = p.balQty > EPS || p.cancelled || cancelOf(p);
      const cx = cancelOf(p);
      html += `<tr class="${cx ? 'line-cancelled' : ''}"><td>${canTick ? `<input type="checkbox" class="cx" value="${esc(p.ckey)}">` : ''}</td>${locCell(p.loc, p.locGuess, '')}<td><b>${esc(p.itemCode)}</b>${cx ? `<div class="status-badge untrans" title="${esc((cx.reason || '') + ' — by ' + (cx.byName || cx.by || ''))}">Cancelled ${dateDMY(cx.date)}</div>` : ''}</td><td colspan="2"><span class="wrap">${esc(p.description)}</span>${cx && cx.reason ? `<div class="muted">Reason: ${esc(cx.reason)} (${esc(cx.byName || cx.by || '')})</div>` : ''}</td>
        <td class="text-right">${fmt(p.unitCost)}</td><td class="text-right">${qtyFmt(p.qty)}</td>
        <td class="text-right" style="color:var(--accent-green);">${qtyFmt(p.transferredQty)}</td>
        <td class="text-right" style="color:${p.balQty > 0 ? 'var(--accent-orange)' : '#64748b'};font-weight:700;">${qtyFmt(p.balQty)}</td>
        <td class="text-right" style="font-weight:800;">${fmt(p.balCost)}</td></tr>`;
    });
    if (lines.some(p => p.balQty > EPS || cancelOf(p))) html += cancelUiHtml(lines[0].docNo, cols);
  } else if (allLines.length) {
    html += `<tr><td colspan="${cols}" class="empty-state">No PO line for this location.</td></tr>`;
  } else {
    html += `<tr><td colspan="${cols}" class="empty-state">This PO is not in the uploaded PO file (it may be from an earlier period).</td></tr>`;
  }

  html += `<tr class="modal-section"><td colspan="${cols}"><b>GRN RECEIVED</b> (${grns.length} line${grns.length === 1 ? '' : 's'})</td></tr>`;
  if (!grns.length) {
    html += `<tr><td colspan="${cols}" class="empty-state">No GRN received for this PO yet.</td></tr>`;
  } else {
    html += `<tr class="modal-head"><td></td>${multi ? '<td>Location</td>' : ''}<td>GRN Date</td><td>GRN No.</td><td>Item Code</td><td>Description</td>
      <td class="text-right">Unit Price</td><td class="text-right">Qty</td><td></td><td class="text-right">Sub Total (RM)</td></tr>`;
    grns.forEach(g => {
      html += `<tr><td></td>${locCell(g.loc)}<td>${esc(g.grnDate)}</td><td><b>${esc(g.grnNo)}</b></td><td>${esc(g.itemCode)}</td><td><span class="wrap">${esc(g.description)}</span></td>
        <td class="text-right">${fmt(g.unitPrice)}</td><td class="text-right" style="font-weight:700;">${qtyFmt(g.qty)}</td><td></td>
        <td class="text-right" style="color:var(--accent-green);font-weight:800;">${fmt(g.subTotal)}</td></tr>`;
    });
  }
  tbody.innerHTML = html;
  modal.classList.add('active');
}
function closeDocModal() {
  const m = document.getElementById('docDetailModal');
  if (m) m.classList.remove('active');
  podAllLoc = false;
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeDocModal();
});

// ----------------------------------------------------
// Month pickers ("ALL MONTHS" stays selected)
// ----------------------------------------------------
function populateMonthPicker(id) {
  const picker = document.getElementById(id);
  if (!picker) return 'ALL';
  if (picker.dataset.ver !== String(dataVersion)) {
    const months = [...new Set(rawPOList.map(p => p.yymm))].filter(m => m !== '0000').sort().reverse();
    const prev = picker.value;
    const firstTime = !picker.dataset.ver;
    picker.innerHTML = '<option value="ALL">-- ALL MONTHS --</option>' +
      months.map(m => `<option value="${m}">${yymmLabel(m)}</option>`).join('');
    if (prev && (prev === 'ALL' || months.includes(prev)) && !firstTime) picker.value = prev;
    else picker.value = months[0] || 'ALL';
    picker.dataset.ver = String(dataVersion);
  }
  return picker.value || 'ALL';
}

function withLoc(obj, loc) {
  if (!hasMultiLoc()) return obj;
  const list = Array.isArray(loc) ? loc : [loc];
  return Object.assign({ 'Location Code': list.map(l => l || '(blank)').join(', '), 'Location': list.map(locDesc).join(', ') }, obj);
}

// ----------------------------------------------------
// REPORT 0: All Locations Summary
// ----------------------------------------------------
function renderLocationSummary() {
  const tbody = document.getElementById('locSummaryTbody');
  const tfoot = document.getElementById('locSummaryTfoot');
  const poLines = getScopedPOLines();
  const grns = getScopedGRNLines();
  updateKPIs(poLines);
  if (!rawPOList.length && !rawGRNList.length) return emptyRow(tbody, tfoot, 9, 'No data loaded yet. Go to "Upload CSV Files" and upload the PO and GRN files.');

  const blank = () => ({ po: 0, recv: 0, bal: 0, docs: new Set(), outDocs: new Set(), outLines: 0, grn: 0, grnDocs: new Set(), months: {} });
  const agg = {};
  const get = c => agg[c] || (agg[c] = blank());
  const addPO = (a, p) => {
    a.po += p.lineSubTotal; a.recv += p.transVal; a.bal += p.balCost; a.docs.add(p.docNo);
    if (p.balQty > EPS) { a.outLines++; a.outDocs.add(p.docNo); }
  };
  const addGRN = (a, g) => { a.grn += g.subTotal; a.grnDocs.add(g.grnNo); };

  poLines.forEach(p => { const a = get(p.loc); addPO(a, p); addPO(a.months[p.yymm] = a.months[p.yymm] || blank(), p); });
  grns.forEach(g => { const a = get(g.loc); addGRN(a, g); addGRN(a.months[g.grnYYMM] = a.months[g.grnYYMM] || blank(), g); });

  const codes = Object.keys(agg).sort((a, b) => (a === NO_LOC) - (b === NO_LOC) || a.localeCompare(b));
  if (!codes.length) return emptyRow(tbody, tfoot, 9, 'No data matches your filters.');

  const cells = (a) => {
    const pct = a.po > 0 ? a.recv / a.po * 100 : null;
    return `
      <td class="text-right"><b>${a.docs.size}</b></td>
      <td class="text-right">${rm(a.po)}</td>
      <td class="text-right" style="color:var(--accent-green);">${rm(a.recv)}</td>
      <td class="text-right" style="color:${a.bal > 0.005 ? 'var(--accent-orange)' : '#15803d'};font-weight:800;">${rm(a.bal)}</td>
      <td class="text-right">${a.outDocs.size} POs · ${a.outLines} lines</td>
      <td class="text-right">${rm(a.grn)} <span class="muted">(${a.grnDocs.size})</span></td>
      <td class="text-right">${pct == null ? '-' : pctBar(pct)}</td>`;
  };

  const summary = [], detail = [];
  const G = blank();
  let html = '';
  codes.forEach((c, i) => {
    const a = agg[c];
    const subId = `locSub_${i}`;
    G.po += a.po; G.recv += a.recv; G.bal += a.bal; G.outLines += a.outLines; G.grn += a.grn;
    a.docs.forEach(d => G.docs.add(d)); a.outDocs.forEach(d => G.outDocs.add(d)); a.grnDocs.forEach(d => G.grnDocs.add(d));

    summary.push({ 'Location Code': c || '(blank)', 'Location': locDesc(c), 'PO Count': a.docs.size, 'PO Value': a.po,
      'Received Against PO': a.recv, 'Outstanding Bal': a.bal, 'Outstanding POs': a.outDocs.size, 'Outstanding Lines': a.outLines,
      'GRN Value': a.grn, 'GRN Count': a.grnDocs.size, 'Fulfilment %': a.po > 0 ? Math.round(a.recv / a.po * 1000) / 10 : '' });

    html += `<tr class="loc-sum-row">
      <td class="text-center">${arrow(subId)}</td>
      <td><b class="loc-click" data-goto-loc="${esc(c)}" title="Open the outstanding POs for this location">${esc(c || '(No location)')}</b>
        <div class="loc-desc">${esc(c ? locDesc(c) : 'Lines without a location code')}</div></td>
      ${cells(a)}
    </tr>`;

    const months = Object.keys(a.months).sort().reverse();
    const mRows = months.map(m => {
      const ma = a.months[m];
      detail.push({ 'Location Code': c || '(blank)', 'Location': locDesc(c), Month: yymmLabel(m), 'PO Count': ma.docs.size, 'PO Value': ma.po,
        'Received Against PO': ma.recv, 'Outstanding Bal': ma.bal, 'Outstanding Lines': ma.outLines, 'GRN Value': ma.grn });
      return `<tr><td style="width:35px;"></td><td style="padding-left:22px;">↳ ${yymmLabel(m)}</td>${cells(ma)}</tr>`;
    }).join('');
    html += `<tr id="${subId}" class="detail-subrow"><td colspan="9" class="detail-subrow-cell">
      <table class="sub-item-table loc-month-table"><tbody>${mRows}</tbody></table></td></tr>`;
  });

  tbody.innerHTML = html;
  const gPct = G.po > 0 ? G.recv / G.po * 100 : null;
  tfoot.innerHTML = `<tr>
    <td colspan="2">${locSel ? 'TOTAL SELECTED' : 'TOTAL ALL'} LOCATIONS (${codes.length})</td>
    <td class="text-right">${G.docs.size}</td>
    <td class="text-right">${rm(G.po)}</td>
    <td class="text-right" style="color:#4ade80;">${rm(G.recv)}</td>
    <td class="text-right" style="color:#fb923c;">${rm(G.bal)}</td>
    <td class="text-right">${G.outDocs.size} POs · ${G.outLines} lines</td>
    <td class="text-right">${rm(G.grn)}</td>
    <td class="text-right">${gPct == null ? '-' : gPct.toFixed(1) + '%'}</td>
  </tr>`;
  exportStore.locSummaryTable = { summary, detail };
}

// Click a location in the summary -> open its outstanding report
document.addEventListener('click', e => {
  const t = e.target.closest('[data-goto-loc]');
  if (!t) return;
  setLocSel(new Set([t.getAttribute('data-goto-loc')]), true);
  switchNavTab('tab-po-outstanding');
});

// ----------------------------------------------------
// REPORT 1: 6-Month PO Audit
// ----------------------------------------------------
function renderSixMonthAudit() {
  const tbody = document.getElementById('sixMonthTbody');
  const tfoot = document.getElementById('sixMonthTfoot');
  if (!hasScopedData()) { updateKPIs([]); return emptyRow(tbody, tfoot, 7, noDataMsg()); }

  const scoped = getScopedPOLines();
  const statusMap = buildStatusMap();
  const months = [...new Set(scoped.map(p => p.yymm))].sort().reverse().slice(0, 6);
  const shown = scoped.filter(p => months.includes(p.yymm));
  updateKPIs(shown);

  if (!months.length) return emptyRow(tbody, tfoot, 7, 'No POs match your filters.');

  const G = { docs: 0, val: 0, nDocs: 0, nVal: 0, pDocs: 0, pVal: 0, fDocs: 0, fVal: 0, bal: 0 };
  const summary = [], detail = [];
  let html = '';

  months.forEach((yymm, mIdx) => {
    const docs = groupDocs(shown.filter(p => p.yymm === yymm));
    const none = docs.filter(d => statusMap[d.key] === 'none');
    const part = docs.filter(d => statusMap[d.key] === 'partial');
    const full = docs.filter(d => statusMap[d.key] === 'full');
    const sum = (arr, f) => arr.reduce((s, d) => s + d[f], 0);
    const val = sum(docs, 'totalPOVal'), nVal = sum(none, 'totalBalCost'),
      pVal = sum(part, 'totalBalCost'), fVal = sum(full, 'totalPOVal'), bal = sum(docs, 'totalBalCost');

    G.docs += docs.length; G.val += val; G.nDocs += none.length; G.nVal += nVal;
    G.pDocs += part.length; G.pVal += pVal; G.fDocs += full.length; G.fVal += fVal; G.bal += bal;

    summary.push({ Month: yymmLabel(yymm), 'PO Count': docs.length, 'PO Value': val,
      'Untransferred POs': none.length, 'Untransferred Bal': nVal, 'Partial POs': part.length, 'Partial Bal': pVal,
      'Fully Transferred POs': full.length, 'Fully Transferred Value': fVal, 'Outstanding Bal Cost': bal });

    const subId = `sixSub_${mIdx}`;
    html += `<tr class="yymm-header-row">
      <td class="text-center">${arrow(subId)}</td>
      <td><b>${yymmLabel(yymm)}</b></td>
      <td class="text-right"><b>${docs.length} POs</b><br><span class="muted">${rm(val)}</span></td>
      <td class="text-right" style="color:var(--accent-orange);"><b>${none.length} POs</b><br><span class="sub-amt">${rm(nVal)}</span></td>
      <td class="text-right" style="color:#d97706;"><b>${part.length} POs</b><br><span class="sub-amt">${rm(pVal)}</span></td>
      <td class="text-right" style="color:var(--accent-green);"><b>${full.length} POs</b><br><span class="sub-amt">${rm(fVal)}</span></td>
      <td class="text-right" style="color:${bal > 0 ? 'var(--accent-orange)' : '#15803d'};font-weight:800;">${rm(bal)}</td>
    </tr>`;

    const rows = docs.map(d => {
      detail.push(withLoc({ Month: yymm, 'PO No': d.docNo, 'PO Date': d.docDate, 'Creditor Code': d.creditorCode,
        'Creditor Name': d.creditorName, Status: statusText(statusMap[d.key]),
        'PO Value': d.totalPOVal, Transferred: d.totalTransVal, 'Outstanding Bal': d.totalBalCost }, d.loc));
      return `<tr>
        <td>${poLink(d.docNo, d.loc)}${locTag(d.loc)}</td><td>${esc(d.docDate)}</td><td><span class="wrap">${esc(d.creditorName)}</span></td>
        <td>${statusBadge(statusMap[d.key])}</td>
        <td class="text-right">${rm(d.totalPOVal)}</td>
        <td class="text-right" style="color:var(--accent-green);">${rm(d.totalTransVal)}</td>
        <td class="text-right" style="color:${d.totalBalCost > 0 ? 'var(--accent-orange)' : '#64748b'};font-weight:800;">${rm(d.totalBalCost)}</td>
      </tr>`;
    }).join('');

    html += `<tr id="${subId}" class="detail-subrow"><td colspan="7" class="detail-subrow-cell">
      <table class="sub-item-table"><thead><tr>
        <th>PO Doc No.</th><th>PO Date</th><th>Creditor Name</th><th>Status</th>
        <th class="text-right">PO Value (RM)</th><th class="text-right">Transferred (RM)</th><th class="text-right">Outstanding Bal (RM)</th>
      </tr></thead><tbody>${rows}</tbody></table></td></tr>`;
  });

  tbody.innerHTML = html;
  tfoot.innerHTML = `<tr>
    <td colspan="2">GRAND TOTAL (${months.length} MONTHS)</td>
    <td class="text-right">${G.docs} POs<br><span class="sub-amt">${rm(G.val)}</span></td>
    <td class="text-right" style="color:#fb923c;">${G.nDocs} POs<br><span class="sub-amt">${rm(G.nVal)}</span></td>
    <td class="text-right" style="color:#fcd34d;">${G.pDocs} POs<br><span class="sub-amt">${rm(G.pVal)}</span></td>
    <td class="text-right" style="color:#4ade80;">${G.fDocs} POs<br><span class="sub-amt">${rm(G.fVal)}</span></td>
    <td class="text-right" style="color:#fb923c;">${rm(G.bal)}</td>
  </tr>`;
  exportStore.sixMonthTable = { summary, detail };
}

// ----------------------------------------------------
// REPORT 2: Month Select Audit
// ----------------------------------------------------
function renderMonthSelectAudit() {
  const tbody = document.getElementById('monthSelectTbody');
  const tfoot = document.getElementById('monthSelectTfoot');
  const month = populateMonthPicker('poMonthPicker');
  if (!hasScopedData()) { updateKPIs([]); return emptyRow(tbody, tfoot, 8, noDataMsg()); }

  const lines = getScopedPOLines(month);
  updateKPIs(lines);
  if (!lines.length) return emptyRow(tbody, tfoot, 8, 'No POs found for this month and filters.');

  const statusMap = buildStatusMap();
  const docs = groupDocs(lines);
  const summary = [], detail = [];
  let gPO = 0, gTrans = 0, gBal = 0, html = '';

  docs.forEach((d, i) => {
    gPO += d.totalPOVal; gTrans += d.totalTransVal; gBal += d.totalBalCost;
    const subId = `msSub_${i}`;
    summary.push(withLoc({ 'PO No': d.docNo, 'PO Date': d.docDate, 'Creditor Code': d.creditorCode, 'Creditor Name': d.creditorName,
      Status: statusText(statusMap[d.key]), 'PO Value': d.totalPOVal, Transferred: d.totalTransVal, 'Outstanding Bal': d.totalBalCost }, d.loc));

    html += `<tr>
      <td class="text-center">${arrow(subId)}</td>
      <td>${poLink(d.docNo, d.loc)}${locTag(d.loc)}</td><td>${esc(d.docDate)}</td><td><span class="wrap">${esc(d.creditorName)}</span></td>
      <td>${statusBadge(statusMap[d.key])}</td>
      <td class="text-right">${rm(d.totalPOVal)}</td>
      <td class="text-right" style="color:var(--accent-green);">${rm(d.totalTransVal)}</td>
      <td class="text-right" style="color:${d.totalBalCost > 0 ? 'var(--accent-orange)' : '#64748b'};font-weight:800;">${rm(d.totalBalCost)}</td>
    </tr>`;
    html += itemSubRow(subId, 8, d.items, detail);
  });

  tbody.innerHTML = html;
  tfoot.innerHTML = `<tr>
    <td colspan="5">GRAND TOTAL — ${month === 'ALL' ? 'ALL MONTHS' : yymmLabel(month)} (${docs.length} POs)</td>
    <td class="text-right">${rm(gPO)}</td>
    <td class="text-right" style="color:#4ade80;">${rm(gTrans)}</td>
    <td class="text-right" style="color:${gBal > 0 ? '#fb923c' : '#ffffff'};">${rm(gBal)}</td>
  </tr>`;
  exportStore.monthSelectTable = { summary, detail };
}

// Shared: item-level sub table for a PO
function itemSubRow(subId, colspan, items, detailOut) {
  const rows = items.map(p => {
    if (detailOut) detailOut.push(lineExport(p));
    return `<tr>
      <td style="padding-left:20px;color:#64748b;">↳ <b>${esc(p.itemCode)}</b></td>
      <td><span class="wrap">${esc(p.description)}</span></td>
      <td class="text-right">${fmt(p.unitCost)}</td>
      <td class="text-right">${qtyFmt(p.qty)}</td>
      <td class="text-right" style="color:var(--accent-green);font-weight:700;">${qtyFmt(Math.min(p.transferredQty, p.qty))}</td>
      <td class="text-right" style="color:${p.balQty > 0 ? 'var(--accent-orange)' : '#64748b'};font-weight:800;">${qtyFmt(p.balQty)}</td>
      <td class="text-right" style="color:${p.balCost > 0 ? 'var(--accent-orange)' : '#64748b'};font-weight:800;">${rm(p.balCost)}</td>
    </tr>`;
  }).join('');
  return `<tr id="${subId}" class="detail-subrow"><td colspan="${colspan}" class="detail-subrow-cell">
    <table class="sub-item-table"><thead><tr>
      <th>Item Code</th><th>Description</th><th class="text-right">Unit Cost (RM)</th><th class="text-right">PO Qty</th>
      <th class="text-right">Received</th><th class="text-right">Bal Qty</th><th class="text-right">Bal Cost</th>
    </tr></thead><tbody>${rows}</tbody></table></td></tr>`;
}

function lineExport(p) {
  return withLoc({ 'PO No': p.docNo, 'PO Date': p.docDate, 'Creditor Code': p.creditorCode, 'Creditor Name': p.creditorName,
    'Item Code': p.itemCode, Description: p.description, 'PO Qty': p.qty, 'Unit Price': p.unitPrice, Disc: p.disc,
    'Line Sub Total': p.lineSubTotal, 'Received Qty': Math.min(p.transferredQty, p.qty), 'Bal Qty': p.balQty,
    'Bal Cost': Math.round(p.balCost * 100) / 100 }, p.loc);
}

// ----------------------------------------------------
// REPORT 3: Untransferred / Partial PO Audit
// ----------------------------------------------------
// month buttons (tick several months) for the Untransferred PO Audit
let untransMonths = new Set();
function renderUntransMonthChips(outLines) {
  const box = document.getElementById('untransMonths');
  if (!box) return;
  const cnt = {};
  outLines.forEach(p => { (cnt[p.yymm] = cnt[p.yymm] || new Set()).add(p.docNo); });
  const months = Object.keys(cnt).sort();
  [...untransMonths].forEach(m => { if (!cnt[m]) untransMonths.delete(m); });
  box.innerHTML = '<b>PO month:</b> ' +
    `<button class="mchip ${untransMonths.size ? '' : 'on'}" onclick="toggleUntransMonth('ALL')">All</button>` +
    months.map(m => `<button class="mchip ${untransMonths.has(m) ? 'on' : ''}" onclick="toggleUntransMonth('${m}')">${monApos(m)} <span>${cnt[m].size}</span></button>`).join('') +
    '<span class="muted small-text"> · click to tick several months</span>';
}
function toggleUntransMonth(m) {
  if (m === 'ALL') untransMonths.clear();
  else if (untransMonths.has(m)) untransMonths.delete(m); else untransMonths.add(m);
  renderActiveTab();
}

function renderUntransferredPOs() {
  const tbody = document.getElementById('untransPoTbody');
  const tfoot = document.getElementById('untransPoTfoot');
  if (!hasScopedData()) { updateKPIs([]); return emptyRow(tbody, tfoot, 8, noDataMsg()); }

  const scoped = getScopedPOLines();
  const allOut = scoped.filter(p => p.balQty > EPS);
  renderUntransMonthChips(allOut);
  const outLines = untransMonths.size ? allOut.filter(p => untransMonths.has(p.yymm)) : allOut;
  updateKPIs(outLines);
  if (!outLines.length) return emptyRow(tbody, tfoot, 8, 'Nothing outstanding — every PO in your filter is fully transferred. 🎉');

  const statusMap = buildStatusMap();
  const months = [...new Set(outLines.map(p => p.yymm))].sort();
  const summary = [], detail = [];
  let gPO = 0, gGRN = 0, gBal = 0, html = '';

  months.forEach((yymm, mIdx) => {
    const docs = groupDocs(outLines.filter(p => p.yymm === yymm));
    const mPO = docs.reduce((s, d) => s + d.totalPOVal, 0);
    const mGRN = docs.reduce((s, d) => s + d.totalTransVal, 0);
    const mBal = docs.reduce((s, d) => s + d.totalBalCost, 0);
    gPO += mPO; gGRN += mGRN; gBal += mBal;

    html += `<tr class="yymm-header-row">
      <td class="text-center">📅</td>
      <td colspan="4"><b>${yymmLabel(yymm)} — ${docs.length} outstanding PO${docs.length === 1 ? '' : 's'}</b></td>
      <td class="text-right">${rm(mPO)}</td>
      <td class="text-right" style="color:var(--accent-green);">${rm(mGRN)}</td>
      <td class="text-right" style="color:var(--accent-orange);">${rm(mBal)}</td>
    </tr>`;

    docs.forEach((d, dIdx) => {
      const subId = `untSub_${mIdx}_${dIdx}`;
      summary.push(withLoc({ Month: yymm, 'PO No': d.docNo, 'PO Date': d.docDate, 'Creditor Code': d.creditorCode, 'Creditor Name': d.creditorName,
        Status: statusText(statusMap[d.key]), 'Outstanding Lines PO Value': d.totalPOVal, 'Received on these lines': d.totalTransVal, 'Outstanding Bal': d.totalBalCost }, d.loc));
      html += `<tr class="po-doc-row">
        <td class="text-center">${arrow(subId)}</td>
        <td>${poLink(d.docNo, d.loc)}${locTag(d.loc)}</td><td>${esc(d.docDate)}</td><td><span class="wrap">${esc(d.creditorName)}</span></td>
        <td>${statusBadge(statusMap[d.key])}</td>
        <td class="text-right">${rm(d.totalPOVal)}</td>
        <td class="text-right" style="color:var(--accent-green);">${rm(d.totalTransVal)}</td>
        <td class="text-right" style="color:var(--accent-orange);font-weight:800;">${rm(d.totalBalCost)}</td>
      </tr>`;
      html += itemSubRow(subId, 8, d.items, detail);
    });
  });

  tbody.innerHTML = html;
  tfoot.innerHTML = `<tr>
    <td colspan="5">TOTAL OUTSTANDING (${outLines.length} lines, ${new Set(outLines.map(p => up(p.docNo))).size} POs)</td>
    <td class="text-right">${rm(gPO)}</td>
    <td class="text-right" style="color:#4ade80;">${rm(gGRN)}</td>
    <td class="text-right" style="color:#fb923c;">${rm(gBal)}</td>
  </tr>`;
  exportStore.untransPoTable = { summary, detail };
}

// ----------------------------------------------------
// REPORT 4: GRN Received Listing
// ----------------------------------------------------
function renderGRNDetails() {
  const tbody = document.getElementById('grnDetailTbody');
  const tfoot = document.getElementById('grnDetailTfoot');
  updateKPIs(getScopedPOLines());
  if (!rawGRNList.some(g => locAllowed(g.loc))) return emptyRow(tbody, tfoot, 8, 'No GRN data loaded for this location. Upload the GRN Detail Listing in "Upload CSV Files".');

  const allMonths = [...new Set(rawGRNList.filter(g => locAllowed(g.loc)).map(g => g.grnYYMM).filter(m => m && m !== '0000'))].sort();
  monthPicks['grnPick:all'] = allMonths;
  const picked = new Set(renderMonthPicker('grnPick', allMonths, 'toggleMonthPick'));
  const list = getScopedGRNLines().filter(g => picked.has(g.grnYYMM));
  if (!list.length) return emptyRow(tbody, tfoot, 8, 'No GRN lines for the chosen month(s) and filters.');

  const months = {};
  list.forEach(g => {
    const m = months[g.grnYYMM] || (months[g.grnYYMM] = { qty: 0, amt: 0, sameAmt: 0, prevAmt: 0, same: {}, prev: {}, grnSet: new Set() });
    const monthStart = `20${g.grnYYMM.substring(0, 2)}-${g.grnYYMM.substring(2)}-01`;
    const isPrev = !!g.poIso && g.poIso < monthStart;
    const bucket = isPrev ? m.prev : m.same;
    const k = `${g.loc}|${g.grnNo}|${g.poNo}`;
    const d = bucket[k] || (bucket[k] = { loc: g.loc, grnNo: g.grnNo, grnDate: g.grnDate, grnIso: g.grnIso, poNo: g.poNo, poDate: g.poDate,
      creditorName: g.creditorName, matched: g.matched, qty: 0, amt: 0, items: [] });
    d.qty += g.qty; d.amt += g.subTotal; d.items.push(g);
    m.qty += g.qty; m.amt += g.subTotal; m.grnSet.add(g.grnNo);
    if (isPrev) m.prevAmt += g.subTotal; else m.sameAmt += g.subTotal;
  });

  const summary = [], detail = [];
  let gQty = 0, gAmt = 0, html = '', mIdx = 0;

  Object.keys(months).sort().forEach(yymm => {
    const m = months[yymm];
    gQty += m.qty; gAmt += m.amt; mIdx++;
    const monthSub = `grnM_${mIdx}`, sameSub = `grnS_${mIdx}`, prevSub = `grnP_${mIdx}`;
    summary.push({ 'GRN Month': yymmLabel(yymm), 'GRN Count': m.grnSet.size, 'Received Qty': m.qty, 'GRN Value': m.amt,
      'For Same-Month POs': m.sameAmt, 'For Earlier-Month POs': m.prevAmt });

    const docRows = (docs, tag) => Object.values(docs)
      .sort((a, b) => a.grnIso.localeCompare(b.grnIso) || a.grnNo.localeCompare(b.grnNo))
      .map((d, i) => {
        const docSub = `grnD_${mIdx}_${tag}_${i}`;
        const items = d.items.map(g => {
          detail.push(withLoc({ 'GRN No': g.grnNo, 'GRN Date': g.grnDate, 'PO No': g.poNo, 'PO Date': g.poDate,
            'Creditor Code': g.creditorCode, 'Creditor Name': g.creditorName, 'Item Code': g.itemCode,
            Description: g.description, 'Unit Price': g.unitPrice, Qty: g.qty, 'Sub Total': g.subTotal,
            'PO in PO file?': g.matched ? 'Yes' : 'No' }, g.loc));
          return `<tr><td style="padding-left:20px;color:#64748b;">↳ <b>${esc(g.itemCode)}</b></td>
            <td colspan="3"><span class="wrap">${esc(g.description)}</span></td>
            <td class="text-right">${fmt(g.unitPrice)}</td><td class="text-right">${qtyFmt(g.qty)}</td>
            <td class="text-right" style="color:var(--accent-green);font-weight:700;">${rm(g.subTotal)}</td></tr>`;
        }).join('');
        return `<tr>
          <td class="text-center" style="width:40px;">${arrow(docSub)}</td>
          <td><b>${esc(d.grnNo)}</b>${locTag(d.loc)}</td><td>${esc(d.grnDate)}</td>
          <td>${poLink(d.poNo, d.loc)} ${d.poDate ? `<span class="muted">(${esc(d.poDate)})</span>` : ''}${d.poNo && !d.matched ? ' <span class="status-badge partial" title="PO not in uploaded PO file">old PO</span>' : ''}</td>
          <td><span class="wrap">${esc(d.creditorName)}</span></td>
          <td class="text-right">${qtyFmt(d.qty)}</td>
          <td class="text-right" style="font-weight:800;">${rm(d.amt)}</td></tr>
          <tr id="${docSub}" class="detail-subrow"><td colspan="7" class="detail-subrow-cell">
            <table class="sub-item-table"><tbody>${items}</tbody></table></td></tr>`;
      }).join('') || '<tr><td colspan="7" class="empty-state" style="padding:12px;">None</td></tr>';

    const sameCount = Object.keys(m.same).length, prevCount = Object.keys(m.prev).length;
    html += `<tr class="yymm-header-row">
      <td class="text-center">${arrow(monthSub)}</td>
      <td colspan="4"><b>GRN MONTH: ${yymmLabel(yymm)}</b></td>
      <td class="text-right">${m.grnSet.size} GRNs</td>
      <td class="text-right">${qtyFmt(m.qty)}</td>
      <td class="text-right" style="color:var(--accent-green);font-weight:800;">${rm(m.amt)}</td>
    </tr>
    <tr id="${monthSub}" class="detail-subrow"><td colspan="8" class="detail-subrow-cell" style="padding:10px !important;">
      <table class="sub-item-table" style="margin-bottom:10px;">
        <thead><tr class="group-toggle same" data-toggle="${sameSub}">
          <th class="text-center" style="width:40px;"><span class="arrow-toggle">▶</span></th>
          <th colspan="5" style="text-align:left;">📂 GRN FOR POs ISSUED IN ${yymmLabel(yymm)} (${sameCount})</th>
          <th class="text-right">${rm(m.sameAmt)}</th></tr></thead>
        <tbody id="${sameSub}" class="detail-subrow">${docRows(m.same, 's')}</tbody>
      </table>
      <table class="sub-item-table">
        <thead><tr class="group-toggle prev" data-toggle="${prevSub}">
          <th class="text-center" style="width:40px;"><span class="arrow-toggle">▶</span></th>
          <th colspan="5" style="text-align:left;">📂 GRN FOR POs FROM EARLIER MONTHS (${prevCount})</th>
          <th class="text-right">${rm(m.prevAmt)}</th></tr></thead>
        <tbody id="${prevSub}" class="detail-subrow">${docRows(m.prev, 'p')}</tbody>
      </table>
    </td></tr>`;
  });

  tbody.innerHTML = html;
  tfoot.innerHTML = `<tr>
    <td colspan="6">TOTAL GRN RECEIVED (${list.length} lines, ${new Set(list.map(g => g.grnNo)).size} GRNs, ${Object.keys(months).length} months)</td>
    <td class="text-right">${qtyFmt(gQty)}</td>
    <td class="text-right" style="color:#4ade80;">${rm(gAmt)}</td>
  </tr>`;
  exportStore.grnDetailTable = { summary, detail };
}

// ----------------------------------------------------
// REPORT 5: Monthly Summary
// ----------------------------------------------------
function renderMonthlyOutstanding() {
  const tbody = document.getElementById('monthlySummaryTbody');
  const tfoot = document.getElementById('monthlySummaryTfoot');
  if (!rawPOList.some(p => locAllowed(p.loc)) && !rawGRNList.some(g => locAllowed(g.loc))) {
    updateKPIs([]); return emptyRow(tbody, tfoot, 7, noDataMsg());
  }

  const poLines = getScopedPOLines();
  updateKPIs(poLines);
  const grns = getScopedGRNLines();

  const mm = {};
  const get = y => mm[y] || (mm[y] = { po: 0, poDocs: new Set(), recvOnPO: 0, grn: 0, grnDocs: new Set(), same: 0, prev: 0 });
  poLines.forEach(p => { const m = get(p.yymm); m.po += p.lineSubTotal; m.poDocs.add(p.docNo); m.recvOnPO += p.transVal; });
  grns.forEach(g => {
    const m = get(g.grnYYMM);
    m.grn += g.subTotal; m.grnDocs.add(g.grnNo);
    const start = `20${g.grnYYMM.substring(0, 2)}-${g.grnYYMM.substring(2)}-01`;
    if (g.poIso && g.poIso < start) m.prev += g.subTotal; else m.same += g.subTotal;
  });

  const months = Object.keys(mm).sort();
  if (!months.length) return emptyRow(tbody, tfoot, 7, 'No data matches your filters.');

  const summary = [];
  let gPO = 0, gGRN = 0, gSame = 0, gPrev = 0, gRecv = 0, html = '';
  months.forEach(y => {
    const m = mm[y];
    gPO += m.po; gGRN += m.grn; gSame += m.same; gPrev += m.prev; gRecv += m.recvOnPO;
    const pct = m.po > 0 ? (m.recvOnPO / m.po * 100) : null;
    summary.push({ Month: yymmLabel(y), 'PO Count': m.poDocs.size, 'PO Issued': m.po, 'GRN Count': m.grnDocs.size,
      'GRN Received': m.grn, 'GRN for Same-Month POs': m.same, 'GRN for Earlier POs': m.prev,
      'PO Fulfilment %': pct == null ? '' : Math.round(pct * 10) / 10 });
    html += `<tr class="yymm-header-row">
      <td class="text-center">📊</td>
      <td><b>${yymmLabel(y)}</b></td>
      <td class="text-right"><b>${rm(m.po)}</b> <span class="muted">(${m.poDocs.size} POs)</span></td>
      <td class="text-right" style="color:var(--accent-green);font-weight:800;">${rm(m.grn)} <span class="muted">(${m.grnDocs.size} GRNs)</span></td>
      <td class="text-right" style="color:#0284c7;">${rm(m.same)}</td>
      <td class="text-right" style="color:var(--accent-orange);font-weight:800;">${rm(m.prev)}</td>
      <td class="text-right">${pct == null ? '-' : pctBar(pct)}</td>
    </tr>`;
  });

  tbody.innerHTML = html;
  const gPct = gPO > 0 ? gRecv / gPO * 100 : null;
  tfoot.innerHTML = `<tr>
    <td colspan="2">GRAND TOTAL (${months.length} months)</td>
    <td class="text-right">${rm(gPO)}</td>
    <td class="text-right" style="color:#4ade80;">${rm(gGRN)}</td>
    <td class="text-right" style="color:#38bdf8;">${rm(gSame)}</td>
    <td class="text-right" style="color:#fb923c;">${rm(gPrev)}</td>
    <td class="text-right">${gPct == null ? '-' : gPct.toFixed(1) + '%'}</td>
  </tr>`;
  exportStore.monthlySummaryTable = { summary, detail: null };
}

function pctBar(pct) {
  const c = pct >= 99.95 ? '#15803d' : pct >= 70 ? '#d97706' : '#dc2626';
  return `<span class="pct-wrap"><span class="pct-bar"><span style="width:${Math.max(0, Math.min(100, pct))}%;background:${c};"></span></span><b style="color:${c};">${pct.toFixed(1)}%</b></span>`;
}

// ----------------------------------------------------
// REPORT 6: Creditor Balances
// ----------------------------------------------------
function renderCreditorBalances() {
  const tbody = document.getElementById('creditorBalTbody');
  const tfoot = document.getElementById('creditorBalTfoot');
  const month = populateMonthPicker('creditorMonthPicker');
  if (!hasScopedData()) { updateKPIs([]); return emptyRow(tbody, tfoot, 7, noDataMsg()); }

  const lines = getScopedPOLines(month);
  updateKPIs(lines);
  if (!lines.length) return emptyRow(tbody, tfoot, 7, 'No creditor records for this month and filters.');

  const statusMap = buildStatusMap();
  const creds = {};
  lines.forEach(p => {
    const c = creds[p.creditorCode] || (creds[p.creditorCode] = { code: p.creditorCode, name: p.creditorName, po: 0, grn: 0, bal: 0, lines: [], locs: new Set() });
    c.po += p.lineSubTotal; c.grn += p.transVal; c.bal += p.balCost; c.lines.push(p); c.locs.add(p.loc);
  });

  const summary = [], detail = [];
  let gPO = 0, gGRN = 0, gBal = 0, html = '';
  Object.values(creds).sort((a, b) => a.code.localeCompare(b.code)).forEach((c, i) => {
    gPO += c.po; gGRN += c.grn; gBal += c.bal;
    const subId = `credSub_${i}`;
    const locNames = [...c.locs].map(locName);
    summary.push(Object.assign({ 'Creditor Code': c.code, 'Creditor Name': c.name },
      hasMultiLoc() ? { Locations: locNames.join(', ') } : {},
      { 'PO Value': c.po, 'Received Value': c.grn, 'Outstanding Bal': c.bal }));
    const docs = groupDocs(c.lines);
    const rows = docs.map(d => {
      detail.push(withLoc({ 'Creditor Code': c.code, 'Creditor Name': c.name, 'PO No': d.docNo, 'PO Date': d.docDate,
        Status: statusText(statusMap[d.key]), 'PO Value': d.totalPOVal, 'Received Value': d.totalTransVal, 'Outstanding Bal': d.totalBalCost }, d.loc));
      return `<tr><td>${poLink(d.docNo, d.loc)}${locTag(d.loc)}</td><td>${esc(d.docDate)}</td><td>${statusBadge(statusMap[d.key])}</td>
        <td class="text-right">${rm(d.totalPOVal)}</td>
        <td class="text-right" style="color:var(--accent-green);">${rm(d.totalTransVal)}</td>
        <td class="text-right" style="color:${d.totalBalCost > 0 ? 'var(--accent-orange)' : '#64748b'};font-weight:800;">${rm(d.totalBalCost)}</td></tr>`;
    }).join('');

    html += `<tr>
      <td class="text-center">${arrow(subId)}</td>
      <td><b>${esc(c.code)}</b></td><td class="cb-name"><span class="wrap">${esc(c.name)}</span></td>
      <td class="text-right">${docs.length}</td>
      <td class="text-right">${rm(c.po)}</td>
      <td class="text-right" style="color:var(--accent-green);font-weight:700;">${rm(c.grn)}</td>
      <td class="text-right" style="color:${c.bal > 0 ? 'var(--accent-orange)' : '#15803d'};font-weight:800;">${rm(c.bal)}</td>
    </tr>
    <tr id="${subId}" class="detail-subrow"><td colspan="7" class="detail-subrow-cell">
      <table class="sub-item-table"><thead><tr>
        <th>PO Doc No.</th><th>PO Date</th><th>Status</th><th class="text-right">PO Value (RM)</th>
        <th class="text-right">Received (RM)</th><th class="text-right">Outstanding (RM)</th>
      </tr></thead><tbody>${rows}</tbody></table></td></tr>`;
  });

  const nPO = Object.values(creds).reduce((a, c) => a + groupDocs(c.lines).length, 0);
  const totRow = `<tr class="cb-total">
    <td></td><td colspan="2">TOTAL — ${month === 'ALL' ? 'ALL MONTHS' : yymmLabel(month)} (${Object.keys(creds).length} creditors)</td>
    <td class="text-right">${nPO}</td><td class="text-right">${rm(gPO)}</td>
    <td class="text-right" style="color:var(--accent-green);">${rm(gGRN)}</td>
    <td class="text-right" style="color:${gBal > 0 ? 'var(--accent-orange)' : '#15803d'};">${rm(gBal)}</td></tr>`;
  tbody.innerHTML = totRow + html;
  tfoot.innerHTML = `<tr>
    <td colspan="4">TOTAL — ${month === 'ALL' ? 'ALL MONTHS' : yymmLabel(month)} (${Object.keys(creds).length} creditors)</td>
    <td class="text-right">${rm(gPO)}</td>
    <td class="text-right" style="color:#4ade80;">${rm(gGRN)}</td>
    <td class="text-right" style="color:${gBal > 0 ? '#fb923c' : '#ffffff'};">${rm(gBal)}</td>
  </tr>`;
  exportStore.creditorBalTable = { summary, detail };
}

// ----------------------------------------------------
// REPORT 7: Item Outstanding by Month
// ----------------------------------------------------
function renderItemOutstandingByMonth() {
  const tbody = document.getElementById('itemOutstandingTbody');
  const tfoot = document.getElementById('itemOutstandingTfoot');
  const month = populateMonthPicker('itemMonthPicker');
  if (!hasScopedData()) { updateKPIs([]); return emptyRow(tbody, tfoot, 6, noDataMsg()); }

  const lines = getScopedPOLines(month).filter(p => p.balQty > EPS);
  updateKPIs(lines);
  if (!lines.length) return emptyRow(tbody, tfoot, 6, 'No outstanding items for this month and filters. 🎉');

  const summary = [], detail = [];
  let gCnt = 0, gPO = 0, gBal = 0, html = '';
  const months = [...new Set(lines.map(p => p.yymm))].sort().reverse();

  months.forEach((yymm, mIdx) => {
    const mLines = lines.filter(p => p.yymm === yymm);
    const creds = {};
    mLines.forEach(p => {
      const c = creds[p.creditorCode] || (creds[p.creditorCode] = { code: p.creditorCode, name: p.creditorName, po: 0, bal: 0, items: [] });
      c.po += p.lineSubTotal; c.bal += p.balCost; c.items.push(p);
    });
    const mPO = mLines.reduce((s, p) => s + p.lineSubTotal, 0);
    const mBal = mLines.reduce((s, p) => s + p.balCost, 0);
    gCnt += mLines.length; gPO += mPO; gBal += mBal;

    html += `<tr class="yymm-header-row">
      <td class="text-center">📅</td>
      <td colspan="2"><b>${yymmLabel(yymm)} — ${Object.keys(creds).length} creditors</b></td>
      <td class="text-right">${mLines.length} lines</td>
      <td class="text-right">${rm(mPO)}</td>
      <td class="text-right" style="color:var(--accent-orange);font-weight:800;">${rm(mBal)}</td>
    </tr>`;

    Object.values(creds).sort((a, b) => b.bal - a.bal).forEach((c, cIdx) => {
      const subId = `itmSub_${mIdx}_${cIdx}`;
      const docs = [...new Map(c.items.map(p => [up(p.docNo), p])).values()];
      summary.push({ Month: yymm, 'Creditor Code': c.code, 'Creditor Name': c.name,
        'POs': docs.map(p => (hasMultiLoc() ? locName(p.loc) + ': ' : '') + p.docNo).join(', '),
        'Outstanding Lines': c.items.length, 'PO Line Value': c.po, 'Outstanding Bal': c.bal });
      const rows = c.items.map(p => {
        detail.push(lineExport(p));
        return `<tr><td>${poLink(p.docNo, p.loc)}${locTag(p.loc)}</td><td><b>${esc(p.itemCode)}</b></td><td><span class="wrap">${esc(p.description)}</span></td>
          <td class="text-right">${qtyFmt(p.balQty)} / ${qtyFmt(p.qty)}</td>
          <td class="text-right">${fmt(p.unitCost)}</td>
          <td class="text-right">${rm(p.lineSubTotal)}</td>
          <td class="text-right" style="color:var(--accent-orange);font-weight:800;">${rm(p.balCost)}</td></tr>`;
      }).join('');
      html += `<tr>
        <td class="text-center">${arrow(subId)}</td>
        <td><b>${c.code ? '[' + esc(c.code) + '] ' : ''}${esc(c.name)}</b></td>
        <td class="small-text">${docs.map(p => poLink(p.docNo, p.loc)).join(', ')}</td>
        <td class="text-right">${c.items.length} lines</td>
        <td class="text-right">${rm(c.po)}</td>
        <td class="text-right" style="color:var(--accent-orange);font-weight:800;">${rm(c.bal)}</td>
      </tr>
      <tr id="${subId}" class="detail-subrow"><td colspan="6" class="detail-subrow-cell">
        <table class="sub-item-table"><thead><tr>
          <th>PO Doc No.</th><th>Item Code</th><th>Description</th><th class="text-right">Bal / Ordered Qty</th>
          <th class="text-right">Unit Cost (RM)</th><th class="text-right">PO Line Value</th><th class="text-right">Outstanding (RM)</th>
        </tr></thead><tbody>${rows}</tbody></table></td></tr>`;
    });
  });

  tbody.innerHTML = html;
  tfoot.innerHTML = `<tr>
    <td colspan="3">TOTAL OUTSTANDING ITEMS</td>
    <td class="text-right">${gCnt} lines</td>
    <td class="text-right">${rm(gPO)}</td>
    <td class="text-right" style="color:#fb923c;">${rm(gBal)}</td>
  </tr>`;
  exportStore.itemOutstandingTable = { summary, detail };
}

// ----------------------------------------------------
// Settings
// ----------------------------------------------------
function setCompanyName(name) {
  document.querySelectorAll('.company-name').forEach(el => el.innerText = name);
  const inp = document.getElementById('cfgCompanyName');
  if (inp) inp.value = name;
}
function openSettingsModal() { switchNavTab('tab-settings'); }
function closeSettingsModal() {}
function savePortalSettings() {
  const val = document.getElementById('cfgCompanyName').value.trim();
  if (val) {
    setCompanyName(val);
    if (db.current) {
      if (val === db.current) delete store.meta.displayName; else store.meta.displayName = val;
      logAction(`Changed report heading to "${val}"`, null, 'meta');
      saveStore();
      renderCompanyUI();
    } else {
      try { localStorage.setItem(COMPANY_KEY, val); } catch (e) {}
    }
    const msg = document.getElementById('companySavedMsg');
    if (msg) { msg.innerText = '✓ Saved'; setTimeout(() => msg.innerText = '', 2000); }
  }
}

// ----------------------------------------------------
// Excel export (built from the data, not from the screen)
// ----------------------------------------------------
function exportToExcel(tableId, filename) {
  if (typeof XLSX === 'undefined') {
    alert('Excel library did not load. Check your internet connection and refresh the page.');
    return;
  }
  const data = exportStore[tableId];
  if (!data || !data.summary || !data.summary.length) {
    alert('Nothing to export yet. Upload data and open this report first.');
    return;
  }
  const wb = XLSX.utils.book_new();
  const addSheet = (rows, name) => {
    rows = rows.map(r => {
      const o = {};
      Object.keys(r).forEach(k => o[k] = (typeof r[k] === 'number' && !Number.isInteger(r[k])) ? Math.round(r[k] * 10000) / 10000 : r[k]);
      Object.keys(o).forEach(k => { if (typeof o[k] === 'number' && /Value|Bal|Total|Received|Transferred|GRN|PO Issued|Cost/i.test(k) && !/Qty|Count|Lines|POs$/i.test(k)) o[k] = Math.round(o[k] * 100) / 100; });
      return o;
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const cols = Object.keys(rows[0]);
    ws['!cols'] = cols.map(c => ({ wch: Math.min(50, Math.max(c.length, ...rows.slice(0, 200).map(r => String(r[c] == null ? '' : r[c]).length)) + 2) }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  addSheet(data.summary, tableId === 'cmpTable' ? 'Bridge' : 'Summary');
  if (data.detail && data.detail.length) addSheet(data.detail, 'Detail');
  (data.sheets || []).forEach(([name, rows]) => { if (rows && rows.length) addSheet(rows, name.slice(0, 31)); });
  const loc = getLocFilter();
  const locPart = (tableId === 'locSummaryTable' || loc === 'ALL' || !hasMultiLoc()) ? ''
    : '_' + (loc === 'MULTI' ? locSel.size + '_locations' : loc.replace(/[^A-Za-z0-9]+/g, '_'));
  const coPart = Object.keys(db.companies).length > 1 ? '_' + companyDisplay(db.current).replace(/[^A-Za-z0-9]+/g, '_').slice(0, 30) : '';
  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `${filename}${coPart}${locPart}_${stamp}.xlsx`);
}

// ====================================================
// SHARED FOLDER "DATABASE" + LOGIN
// The folder that holds index.html also holds:
//   portal-data.js   – all companies' data + who saved it + activity log
//   portal-users.js  – user list (passwords stored as salted SHA-256)
// Everyone reads these files when the page opens. "Save" writes them
// back with the browser's File System Access API (Chrome / Edge).
// ====================================================
const DATA_FILE = 'portal-data.js', DATA_BACKUP = 'portal-data.previous.js', USERS_FILE = 'portal-users.js';
const DRAFT_KEY = 'draft_v7', HANDLE_KEY = 'folder_handle';
const SESSION_KEY = 'autocount_portal_user';

let shared = { revision: 0, savedAt: '', savedBy: '', savedByName: '', summary: '' }; // what was loaded from the folder
let activityLog = [];     // saved log (from the folder)
let pendingLog = [];      // actions not yet saved
let dirty = false;        // unsaved data changes
let usersDb = { users: [] };
let usersFromFolder = false;
let currentUser = null;
let folderHandle = null;


// ====================================================
// CLOUD MODE (GitHub): the "database" is ONE encrypted file in the GitHub repository.
//   data/portal-data.bin = gzip(JSON) encrypted with AES-GCM; the key comes from the
//   company password (PBKDF2). Anyone can open the website, only people with the
//   company password can read the numbers. Saving needs a GitHub key (token) on that PC.
// Turned on automatically on *.github.io, or with portal-config.js:
//   window.PORTAL_CONFIG = { mode:'github', owner:'name', repo:'po-portal', branch:'main' }
// ====================================================
const CLOUD = (() => {
  const cfg = window.PORTAL_CONFIG || {};
  const h = location.hostname || '';
  let owner = cfg.owner || '', repo = cfg.repo || '';
  if (!owner && /\.github\.io$/i.test(h)) {
    owner = h.split('.')[0];
    const seg = location.pathname.split('/').filter(Boolean)[0];
    repo = seg && !/\.html?$/i.test(seg) ? seg : h;
  }
  const on = cfg.mode === 'github' || (!!owner && cfg.mode !== 'folder');
  return { on, owner, repo, branch: cfg.branch || 'main', path: cfg.dataFile || 'data/portal-data.bin', readUrl: cfg.readUrl || '' };
})();
const cloudMode = CLOUD.on;
let cloudKey = null;            // { key: CryptoKey, salt: Uint8Array }
let cloudFileSha = '';          // GitHub sha of the file we loaded (saving checks it)
const GH_TOKEN_KEY = 'gh_token', CLOUD_KEY_KEY = 'cloud_key';

const b64 = {
  enc(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); },
  dec(str) { const bin = atob(str); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; }
};
async function streamBytes(u8, ts) { return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(ts)).arrayBuffer()); }
async function deriveCloudKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
// File formats
//   v1 "ACP1" + salt(16) + iv(12) + AES-GCM(gzip JSON)          key = PBKDF2(company password)
//   v2 "ACP2" + headerLen(4) + header JSON + iv(12) + AES-GCM(gzip JSON)
//      header.users[hash(username)] = the data key locked with that user's password
//      header.rec                    = the data key locked with the admin's recovery password
async function userHashId(username) { return (await sha256Hex('acp-user:' + String(username || '').trim().toLowerCase())).slice(0, 24); }
function parseCloudFile(bytes) {
  const tag = new TextDecoder().decode(bytes.subarray(0, 4));
  if (tag === 'ACP1') return { ver: 1, salt: new Uint8Array(bytes.subarray(4, 20)), iv: bytes.subarray(20, 32), ct: bytes.subarray(32), header: null };
  if (tag === 'ACP2') {
    const n = new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + n)));
    return { ver: 2, header, iv: bytes.subarray(8 + n, 20 + n), ct: bytes.subarray(20 + n) };
  }
  throw new Error('not a portal data file');
}
async function cloudDecrypt(bytes, key) {
  const f = parseCloudFile(bytes);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: f.iv }, key, f.ct));
  return JSON.parse(new TextDecoder().decode(await streamBytes(plain, new DecompressionStream('gzip'))));
}
async function cloudEncrypt(obj, k, header) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const zipped = await streamBytes(new TextEncoder().encode(JSON.stringify(obj)), new CompressionStream('gzip'));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k.key, zipped));
  const hb = new TextEncoder().encode(JSON.stringify(header || { v: 2, users: {} }));
  const out = new Uint8Array(8 + hb.length + 12 + ct.length);
  out.set(new TextEncoder().encode('ACP2'), 0);
  new DataView(out.buffer).setUint32(4, hb.length, true);
  out.set(hb, 8); out.set(iv, 8 + hb.length); out.set(ct, 20 + hb.length);
  return out;
}
async function newDataKey() { return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']); }
async function wrapDataKey(dataKey, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const pk = await deriveCloudKey(password, salt);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', dataKey));
  const w = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, pk, raw));
  return { s: b64.enc(salt), iv: b64.enc(iv), w: b64.enc(w) };
}
async function unwrapDataKey(entry, password) {
  const pk = await deriveCloudKey(password, b64.dec(entry.s));
  const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(entry.iv) }, pk, b64.dec(entry.w)));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
}
async function buildCloudHeader() {
  const users = {};
  for (const u of usersDb.users || []) if (u.wrap) users[await userHashId(u.username)] = u.wrap;
  return { v: 2, users, rec: usersDb.rec || null, legacy: usersDb.legacy || null };
}
// The very first saves used a key made from the company password + a salt. Find that salt:
// in the header, or in the oldest saved version of the file (GitHub keeps every version).
async function findLegacySalt(header) {
  if (header && header.legacy) return b64.dec(header.legacy);
  try {
    const r = await fetch(`https://api.github.com/repos/${CLOUD.owner}/${CLOUD.repo}/commits?path=${encodeURIComponent(CLOUD.path)}&per_page=100&sha=${encodeURIComponent(CLOUD.branch)}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const list = await r.json();
    for (const c of list.slice().reverse()) {          // oldest first
      const f = await fetch(`https://raw.githubusercontent.com/${CLOUD.owner}/${CLOUD.repo}/${c.sha}/${CLOUD.path}`, { cache: 'no-store' });
      if (!f.ok) continue;
      const b = new Uint8Array(await f.arrayBuffer());
      if (new TextDecoder().decode(b.subarray(0, 4)) === 'ACP1') return new Uint8Array(b.subarray(4, 20));
    }
  } catch (e) {}
  return null;
}
async function rememberCloudKey(k) {
  try { const raw = new Uint8Array(await crypto.subtle.exportKey('raw', k.key)); localStorage.setItem(CLOUD_KEY_KEY, JSON.stringify({ key: b64.enc(raw) })); } catch (e) {}
}
async function storedCloudKey() {
  try {
    const o = JSON.parse(localStorage.getItem(CLOUD_KEY_KEY) || 'null');
    if (!o || !o.key) return null;
    return { key: await crypto.subtle.importKey('raw', b64.dec(o.key), 'AES-GCM', true, ['encrypt', 'decrypt']), legacy: o.salt || null };
  } catch (e) { return null; }
}
function canUpload() { return !!(currentUser && (currentUser.admin || currentUser.uploader)); }
function ghToken() {
  let t = '';
  try { t = localStorage.getItem(GH_TOKEN_KEY) || ''; } catch (e) {}
  if (!t && canUpload() && usersDb && usersDb.ghKey) t = usersDb.ghKey;     // key kept inside the locked data
  return t;
}
const ghApi = p => `https://api.github.com/repos/${encodeURIComponent(CLOUD.owner)}/${encodeURIComponent(CLOUD.repo)}${p}`;
async function ghFetch(p, opt) {
  const t = ghToken();
  const r = await fetch(ghApi(p), Object.assign({}, opt || {}, { headers: Object.assign({ Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, t ? { Authorization: 'Bearer ' + t } : {}, (opt || {}).headers || {}) }));
  return r;
}
// read the data file. With a key: through the API (always the newest). Without: from the website.
async function cloudReadFile() {
  if (ghToken()) {
    const meta = await ghFetch(`/contents/${CLOUD.path}?ref=${encodeURIComponent(CLOUD.branch)}&t=${Date.now()}`, { cache: 'no-store' });
    if (meta.status === 404) return { bytes: null, sha: '' };
    if (meta.status === 401 || meta.status === 403) throw new Error('the GitHub key on this PC is not accepted (wrong or expired). Settings → Cloud → change the key.');
    if (!meta.ok) throw new Error('GitHub answered ' + meta.status);
    const m = await meta.json();
    const raw = await ghFetch(`/contents/${CLOUD.path}?ref=${encodeURIComponent(CLOUD.branch)}&t=${Date.now()}`, { cache: 'no-store', headers: { Accept: 'application/vnd.github.raw' } });
    if (!raw.ok) throw new Error('GitHub answered ' + raw.status + ' while downloading the data');
    return { bytes: new Uint8Array(await raw.arrayBuffer()), sha: m.sha };
  }
  // 1) straight from the repository (fresh within a few minutes)  2) the website copy
  const urls = CLOUD.readUrl ? [CLOUD.readUrl] : [`https://raw.githubusercontent.com/${CLOUD.owner}/${CLOUD.repo}/${CLOUD.branch}/${CLOUD.path}`]
    .concat(/\.github\.io$/i.test(location.hostname) ? [CLOUD.path] : []);
  let lastErr = null, all404 = true;
  for (const url of urls) {
    try {
      const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
      if (r.ok) return { bytes: new Uint8Array(await r.arrayBuffer()), sha: '' };
      if (r.status !== 404) { all404 = false; lastErr = new Error('could not download the data (' + r.status + ')'); }
    } catch (e) { all404 = false; lastErr = e; }
  }
  if (all404) return { bytes: null, sha: '' };
  throw lastErr || new Error('could not download the data');
}
// Cloud log-in: username + password open the data. A user who has no personal lock yet
// (data saved by an older version) types the company/recovery password once.
function cloudLoginScreen(bytes, msg) {
  const file = parseCloudFile(bytes);
  return new Promise(resolve => {
    const scr = document.getElementById('authScreen'), card = document.getElementById('authCard');
    document.body.classList.add('auth-open'); scr.classList.add('open');
    let needRec = file.ver === 1;
    const draw = (m) => {
      card.innerHTML = `<div class="auth-brand">📊 AutoCount PO Portal</div><h2>Log in</h2>
        <form id="cloudLoginForm">
          <label>Username<input id="clUser" required autocomplete="username"></label>
          <label>Password<input id="clPw" type="password" required autocomplete="current-password"></label>
          <div id="clRecBox" style="${needRec ? '' : 'display:none'}"><label>Company / recovery password <span class="muted">(needed once)</span><input id="clRec" type="password"></label>
            <p class="muted small-text">First time with the new login on this account. After this, only your username and password are needed.</p></div>
          <label class="auth-check"><input type="checkbox" id="clRemember" checked> Remember me on this PC</label>
          <div class="auth-msg" id="clMsg">${m ? esc(m) : ''}</div>
          <button class="btn btn-excel auth-btn" type="submit">Log in</button></form>`;
      document.getElementById('cloudLoginForm').onsubmit = submit;
    };
    const submit = async ev => {
      ev.preventDefault();
      const username = document.getElementById('clUser').value.trim().toLowerCase();
      const pw = document.getElementById('clPw').value, rec = (document.getElementById('clRec') || {}).value || '';
      const out = document.getElementById('clMsg');
      out.textContent = 'Opening…';
      try {
        let key = null, viaRec = false, legacySalt = null;
        const entry = file.ver === 2 && file.header.users ? file.header.users[await userHashId(username)] : null;
        if (entry) { try { key = await unwrapDataKey(entry, pw); } catch (e) { key = null; } }
        if (!key) {
          if (!rec) {
            if (!entry) { needRec = true; document.getElementById('clRecBox').style.display = ''; out.textContent = 'This account has no personal login yet — type the company / recovery password once.'; return; }
            out.textContent = '✗ Wrong username or password.'; return;
          }
          viaRec = true;
          if (file.ver === 1) { key = await deriveCloudKey(rec, file.salt); legacySalt = file.salt; }
          else if (file.header.rec) { try { key = await unwrapDataKey(file.header.rec, rec); } catch (e) { key = null; } }
          if (!key && file.ver === 2) {
            out.textContent = 'Checking the company password…';
            const salt = await findLegacySalt(file.header);
            if (salt) { key = await deriveCloudKey(rec, salt); legacySalt = salt; }
          }
          if (!key) { out.textContent = '✗ Wrong company / recovery password.'; return; }
        }
        let payload;
        try { payload = await cloudDecrypt(bytes, key); } catch (e) { out.textContent = viaRec ? '✗ Wrong company / recovery password.' : '✗ Wrong username or password.'; return; }
        if (legacySalt && !payload.users.legacy) payload.users.legacy = b64.enc(legacySalt);
        const users = (payload.users && payload.users.users) || [];
        const u = users.find(x => x.username === username);
        if (!u || (await hashPw(u.salt, pw)) !== u.hash) { out.textContent = '✗ Wrong username or password.'; return; }
        cloudKey = { key };
        const remember = document.getElementById('clRemember').checked;
        if (remember) await rememberCloudKey(cloudKey);
        // give this user a personal lock (and keep the company password as the recovery password)
        if (viaRec || !u.wrap) {
          u.wrap = await wrapDataKey(key, pw);
          if (rec && !payload.users.rec) payload.users.rec = await wrapDataKey(key, rec);   // the company password becomes the recovery password
          window.__cloudLoginUpgrade = `Set up the new login for ${u.name || u.username}`;
        }
        window.__cloudLoginUser = { u, remember };
        scr.classList.remove('open'); document.body.classList.remove('auth-open');
        resolve(payload);
      } catch (e) { out.textContent = '✗ ' + e.message; }
    };
    draw(msg);
  });
}
async function cloudLoad() {
  let f;
  try { f = await cloudReadFile(); }
  catch (e) { window.__cloudError = e.message; return null; }
  cloudFileSha = f.sha;
  if (!f.bytes) { window.__cloudEmpty = true; return null; }   // nothing saved yet (first time)
  let payload = null;
  const k = await storedCloudKey();
  if (k) { try { payload = await cloudDecrypt(f.bytes, k.key); cloudKey = k; if (k.legacy && payload.users && !payload.users.legacy) payload.users.legacy = k.legacy; } catch (e) { payload = null; } }
  if (!payload) payload = await cloudLoginScreen(f.bytes);
  return payload;
}
async function askRecoveryPassword(title) {
  const p1 = prompt((title || 'Set the RECOVERY PASSWORD (admin only).') + '\nIt can open the data if everyone forgets their password. Keep it somewhere safe.\n\nRecovery password (at least 6 characters):');
  if (!p1) return null;
  if (p1.length < 6) { alert('Please use at least 6 characters.'); return null; }
  const p2 = prompt('Type the recovery password again:');
  if (p1 !== p2) { alert('The two passwords are different. Nothing changed.'); return null; }
  return p1;
}
async function cloudWrite(bytes, sha, message) {
  const body = { message, content: b64.enc(bytes), branch: CLOUD.branch };
  if (sha) body.sha = sha;
  const r = await ghFetch(`/contents/${CLOUD.path}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.status === 409 || r.status === 422) return { conflict: true };
  if (r.status === 401 || r.status === 403) throw new Error('the GitHub key on this PC is not allowed to save (wrong, expired, or no "Contents: Read and write" permission).');
  if (r.status === 404) throw new Error(`repository ${CLOUD.owner}/${CLOUD.repo} not found, or the key has no access to it.`);
  if (!r.ok) throw new Error('GitHub answered ' + r.status);
  const j = await r.json();
  return { sha: j.content && j.content.sha };
}
async function saveToCloud() {
  if (!currentUser) return alert('Please log in first.');
  if (!canUpload() && !(localStorage.getItem(GH_TOKEN_KEY))) return alert('You can view but not save. Ask the admin to tick you as "Uploader" in Settings → Users.');
  if (!ghToken()) {
    if (confirm('No GitHub key is set yet, so the data cannot be saved.\n\nOK = open Settings → Cloud (the admin adds the key once).')) { switchNavTab('tab-settings'); setTimeout(() => { const c = document.getElementById('cloudCard'); if (c) c.scrollIntoView({ behavior: 'smooth' }); }, 300); }
    return;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const f = await cloudReadFile();
    let latest = null;
    if (f.bytes) {
      if (!cloudKey) { alert('Please log in again (reload the page) before saving.'); return; }
      try { latest = await cloudDecrypt(f.bytes, cloudKey.key); }
      catch (e) { alert('The data on GitHub was locked with a different key (it was set up again elsewhere). Reload the page and log in.'); return; }
    } else if (!cloudKey) {
      // very first save from a session that has no data key yet
      const me = (usersDb.users || []).find(x => x.username === currentUser.username);
      const pw = prompt('Type YOUR login password to lock the data:');
      if (!pw || !me || (await hashPw(me.salt, pw)) !== me.hash) { alert('Wrong password — nothing saved.'); return; }
      cloudKey = { key: await newDataKey() };
      me.wrap = await wrapDataKey(cloudKey.key, pw);
      await rememberCloudKey(cloudKey);
    }
    const meU = (usersDb.users || []).find(x => x.username === currentUser.username);
    if (meU && !meU.wrap) {
      const pw = prompt('One-time step: type YOUR login password, so it can open the data on other devices:');
      if (!pw || (await hashPw(meU.salt, pw)) !== meU.hash) { alert('Wrong password — nothing saved.'); return; }
      meU.wrap = await wrapDataKey(cloudKey.key, pw);
    }
    if (f.bytes && !usersDb.rec && currentUser.admin && !window.__recAsked) {
      window.__recAsked = true;
      const rp = await askRecoveryPassword('Please set a RECOVERY PASSWORD (admin only) — you can use your old company password.');
      if (rp) usersDb.rec = await wrapDataKey(cloudKey.key, rp);
    }
    if (!f.bytes && !usersDb.rec) {
      const rp = await askRecoveryPassword('Last step: set a RECOVERY PASSWORD (admin only).');
      if (rp) usersDb.rec = await wrapDataKey(cloudKey.key, rp);
      else if (!confirm('No recovery password: if the admin forgets the password, the data cannot be opened.\n\nOK = save without it (you can set it later in Settings)')) return;
    }
    let merged = false;
    if (latest && latest.db && (latest.revision || 0) > shared.revision) {
      const mineTxt = visibleLog(pendingLog).map(e => '• ' + e.action).join('\n') || '• (no changes)';
      const ok = confirm(`${latest.savedByName || latest.savedBy} saved newer data on ${latest.savedAt} after you opened the portal:\n  ${latest.summary || ''}\n\nYour changes:\n${mineTxt}\n\nOK = combine: keep their data and add your changes (recommended)\nCancel = don't save now`);
      if (!ok) return;
      db = mergeMyChanges(latest.db);
      if (!pendingLog.some(e => e.part === 'users') && latest.users) usersDb = latest.users;
      else if (latest.users && latest.users.rec && !usersDb.rec) usersDb.rec = latest.users.rec;
      merged = true;
    }
    const now = nowText();
    const entries = (visibleLog(pendingLog).length ? visibleLog(pendingLog) : [{ action: 'Saved data', company: db.current }])
      .map(e => Object.assign({}, e, { by: currentUser.username, byName: currentUser.name, savedAt: now }));
    const log = ((latest && latest.log) || activityLog).concat(entries).slice(-1000);
    const payload = { version: 8, revision: Math.max(shared.revision, (latest && latest.revision) || 0) + 1,
      savedAt: now, savedBy: currentUser.username, savedByName: currentUser.name, summary: summarizeEntries(entries), db, log, users: usersDb };
    const bytes = await cloudEncrypt(payload, cloudKey, await buildCloudHeader());
    const res = await cloudWrite(bytes, f.sha, `Portal data saved by ${currentUser.name}: ${payload.summary}`.slice(0, 200));
    if (res.conflict) continue;                     // someone saved at the same moment: read again and combine
    cloudFileSha = res.sha || '';
    afterSharedSave(payload, log, merged);
    ensureNoJekyll();
    showToast('✓ Saved to the cloud (GitHub). Others see it when they reload — the website can take about 1–2 minutes to update.');
    return;
  }
  alert('Someone else kept saving at the same moment. Please try Save again.');
}
async function ensureNoJekyll() {
  try {
    if (localStorage.getItem('nojekyll_ok') === CLOUD.owner + '/' + CLOUD.repo) return;
    const r = await ghFetch('/contents/.nojekyll?ref=' + encodeURIComponent(CLOUD.branch));
    if (r.status === 404) await ghFetch('/contents/.nojekyll', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Publish the data folder as-is', content: '', branch: CLOUD.branch }) });
    localStorage.setItem('nojekyll_ok', CLOUD.owner + '/' + CLOUD.repo);
  } catch (e) {}
}
function showCloudStartScreen() {
  const scr = document.getElementById('authScreen'), card = document.getElementById('authCard');
  document.body.classList.add('auth-open'); scr.classList.add('open');
  const err = window.__cloudError;
  card.innerHTML = `<div class="auth-brand">📊 AutoCount PO Portal</div>
    <h2>${err ? '⚠ Could not load the data' : 'No saved data found yet'}</h2>
    <p class="muted">${err ? 'GitHub did not answer: ' + esc(err) + '.<br>Check the internet connection, then press Reload.'
      : 'If someone saved data a moment ago, GitHub needs 1–3 minutes. Wait a little, then press Reload.'}</p>
    <button class="btn btn-excel auth-btn" onclick="location.reload()">🔄 Reload</button>
    <p class="muted small-text" style="margin-top:16px;">Setting up the portal for the very first time?
      <a href="#" onclick="showAuth('setup');return false;">Create the first account</a></p>`;
}
// Import the shared-folder files (portal-data.js / portal-users.js) into the cloud
function importFolderFiles(ev) {
  const files = [...ev.target.files]; ev.target.value = '';
  if (!files.length) return;
  Promise.all(files.map(f => f.text().then(t => ({ name: f.name, t })))).then(list => {
    let n = 0;
    list.forEach(({ name, t }) => {
      if (/PORTAL_DATA/.test(t)) {
        const d = parseJsVar(t, 'PORTAL_DATA');
        if (d && d.db && d.db.companies) {
          db = d.db; Object.values(db.companies).forEach(fixCompany);
          if (!db.companies[db.current]) db.current = Object.keys(db.companies)[0] || '';
          store = db.companies[db.current] || emptyCompany();
          activityLog = d.log || activityLog;
          pendingLog.push({ action: `Imported shared-folder data (${Object.keys(db.companies).length} companies)`, company: db.current, part: 'all' });
          Object.keys(db.companies).forEach(c => { if (c !== db.current) pendingLog.push({ action: 'Imported', company: c, part: 'all', hidden: true }); });
          n++;
        }
      }
      if (/PORTAL_USERS/.test(t)) {
        const u = parseJsVar(t, 'PORTAL_USERS');
        if (u && Array.isArray(u.users) && u.users.length) { usersDb = u; pendingLog.push({ action: `Imported ${u.users.length} users`, company: db.current, part: 'users' }); n++; }
      }
    });
    if (!n) return alert('These are not portal-data.js / portal-users.js files.');
    dirty = true;
    afterDataChange(); renderSyncBar(); renderCloudInfo(); renderUserAdmin();
    alert('Imported. Click 💾 Save to Cloud to put it on GitHub.' + (/PORTAL_USERS/.test(list.map(x => x.t).join('')) ? '\nThe users and passwords from the shared folder work here too.' : ''));
  });
}
async function changeCloudPassword() {
  if (!currentUser || !currentUser.admin) return alert('Only the admin can set the recovery password.');
  if (!ghToken()) return alert('This PC needs the GitHub key first.');
  if (!cloudKey) return alert('Please log in again first.');
  const rp = await askRecoveryPassword(usersDb.rec ? 'Choose the NEW recovery password.' : 'Set the RECOVERY PASSWORD (admin only).');
  if (!rp) return;
  usersDb.rec = await wrapDataKey(cloudKey.key, rp);
  pendingLog.push({ action: 'Changed the recovery password', company: db.current, part: 'users' });
  dirty = true;
  await saveToCloud();
}
function setGhToken() {
  if (!currentUser || !currentUser.admin) return alert('Only the admin can set the GitHub key.');
  const t = prompt('Paste the GitHub key (fine-grained personal access token) for ' + CLOUD.owner + '/' + CLOUD.repo + ':\n\nIt is kept inside the LOCKED data, so the admin and users ticked as "Uploader" can save from any device after logging in.');
  if (t === null) return;
  usersDb.ghKey = t.trim() || undefined;
  try { if (t.trim()) localStorage.setItem(GH_TOKEN_KEY, t.trim()); else localStorage.removeItem(GH_TOKEN_KEY); } catch (e) {}
  pendingLog.push({ action: t.trim() ? 'Set the GitHub key' : 'Removed the GitHub key', company: db.current, part: 'users' });
  dirty = true; saveStore();
  renderCloudInfo(); renderSyncBar();
  if (t.trim()) saveToShared();
}
function forgetCloudOnPC() {
  if (!confirm('Remove the GitHub key and the remembered company password from THIS PC?')) return;
  try { localStorage.removeItem(GH_TOKEN_KEY); localStorage.removeItem(CLOUD_KEY_KEY); } catch (e) {}
  location.reload();
}
async function testCloud() {
  const box = document.getElementById('cloudTest');
  box.innerHTML = 'Checking…';
  try {
    const r = await ghFetch('');
    if (r.status === 404) throw new Error(`repository ${CLOUD.owner}/${CLOUD.repo} not found (or the key has no access).`);
    if (r.status === 401) throw new Error('the GitHub key is wrong or expired.');
    const j = await r.json();
    const canWrite = !!(j.permissions && (j.permissions.push || j.permissions.admin));
    box.innerHTML = `<span class="ok">✓ Repository found${ghToken() ? (canWrite ? ' · this key can save ✓' : ' · <b>this key cannot save</b> — give it "Contents: Read and write"') : ' · no key on this PC (view only)'}</span>`;
  } catch (e) { box.innerHTML = `<span class="note-warn">✗ ${esc(e.message)}</span>`; }
}
function renderCloudInfo() {
  const box = document.getElementById('cloudInfo');
  if (!box) return;
  const tok = ghToken();
  box.innerHTML = `<table class="audit-table loc-master-table"><tbody>
    <tr><td style="width:220px;"><b>Repository</b></td><td>${esc(CLOUD.owner)}/${esc(CLOUD.repo)} · branch ${esc(CLOUD.branch)} · file <code>${esc(CLOUD.path)}</code></td></tr>
    <tr><td><b>GitHub key</b></td><td>${usersDb.ghKey ? `✓ saved in the locked data (…${esc(usersDb.ghKey.slice(-4))}) — the admin and <b>Uploader</b> users can save from any device` : (tok ? `✓ on this PC only (…${esc(tok.slice(-4))})` : '— not set: nobody can save yet')}
      <div class="muted small-text">You: ${canUpload() ? '<b>can save</b> ✓' : '<b>view only</b> (ask the admin to tick you as Uploader)'}</div>
      ${currentUser && currentUser.admin ? `<button class="btn-small" onclick="setGhToken()">${usersDb.ghKey || tok ? 'Change key' : 'Add key'}</button>` : ''} <button class="btn-small" onclick="testCloud()">Test</button> <span id="cloudTest"></span></td></tr>
    <tr><td><b>Login</b></td><td>Each user's own <b>username + password</b> opens the data${cloudKey ? ' · ✓ open on this PC' : ''}.
      Users without the new login yet: ${(usersDb.users || []).filter(u => !u.wrap).map(u => esc(u.name || u.username)).join(', ') || 'none ✓'}
      ${(usersDb.users || []).some(u => !u.wrap) ? '<div class="muted small-text">They log in once with the company / recovery password, or the admin resets their password.</div>' : ''}</td></tr>
    <tr><td><b>Recovery password</b></td><td>${usersDb.rec ? '✓ set' : '⚠ not set'} <span class="muted small-text">(opens the data if everyone forgets their password)</span>
      ${currentUser && currentUser.admin ? ` <button class="btn-small" onclick="changeCloudPassword()">${usersDb.rec ? 'Change' : 'Set'} recovery password</button>` : ''}</td></tr>
    <tr><td><b>Move data from the shared folder</b></td><td>Choose <code>portal-data.js</code> and <code>portal-users.js</code> from the old shared folder, then click 💾 Save to Cloud.
      <label class="btn-small" style="display:inline-block;">📂 Choose files<input type="file" multiple accept=".js" style="display:none" onchange="importFolderFiles(event)"></label></td></tr>
    <tr><td><b>This PC</b></td><td><button class="btn-small" onclick="forgetCloudOnPC()">Forget key + password on this PC</button></td></tr>
  </tbody></table>`;
}

// ---------- loading the shared files ----------
function loadScriptFile(name) {
  return new Promise(resolve => {
    const s = document.createElement('script');
    s.src = name + '?v=' + Date.now();          // always the latest copy
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}
async function loadSharedFiles() {
  await Promise.all([loadScriptFile(USERS_FILE), loadScriptFile(DATA_FILE)]);
  if (window.PORTAL_USERS && Array.isArray(window.PORTAL_USERS.users)) {
    usersDb = window.PORTAL_USERS;
    usersFromFolder = true;
  } else {
    try { const u = JSON.parse(localStorage.getItem('autocount_portal_users_draft') || 'null'); if (u && u.users) usersDb = u; } catch (e) {}
  }
  const d = window.PORTAL_DATA;
  if (d && d.db && d.db.companies) {
    shared = { revision: d.revision || 0, savedAt: d.savedAt || '', savedBy: d.savedBy || '', savedByName: d.savedByName || '', summary: d.summary || '' };
    activityLog = d.log || [];
    return d.db;
  }
  return null;
}

// Called at start-up instead of the old browser-only loader
async function loadAllData() {
  let sharedDb = null;
  if (cloudMode) {
    const d = await cloudLoad();
    if (d && d.db && d.db.companies) {
      shared = { revision: d.revision || 0, savedAt: d.savedAt || '', savedBy: d.savedBy || '', savedByName: d.savedByName || '', summary: d.summary || '' };
      activityLog = d.log || [];
      if (d.users && Array.isArray(d.users.users)) { usersDb = d.users; usersFromFolder = true; }
      sharedDb = d.db;
    } else {
      try { const u = JSON.parse(localStorage.getItem('autocount_portal_users_draft') || 'null'); if (u && u.users) usersDb = u; } catch (e) {}
    }
  } else sharedDb = await loadSharedFiles();
  if (cloudMode && window.__cloudLoginUser) {
    const { u, remember } = window.__cloudLoginUser;
    setCurrentUser(u, remember);
  }
  let draft = null;
  try { draft = await idbGet(DRAFT_KEY); } catch (e) {}

  if (sharedDb) {
    db = sharedDb;
    if (draft && draft.downloadedRev && shared.revision >= draft.downloadedRev &&
        (draft.pendingLog || []).length === draft.downloadedLen) {
      try { await idbDel(DRAFT_KEY); } catch (e) {}   // the downloaded file was copied into the folder
      draft = null;
    }
    if (draft && draft.dirty && draft.db) {
      if ((draft.baseRevision || 0) === shared.revision) {
        db = draft.db; pendingLog = draft.pendingLog || []; dirty = true;
      } else {
        window.__olderDraft = draft;   // someone saved after this draft was made
      }
    }
  } else if (draft && draft.db) {
    db = draft.db; pendingLog = draft.pendingLog || []; dirty = !!draft.dirty;
  } else {
    await loadStore();                 // data saved by older versions in this browser
    if (Object.keys(db.companies || {}).length) {
      dirty = true;
      pendingLog = [{ action: 'Imported data that was saved in this browser', company: db.current, part: 'all' }];
    }
  }
  db.companies = db.companies || {};
  Object.values(db.companies).forEach(fixCompany);
  if (!db.companies[db.current]) db.current = Object.keys(db.companies)[0] || '';
  store = db.companies[db.current] || emptyCompany();
  if (cloudMode && window.__cloudLoginUpgrade) {        // personal login created: save it with the next Save
    pendingLog.push({ action: window.__cloudLoginUpgrade, company: db.current, part: 'users' });
    dirty = true;
  }
}

// ---------- local draft (unsaved work survives a refresh) ----------
let draftTimer = null;
function saveStore() {           // every data change ends up here
  dirty = true;
  renderSyncBar();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    idbSet(DRAFT_KEY, { db, dirty: true, baseRevision: shared.revision, pendingLog, at: new Date().toISOString(), downloadedRev: window.__dlRev || 0, downloadedLen: window.__dlLen || 0 })
      .catch(err => console.warn('Draft not saved', err));
  }, 200);
}
function logAction(action, company, part) {
  pendingLog.push({ action, company: company || db.current, part: part || 'all', at: nowText() });
}
function visibleLog(list) { return list.filter(e => !e.hidden); }

// Put MY unsaved changes on top of the LATEST shared data.
// Each change only replaces what it touched (e.g. the PO file of one company).
function mergeMyChanges(latestDb) {
  const out = { version: 6, current: db.current, companies: Object.assign({}, (latestDb && latestDb.companies) || {}) };
  const copyCo = c => { const t = Object.assign(emptyCompany(), out.companies[c] || {}); t.meta = Object.assign({}, t.meta); t.locMaster = Object.assign({}, t.locMaster); t.cancels = Object.assign({}, t.cancels); t.poCreditors = Object.assign({}, t.poCreditors); return (out.companies[c] = t); };
  pendingLog.forEach(e => {
    const c = e.company;
    if (e.part === 'rename') {
      if (out.companies[e.from] && !out.companies[c]) { out.companies[c] = out.companies[e.from]; delete out.companies[e.from]; }
      return;
    }
    if (e.part === 'delete') { delete out.companies[c]; return; }
    const mine = db.companies[c];
    if (!mine) return;
    if (e.part === 'all') { out.companies[c] = mine; return; }
    const t = copyCo(c);
    t.meta.company = mine.meta.company || c;
    if (e.part === 'po') {
      t.po = mine.po; t.meta.poFile = mine.meta.poFile; t.meta.poLoadedAt = mine.meta.poLoadedAt;
      Object.keys(mine.locMaster || {}).forEach(k => { if (!t.locMaster[k]) t.locMaster[k] = mine.locMaster[k]; });
    } else if (e.part === 'grn') {
      t.grn = mine.grn; t.meta.grnFile = mine.meta.grnFile; t.meta.grnLoadedAt = mine.meta.grnLoadedAt;
    } else if (e.part === 'loc') {
      t.locMaster = Object.assign({}, mine.locMaster); t.meta.locFile = mine.meta.locFile; t.meta.locLoadedAt = mine.meta.locLoadedAt;
    } else if (e.part === 'cxfile') {
      t.cxLines = (mine.cxLines || []).slice(); t.meta.cxFile = mine.meta.cxFile; t.meta.cxLoadedAt = mine.meta.cxLoadedAt;
    } else if (e.part === 'delrange') {
      const inR = iso => { const m = iso ? isoToYYMM(iso) : ''; return m && m >= e.from && m <= e.to; };
      const w = delWhatSet(e.what);
      if (w.po) t.po = (t.po || []).filter(p => !inR(p.iso));
      if (w.grn) t.grn = (t.grn || []).filter(g => !inR(g.grnIso));
      if (w.cx) t.cxLines = (t.cxLines || []).filter(x => !inR(x.iso));
    } else if (e.part === 'clear') {
      t.po = []; t.grn = []; ['poFile', 'poLoadedAt', 'grnFile', 'grnLoadedAt'].forEach(k => delete t.meta[k]);
    } else if (e.part === 'credlist') {
      t.credMaster = Object.assign({}, mine.credMaster || {}); t.meta.credFile = mine.meta.credFile; t.meta.credLoadedAt = mine.meta.credLoadedAt;
    } else if (e.part === 'rules') {
      t.credRules = mine.credRules ? mine.credRules.map(r => Object.assign({}, r)) : undefined;
    } else if (e.part === 'pocred') {
      t.poCreditors = Object.assign({}, t.poCreditors || {});
      (e.keys || []).forEach(k => { if (mine.poCreditors && mine.poCreditors[k]) t.poCreditors[k] = mine.poCreditors[k]; else delete t.poCreditors[k]; });
    } else if (e.part === 'cancel') {
      t.cancels = Object.assign({}, t.cancels || {});
      (e.keys || []).forEach(k => { if (mine.cancels && mine.cancels[k]) t.cancels[k] = mine.cancels[k]; else delete t.cancels[k]; });
    } else if (e.part === 'meta') {
      if (mine.meta.displayName) t.meta.displayName = mine.meta.displayName; else delete t.meta.displayName;
      if (mine.meta.locFollowGrn === false) t.meta.locFollowGrn = false; else delete t.meta.locFollowGrn;
    }
  });
  if (!out.companies[out.current]) out.current = Object.keys(out.companies)[0] || '';
  return out;
}
function nowText() { return new Date().toLocaleString('en-GB', { hour12: false }).replace(',', ''); }

// ---------- folder access ----------
function fsSupported() { return serverMode || typeof window.showDirectoryPicker === 'function'; }

// ---------- Save helper (portal-server.ps1) ----------
// When the portal is opened through http://SERVER:8080 the helper saves the files,
// so no folder needs to be chosen and Chrome's folder rules don't matter.
let serverMode = false;
let serverRoot = '';
async function detectServer() {
  if (!/^https?:$/.test(location.protocol)) return false;
  try {
    const r = await withTimeout(fetch('__portal/ping?t=' + Date.now(), { cache: 'no-store' }), 3000, null);
    if (r && r.ok) { const j = await r.json(); serverMode = !!(j && j.ok); serverRoot = (j && j.root) || ''; }
  } catch (e) {}
  if (serverMode) {
    // tell the helper this tab is still open (it stops by itself after the portal is closed)
    const beat = () => fetch('__portal/alive?t=' + Date.now(), { cache: 'no-store' }).catch(() => {});
    setInterval(beat, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) beat(); });
  }
  return serverMode;
}
function serverFolder() {
  const url = n => encodeURIComponent(n) + '?t=' + Date.now();
  const fetch = async (u, o) => {
    try { return await window.fetch(u, o); }
    catch (e) { throw new DOMException('The portal helper is not running (it stops a few minutes after the portal is closed).', 'NetworkError'); }
  };
  const file = name => ({
    getFile: async () => {
      const r = await fetch(url(name), { cache: 'no-store' });
      if (!r.ok) throw new DOMException(name + ' not found', 'NotFoundError');
      const t = await r.text();
      return { text: async () => t };
    },
    createWritable: async () => {
      let buf = '';
      return {
        write: async t => { buf += t; },
        close: async () => {
          const r = await fetch(encodeURIComponent(name), { method: 'PUT', body: buf, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
          if (!r.ok) { let t = ''; try { t = await r.text(); } catch (e) {} throw new DOMException(t || `The save helper refused to write ${name} (${r.status})`, 'NoModificationAllowedError'); }
        }
      };
    }
  });
  return {
    kind: 'directory', name: location.host,
    queryPermission: async () => 'granted', requestPermission: async () => 'granted',
    getFileHandle: async (name, opts) => {
      const r = await fetch(url(name), { method: 'HEAD', cache: 'no-store' });
      if (!r.ok && !(opts && opts.create)) throw new DOMException(name + ' not found', 'NotFoundError');
      return file(name);
    },
    removeEntry: async name => { await fetch(encodeURIComponent(name), { method: 'DELETE' }); }
  };
}
// Show what went wrong instead of failing silently
function folderError(e, step) {
  console.error('Folder error while ' + step, e);
  const n = (e && e.name) || 'Error', m = (e && e.message) || String(e);
  if (n === 'AbortError') { showToast('No folder chosen — nothing was saved.'); return; }
  let hint = '';
  if (n === 'SecurityError' && /gesture|activation/i.test(m)) hint = 'Please click the Save button again (Chrome needs a fresh click).';
  else if (n === 'SecurityError' || n === 'NotAllowedError') hint = 'Chrome blocked access to this folder. Possible reasons:\n• You picked the TOP of a drive or share (e.g. Z:\\ or \\\\SERVER\\Shared). Chrome never allows that — put the portal in a sub-folder (e.g. Z:\\POPortal) and pick that, or drag the folder onto Settings → Shared Folder\n• Your company IT has blocked "file editing" for websites in Chrome/Edge (ask IT to allow the File System Access API for this page)\n• The folder is a protected system folder\n• You clicked "Block" earlier: click the lock/file icon at the left of the address bar → site settings → allow "File editing"';
  else if (n === 'NotFoundError') hint = 'The folder was moved, renamed or the network drive is disconnected. Go to Settings → Shared Folder → Change shared folder.';
  else if (n === 'NoModificationAllowedError' || n === 'InvalidModificationError' || /denied|permission/i.test(m)) hint = 'You don\'t have WRITE access to this network folder. Ask IT to give you read + write permission.';
  else if (n === 'NetworkError') hint = 'Close this tab and open the portal again with the "Open Portal" shortcut. Your unsaved uploads are kept — then click 💾 Save again.';
  else if (n === 'TypeError') hint = 'This browser cannot save to folders. Please use Google Chrome or Microsoft Edge (latest version).';
  alert(`Could not save (${step}).\n\n${n}: ${m}\n\n${hint}\n\nTip: Settings → Shared Folder → "🔧 Test saving" checks every step.\nPlan B: click "⬇ Can't save? Download file" next to the Save button and copy the file into the shared folder.`);
}

let lastFolderIssue = '';
async function getFolder(interactive) {
  lastFolderIssue = '';
  if (serverMode) return serverFolder();
  if (!folderHandle) { try { folderHandle = await idbGet(HANDLE_KEY); } catch (e) {} }
  if (folderHandle) {
    try {
      let p = await folderHandle.queryPermission({ mode: 'readwrite' });
      if (p !== 'granted' && interactive) p = await folderHandle.requestPermission({ mode: 'readwrite' });
      if (p === 'granted') return folderHandle;
      if (!interactive) return null;
      lastFolderIssue = `Chrome is not allowed to edit "${folderHandle.name}" (you clicked Block/Cancel on "Edit files")`;
      alert(`Chrome is not allowed to edit files in "${folderHandle.name}".\nClick Save again and choose "Allow" / "Edit files".\n(Or Settings → Shared Folder → Change shared folder.)`);
      return null;
    } catch (e) {
      lastFolderIssue = 'Saved folder cannot be opened: ' + e.name + ' ' + e.message;
      if (interactive) { folderError(e, 'opening the saved folder'); }
      folderHandle = null;
      return null;
    }
  }
  if (!interactive) return null;
  if (!fsSupported()) return null;
  showToast('📁 Choose the SHARED FOLDER where this portal (index.html) is kept. This is asked only once on this PC.');
  let h;
  try { h = await window.showDirectoryPicker({ id: 'autocount-portal', mode: 'readwrite' }); }
  catch (e) {
    lastFolderIssue = e.name === 'AbortError' ? 'The Select Folder window was closed / cancelled — no folder was picked'
      : 'Chrome refused the folder: ' + e.name + ' — ' + e.message;
    folderError(e, 'choosing the folder'); return null;
  }
  let hasIndex = true;
  try { await h.getFileHandle('index.html'); } catch (e) { hasIndex = false; }
  if (!hasIndex && !confirm(`The folder "${h.name}" does not contain index.html.\nIt should be the same folder as the portal so everyone reads the same data.\n\nUse this folder anyway?`)) { lastFolderIssue = `You picked "${h.name}" (no index.html) and chose not to use it`; return null; }
  try {
    const p = await h.requestPermission({ mode: 'readwrite' });
    if (p !== 'granted') { lastFolderIssue = `Picked "${h.name}" but "Edit files" was not allowed`; alert('Chrome was not allowed to edit files in this folder.\nClick Save again and choose "Edit files" / "Allow" when Chrome asks.'); return null; }
  } catch (e) { lastFolderIssue = 'Permission error: ' + e.name + ' ' + e.message; folderError(e, 'asking permission'); return null; }
  folderHandle = h;
  try { await idbSet(HANDLE_KEY, h); } catch (e) {}
  renderFolderInfo();
  return h;
}
// ---------- Settings: which folder this PC saves to ----------
function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise(res => setTimeout(() => res(fallback), ms))]);
}
async function renderFolderInfo() {
  const box = document.getElementById('folderInfo');
  if (!box) return;
  if (serverMode) {
    box.innerHTML = `<div class="folder-row"><span class="folder-ico">🟢</span>
      <div style="flex:1;"><b>💾 Save writes into:</b> <span class="folder-path">${esc(serverRoot || '(the portal folder)')}</span>
        <div class="muted">${/^[cC]:\\/.test(serverRoot) ? '⚠ This looks like a folder on THIS PC, not the network. Open the portal with a shortcut to "Open Portal.bat" that is inside the network folder.' : 'No folder needs to be chosen on this PC.'}</div></div>
      <button class="btn btn-settings btn-sm" onclick="testSaving()">🔧 Test saving</button></div><div id="folderTest"></div>`;
    return;
  }
  const helperTip = '<div class="helper-tip">💡 <b>Save not working on the network drive?</b> Close this page and open the portal with <b>Open Portal.bat</b> (in the same folder as index.html — make a desktop shortcut). It starts a small helper on this PC and 💾 Save works without choosing a folder.</div>';
  if (!fsSupported()) {
    box.innerHTML = '<p class="note-warn">This browser cannot save into a folder. Please use Google Chrome or Microsoft Edge (not inside another app).</p>' +
      '<div class="muted">You can still use "⬇ Can\'t save? Download file" next to the Save button.</div>';
    return;
  }
  // draw the buttons first so they always appear
  box.innerHTML = `
    <div class="folder-row">
      <span class="folder-ico">📁</span>
      <div style="flex:1;" id="folderStatus"><span class="muted">Checking…</span></div>
      <button class="btn btn-excel btn-sm" onclick="changeFolder()">📁 Choose / change shared folder</button>
      <button class="btn btn-settings btn-sm" onclick="testSaving()">🔧 Test saving</button>
      <button class="btn btn-ghost btn-sm" onclick="forgetFolder()">Forget</button>
    </div>
    <div class="folder-drop" id="folderDrop" ondragover="event.preventDefault();this.classList.add('over')" ondragleave="this.classList.remove('over')" ondrop="onFolderDrop(event)">
      📂 <b>Can't pick the network folder?</b> Open the network drive in File Explorer, then <b>drag the portal folder and drop it here</b>.
    </div>
    <div id="folderTest"></div>${helperTip}`;
  const st = document.getElementById('folderStatus');
  let h = folderHandle;
  if (!h) { try { h = await withTimeout(idbGet(HANDLE_KEY), 3000, null); } catch (e) {} }
  let perm = '';
  if (h) { try { perm = await withTimeout(h.queryPermission({ mode: 'readwrite' }), 3000, 'unknown'); } catch (e) { perm = 'error'; } }
  if (!st) return;
  st.innerHTML = h
    ? `This PC saves to the folder <b>${esc(h.name)}</b>
       <div class="muted">${perm === 'granted' ? '✓ Allowed to save' : 'Chrome will ask "Allow edit files?" on the next save — click Allow.'}</div>
       <div class="muted small-text">It must be the same folder that contains index.html (the one everyone opens).</div>`
    : `<b>No folder chosen yet on this PC.</b>
       <div class="muted">Click "Choose / change shared folder", or drag the folder into the blue box below.</div>`;
}
// Step-by-step check of everything Save needs
async function testSaving() {
  const out = [];
  const box = () => document.getElementById('folderTest');
  const show = () => { const b = box(); if (b) b.innerHTML = '<div class="folder-test">' + out.map(([ok, t]) => `<div class="${ok === true ? 'ok' : ok === false ? 'bad' : ''}">${ok === true ? '✓' : ok === false ? '✗' : '•'} ${t}</div>`).join('') + '</div>'; };
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Microsoft Edge ' + (ua.match(/Edg\/([\d]+)/) || [])[1] : /Chrome\//.test(ua) ? 'Google Chrome ' + (ua.match(/Chrome\/([\d]+)/) || [])[1] : 'Other browser';
  out.push([/Chrome|Edg/.test(ua) ? true : false, `Browser: ${esc(browser)}`]);
  out.push([null, `Opened from: ${esc(location.protocol === 'file:' ? decodeURIComponent(location.pathname).replace(/^\/([A-Za-z]:)/, '$1') : location.href)}`]);
  out.push([window.isSecureContext, 'Secure page: ' + (window.isSecureContext ? 'yes' : 'no')]);
  out.push([fsSupported(), serverMode ? 'Saving through the Save Helper: yes' : 'Folder saving supported: ' + (fsSupported() ? 'yes' : 'NO — use Chrome or Edge')]);
  out.push([!!currentUser, 'Logged in: ' + (currentUser ? esc(currentUser.name) : 'no')]);
  show();
  if (!fsSupported()) return;
  let h;
  try {
    h = await getFolder(true);
    if (!h) {
      out.push([false, 'Folder: ' + esc(lastFolderIssue || 'not chosen or not allowed')]);
      out.push([null, 'Try: click <b>📁 Choose / change shared folder</b> → in the window, click the portal folder ONCE (do not open it) → <b>Select Folder</b> → <b>Edit files</b>. If the network folder cannot be selected, drag it into the blue box instead.']);
      return show();
    }
    out.push([true, `Folder: <b>${esc(serverMode && serverRoot ? serverRoot : h.name)}</b>`]);
    let hasIndex = true; try { await h.getFileHandle('index.html'); } catch (e) { hasIndex = false; }
    out.push([hasIndex, hasIndex ? 'index.html found in this folder' : 'index.html is NOT in this folder — pick the folder everyone opens the portal from']);
    out.push([true, 'Permission: ' + (await h.queryPermission({ mode: 'readwrite' }))]);
  } catch (e) { out.push([false, 'Folder: ' + esc(e.name + ': ' + e.message)]); return show(); }
  show();
  try {
    await writeFolderText(h, 'portal-test.txt', 'test ' + new Date().toISOString());
    out.push([true, 'Write a test file: OK']);
    const back = await readFolderText(h, 'portal-test.txt');
    out.push([!!back, 'Read it back: ' + (back ? 'OK' : 'failed')]);
    try { await h.removeEntry('portal-test.txt'); out.push([true, 'Delete test file: OK']); } catch (e) { out.push([null, 'Delete test file: not allowed (you can delete portal-test.txt yourself)']); }
    const d = parseJsVar(await readFolderText(h, DATA_FILE), 'PORTAL_DATA');
    out.push([null, d ? `Shared data in folder: saved by ${esc(d.savedByName || d.savedBy)} on ${esc(d.savedAt)}` : 'No portal-data.js in this folder yet (normal before the first save)']);
    out.push([true, '<b>Everything works — 💾 Save should work on this PC.</b>']);
  } catch (e) {
    out.push([false, 'Write a test file FAILED: ' + esc(e.name + ': ' + e.message)]);
    out.push([false, 'You probably don\'t have WRITE access to this folder, or IT blocks file editing in the browser. Send this screen to IT.']);
  }
  show();
}

async function changeFolder() {
  if (!fsSupported()) return alert('Please use Google Chrome or Microsoft Edge.');
  let h;
  try { h = await window.showDirectoryPicker({ id: 'autocount-portal', mode: 'readwrite' }); }
  catch (e) { return; }   // cancelled
  let hasIndex = true;
  try { await h.getFileHandle('index.html'); } catch (e) { hasIndex = false; }
  if (!hasIndex && !confirm(`The folder "${h.name}" does not contain index.html.\nPick the folder that everyone opens the portal from.\n\nUse "${h.name}" anyway?`)) return;
  try { await h.requestPermission({ mode: 'readwrite' }); } catch (e) {}
  folderHandle = h;
  try { await idbSet(HANDLE_KEY, h); } catch (e) {}
  // warn if this folder holds different data from what is on screen
  const latest = parseJsVar(await readFolderText(h, DATA_FILE), 'PORTAL_DATA');
  renderFolderInfo();
  if (latest && latest.revision !== shared.revision) {
    showToast(`Folder "${h.name}" set. It has different data (saved by ${latest.savedByName || latest.savedBy} on ${latest.savedAt}). Open index.html from that folder to see it.`);
  } else showToast(`✓ This PC will now save to "${h.name}".`);
}
// Drag a folder from File Explorer onto the page (works for network folders too)
async function onFolderDrop(ev) {
  ev.preventDefault();
  const zone = document.getElementById('folderDrop');
  if (zone) zone.classList.remove('over');
  const item = [...(ev.dataTransfer && ev.dataTransfer.items || [])].find(i => i.kind === 'file');
  if (!item || typeof item.getAsFileSystemHandle !== 'function') return alert('Dropping folders needs Google Chrome or Microsoft Edge.');
  let h;
  try { h = await item.getAsFileSystemHandle(); } catch (e) { return folderError(e, 'reading the dropped folder'); }
  if (!h || h.kind !== 'directory') return alert('Please drop the FOLDER (the one that contains index.html), not a file.');
  try {
    const p = await h.requestPermission({ mode: 'readwrite' });
    if (p !== 'granted') return alert('Chrome was not allowed to edit files in this folder. Drop it again and choose "Edit files" / "Allow".');
  } catch (e) { return folderError(e, 'asking permission'); }
  let hasIndex = true;
  try { await h.getFileHandle('index.html'); } catch (e) { hasIndex = false; }
  if (!hasIndex && !confirm(`The folder "${h.name}" does not contain index.html.\nUse it anyway?`)) return;
  folderHandle = h;
  try { await idbSet(HANDLE_KEY, h); } catch (e) {}
  renderFolderInfo();
  showToast(`✓ This PC will now save to "${h.name}".`);
}
document.addEventListener('dragover', e => { if (e.target.closest && !e.target.closest('.drop-zone,#folderDrop')) e.preventDefault(); });
document.addEventListener('drop', e => { if (e.target.closest && !e.target.closest('.drop-zone,#folderDrop')) e.preventDefault(); });

async function forgetFolder() {
  if (!confirm('Forget the shared folder on this PC? You will be asked to choose it again on the next save.')) return;
  folderHandle = null;
  try { await idbDel(HANDLE_KEY); } catch (e) {}
  renderFolderInfo();
}

async function readFolderText(h, name) {
  try { const f = await (await h.getFileHandle(name)).getFile(); return await f.text(); }
  catch (e) { return null; }
}
async function writeFolderText(h, name, text) {
  const fh = await h.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}
function parseJsVar(text, varName) {
  if (!text) return null;
  const i = text.indexOf('=', text.indexOf(varName));
  if (i < 0) return null;
  try { return JSON.parse(text.slice(i + 1).trim().replace(/;\s*$/, '')); } catch (e) { return null; }
}
function downloadText(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- SAVE ----------
let saving = false;
// Plan B: download portal-data.js (+ users) and copy it into the shared folder by hand
function manualSave() {
  if (!currentUser) return alert('Please log in first.');
  const now = nowText();
  const entries = (visibleLog(pendingLog).length ? visibleLog(pendingLog) : [{ action: 'Saved data', company: db.current }])
    .map(e => Object.assign({}, e, { by: currentUser.username, byName: currentUser.name, savedAt: now }));
  const payload = {
    version: 7, revision: shared.revision + 1,
    savedAt: now, savedBy: currentUser.username, savedByName: currentUser.name,
    summary: summarizeEntries(entries), db, log: activityLog.concat(entries).slice(-1000)
  };
  downloadText(DATA_FILE, '/* AutoCount PO Portal shared data. Do not edit by hand. */\nwindow.PORTAL_DATA = ' + JSON.stringify(payload) + ';\n');
  if (!usersFromFolder && usersDb.users.length) {
    setTimeout(() => downloadText(USERS_FILE, '/* AutoCount PO Portal users. Passwords are hashed. Do not edit by hand. */\nwindow.PORTAL_USERS = ' + JSON.stringify(usersDb) + ';\n'), 600);
  }
  window.__dlRev = payload.revision; window.__dlLen = pendingLog.length;
  saveStore();
  alert(`Downloaded "${DATA_FILE}"${!usersFromFolder && usersDb.users.length ? ` and "${USERS_FILE}"` : ''} to your Downloads folder.\n\n` +
    `Now:\n1. Open your Downloads folder\n2. Copy the file(s)\n3. Paste into the shared folder (where index.html is) → choose "Replace"\n4. Come back here and click 🔄 Reload latest\n\n` +
    `⚠ Do this soon — if someone else saves in the meantime, their save would be replaced.`);
}

async function saveToShared() {
  if (saving) return;
  if (cloudMode) {
    saving = true;
    try { await saveToCloud(); } catch (err) { alert('Could not save to GitHub: ' + err.message); } finally { saving = false; }
    return;
  }
  if (!currentUser) return alert('Please log in first.');
  saving = true;
  try {
    const h = await getFolder(true);
    const now = nowText();
    let latest = null;
    if (h) latest = parseJsVar(await readFolderText(h, DATA_FILE), 'PORTAL_DATA');

    let merged = false;
    if (latest && latest.db && (latest.revision || 0) > shared.revision) {
      const mineTxt = visibleLog(pendingLog).map(e => '• ' + e.action).join('\n') || '• (no changes)';
      const ok = confirm(`${latest.savedByName || latest.savedBy} saved newer data on ${latest.savedAt} after you opened the portal:\n` +
        `  ${latest.summary || ''}\n\nYour changes:\n${mineTxt}\n\nOK = combine: keep their data and add your changes (recommended)\nCancel = don't save now`);
      if (!ok) return;
      db = mergeMyChanges(latest.db);
      merged = true;
    }
    const entries = (visibleLog(pendingLog).length ? visibleLog(pendingLog) : [{ action: 'Saved data', company: db.current }])
      .map(e => Object.assign({}, e, { by: currentUser.username, byName: currentUser.name, savedAt: now }));
    const log = ((latest && latest.log) || activityLog).concat(entries).slice(-1000);
    const payload = {
      version: 7,
      revision: Math.max(shared.revision, (latest && latest.revision) || 0) + 1,
      savedAt: now, savedBy: currentUser.username, savedByName: currentUser.name,
      summary: summarizeEntries(entries),
      db, log
    };
    const text = '/* AutoCount PO Portal shared data. Do not edit by hand. */\nwindow.PORTAL_DATA = ' + JSON.stringify(payload) + ';\n';

    if (h) {
      const prev = await readFolderText(h, DATA_FILE);
      if (prev) { try { await writeFolderText(h, DATA_BACKUP, prev); } catch (e) {} }
      await writeFolderText(h, DATA_FILE, text);
    } else if (fsSupported()) {
      return;   // folder not chosen / not allowed — the reason was already shown
    } else {
      if (!confirm('This browser cannot save into the folder directly (use Google Chrome or Microsoft Edge).\n\nOK = download "portal-data.js" now, then copy it into the shared folder (replace the old one).')) return;
      downloadText(DATA_FILE, text);
    }
    afterSharedSave(payload, log, merged);
    showToast(h ? '✓ Saved to the shared folder. Everyone will see this data when they open or reload the portal.' : 'File downloaded. Copy it into the shared folder to share it.');
  } catch (err) {
    folderError(err, 'writing portal-data.js');
  } finally { saving = false; }
}
function afterSharedSave(payload, log, merged) {
  shared = { revision: payload.revision, savedAt: payload.savedAt, savedBy: payload.savedBy, savedByName: payload.savedByName, summary: payload.summary };
  activityLog = log;
  pendingLog = []; dirty = false;
  window.__olderDraft = null;
  if (merged) switchCompany(db.companies[db.current] ? db.current : Object.keys(db.companies)[0] || '');
  idbDel(DRAFT_KEY).catch(() => {});
  try { localStorage.removeItem('autocount_portal_users_draft'); } catch (e) {}
  renderSyncBar(); renderActivityLog(); updateUploadSummary();
  if (cloudMode) renderCloudInfo();
}
function summarizeEntries(entries) {
  return entries.map(e => e.action + (e.company ? ` (${companyDisplay(e.company)})` : '')).join('; ').slice(0, 300);
}
function reloadLatest() {
  if (dirty && !confirm('You have uploads that are NOT saved yet. Reload anyway?\n(They stay in this browser as a draft; you can still save them later.)')) return;
  location.reload();
}
function discardDraft() {
  if (!confirm('Throw away your unsaved uploads and show the shared data?')) return;
  idbDel(DRAFT_KEY).finally(() => location.reload());
}

// ---------- status bar under the top bar ----------
function renderSyncBar() {
  const bar = document.getElementById('syncBar');
  if (!bar) return;
  const last = shared.savedAt
    ? `☁️ Last saved by <b>${esc(shared.savedByName || shared.savedBy)}</b> on <b>${esc(shared.savedAt)}</b>${shared.summary ? ` <span class="muted">— ${esc(shared.summary)}</span>` : ''}`
    : (cloudMode ? '☁️ <b>Nothing saved to the cloud yet.</b>' : '☁️ <b>Nothing saved to the shared folder yet.</b>');
  let warn = '';
  if (dirty) warn = `<span class="sync-dirty">⚠ You have unsaved changes (${visibleLog(pendingLog).length || 1}) — others cannot see them yet.</span>`;
  else if (window.__olderDraft) warn = `<span class="sync-dirty">⚠ Someone saved newer data since your unsaved uploads (${esc(visibleLog(window.__olderDraft.pendingLog || []).length)} item(s)). <a href="#" onclick="restoreOlderDraft();return false;">Add my uploads to the latest data</a> · <a href="#" onclick="discardDraft();return false;">Discard them</a></span>`;
  bar.className = 'sync-bar' + (dirty ? ' is-dirty' : '');
  bar.innerHTML = `<div class="sync-text">${last}${warn ? '<br>' + warn : ''}</div>
    <div class="sync-actions">
      <button class="btn btn-settings btn-sm" onclick="reloadLatest()" title="Load the newest data saved by anyone">🔄 Reload latest</button>
      ${dirty ? '<button class="btn btn-sm btn-ghost" onclick="discardDraft()">Discard</button>' : ''}
      <button class="btn btn-excel ${dirty ? 'pulse' : ''}" onclick="saveToShared()">${cloudMode ? (ghToken() ? '💾 Save to Cloud' : (currentUser && !canUpload() ? '👁 View only' : '💾 Save (needs GitHub key)')) : '💾 Save to Shared Folder'}</button>
      ${dirty && !serverMode && !cloudMode ? '<button class="btn btn-sm btn-ghost" onclick="manualSave()" title="Use this if Save does not work on this PC">⬇ Can\'t save? Download file</button>' : ''}
    </div>`;
}
function restoreOlderDraft() {
  const d = window.__olderDraft;
  if (!d) return;
  const latestDb = db;
  db = d.db; pendingLog = d.pendingLog || [];
  db = mergeMyChanges(latestDb);
  window.__olderDraft = null;
  switchCompany(db.current in db.companies ? db.current : Object.keys(db.companies)[0]);
  saveStore();
}
window.addEventListener('beforeunload', e => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- activity log (Settings) ----------
function renderActivityLog() {
  const box = document.getElementById('activityLog');
  if (!box) return;
  const rows = activityLog.slice().reverse().slice(0, 200);
  const pend = visibleLog(pendingLog).slice().reverse();
  if (!rows.length && !pend.length) { box.innerHTML = '<p class="muted">No activity yet.</p>'; return; }
  box.innerHTML = `<div class="table-container" style="max-height:420px;overflow-y:auto;"><table class="audit-table loc-master-table">
    <thead><tr><th>Saved On</th><th>By</th><th>Company</th><th>What</th></tr></thead><tbody>` +
    pend.map(e => `<tr class="log-pending"><td><i>not saved yet</i></td><td>${esc(currentUser ? currentUser.name : '')}</td><td>${esc(companyDisplay(e.company))}</td><td>${esc(e.action)}</td></tr>`).join('') +
    rows.map(e => `<tr><td>${esc(e.savedAt || e.at || '')}</td><td><b>${esc(e.byName || e.by || '')}</b></td><td>${esc(e.company ? companyDisplay(e.company) : '')}</td><td>${esc(e.action)}</td></tr>`).join('') +
    '</tbody></table></div>';
}

// ====================================================
// LOGIN
// ====================================================
// SHA-256 (uses the browser's crypto when available, otherwise a small JS version)
async function sha256Hex(text) {
  try {
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch (e) {}
  return sha256js(text);
}
function sha256js(ascii) {
  const rr = (v, a) => (v >>> a) | (v << (32 - a));
  const bytes = unescape(encodeURIComponent(ascii));
  const k = [], h = [];
  let primeCounter = 0;
  const isComposite = {};
  for (let c = 2; primeCounter < 64; c++) {
    if (!isComposite[c]) {
      for (let i = 0; i < 313; i += c) isComposite[i] = c;
      h[primeCounter] = (Math.pow(c, 0.5) * 4294967296) | 0;
      k[primeCounter++] = (Math.pow(c, 1 / 3) * 4294967296) | 0;
    }
  }
  const H = h.slice(0, 8);
  const words = [];
  let s = bytes + '\x80';
  while (s.length % 64 - 56) s += '\x00';
  for (let i = 0; i < s.length; i++) words[i >> 2] |= s.charCodeAt(i) << ((3 - i) % 4) * 8;
  words[words.length] = ((bytes.length * 8) / 4294967296) | 0;
  words[words.length] = (bytes.length * 8) | 0;
  for (let j = 0; j < words.length;) {
    const w = words.slice(j, j += 16);
    const old = H.slice(0);
    for (let i = 0; i < 64; i++) {
      const w15 = w[i - 15], w2 = w[i - 2];
      const a = H[0], e = H[4];
      const t1 = H[7] + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & H[5]) ^ (~e & H[6])) + k[i] +
        (w[i] = i < 16 ? w[i] : (w[i - 16] + (rr(w15, 7) ^ rr(w15, 18) ^ (w15 >>> 3)) + w[i - 7] + (rr(w2, 17) ^ rr(w2, 19) ^ (w2 >>> 10))) | 0);
      const t2 = (rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & H[1]) ^ (a & H[2]) ^ (H[1] & H[2]));
      H.unshift((t1 + t2) | 0);
      H[4] = (H[4] + t1) | 0;
      H.pop();
    }
    for (let i = 0; i < 8; i++) H[i] = (H[i] + old[i]) | 0;
  }
  return H.map(v => ((v >>> 0).toString(16)).padStart(8, '0')).join('');
}
function newSalt() {
  const a = new Uint8Array(12);
  try { crypto.getRandomValues(a); } catch (e) { for (let i = 0; i < a.length; i++) a[i] = Math.random() * 256; }
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hashPw(salt, pw) { return sha256Hex(salt + ':' + pw); }
function findUser(username) { return usersDb.users.find(u => u.username === String(username || '').trim().toLowerCase()); }

function showAuth(mode, msg) {
  const scr = document.getElementById('authScreen');
  const card = document.getElementById('authCard');
  if (!scr || !card) return;
  document.body.classList.add('auth-open');
  scr.classList.add('open');
  if (mode === 'setup') {
    card.innerHTML = `
      <div class="auth-brand">📊 AutoCount PO Portal</div>
      <h2>Create the first account</h2>
      <p class="muted">No users yet. This first account becomes the <b>admin</b>, who can add the other users.</p>
      <form onsubmit="authSetup(event)">
        <label>Your name<input id="auName" required placeholder="e.g. Sheng"></label>
        <label>Username<input id="auUser" required autocomplete="username" placeholder="e.g. sheng"></label>
        <label>Password<input id="auPw" type="password" required minlength="4" autocomplete="new-password"></label>
        <label>Repeat password<input id="auPw2" type="password" required minlength="4" autocomplete="new-password"></label>
        <div class="auth-msg">${msg ? esc(msg) : ''}</div>
        <button class="btn btn-excel auth-btn" type="submit">${cloudMode ? 'Create account' : 'Create account &amp; save to shared folder'}</button>
      </form>`;
  } else {
    card.innerHTML = `
      <div class="auth-brand">📊 AutoCount PO Portal</div>
      <h2>Log in</h2>
      ${shared.savedAt ? `<p class="muted">Data last saved by <b>${esc(shared.savedByName || shared.savedBy)}</b> on ${esc(shared.savedAt)}</p>` : ''}
      <form onsubmit="authLogin(event)">
        <label>Username<input id="auUser" required autocomplete="username" autofocus></label>
        <label>Password<input id="auPw" type="password" required autocomplete="current-password"></label>
        <label class="auth-check"><input type="checkbox" id="auRemember"> Keep me logged in on this PC</label>
        <div class="auth-msg">${msg ? esc(msg) : ''}</div>
        <button class="btn btn-excel auth-btn" type="submit">Log in</button>
      </form>
      ${!usersFromFolder ? '<p class="muted small-text" style="margin-top:10px;">⚠ The user list has not been saved to the shared folder yet.</p>' : ''}`;
  }
  setTimeout(() => { const f = card.querySelector('input'); if (f) f.focus(); }, 50);
}
function hideAuth() {
  document.getElementById('authScreen').classList.remove('open');
  document.body.classList.remove('auth-open');
}

async function authSetup(e) {
  e.preventDefault();
  const name = document.getElementById('auName').value.trim();
  const username = document.getElementById('auUser').value.trim().toLowerCase();
  const pw = document.getElementById('auPw').value, pw2 = document.getElementById('auPw2').value;
  if (!/^[a-z0-9._-]{2,30}$/.test(username)) return showAuth('setup', 'Username: 2–30 letters/numbers, no spaces.');
  if (pw !== pw2) return showAuth('setup', 'The two passwords are different.');
  const salt = newSalt();
  const user = { username, name: name || username, salt, hash: await hashPw(salt, pw), admin: true, createdAt: nowText() };
  usersDb = { users: [user], updatedAt: nowText() };
  if (cloudMode) { cloudKey = { key: await newDataKey() }; user.wrap = await wrapDataKey(cloudKey.key, pw); await rememberCloudKey(cloudKey); }
  setCurrentUser(user, true);
  const ok = await writeUsers();
  if (!ok) showToast('Account created on this PC. Click "💾 Save to Shared Folder" later to share the user list.');
}
async function authLogin(e) {
  e.preventDefault();
  const u = findUser(document.getElementById('auUser').value);
  const pw = document.getElementById('auPw').value;
  if (!u || (await hashPw(u.salt, pw)) !== u.hash) return showAuth('login', 'Wrong username or password.');
  if (cloudMode && cloudKey && !u.wrap) {
    u.wrap = await wrapDataKey(cloudKey.key, pw);
    pendingLog.push({ action: `Set up the new login for ${u.name || u.username}`, company: db.current, part: 'users' });
    dirty = true; saveStore();
  }
  setCurrentUser(u, document.getElementById('auRemember').checked);
}
function setCurrentUser(u, remember) {
  currentUser = { username: u.username, name: u.name, admin: !!u.admin, uploader: !!u.uploader };
  try {
    sessionStorage.setItem(SESSION_KEY, u.username);
    if (remember) localStorage.setItem(SESSION_KEY, u.username); else localStorage.removeItem(SESSION_KEY);
  } catch (e) {}
  hideAuth();
  renderUserBox(); renderUserAdmin(); renderSyncBar(); renderActivityLog();
}
function restoreSession() {
  let name = null;
  try { name = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY); } catch (e) {}
  const u = name && findUser(name);
  if (u) { currentUser = { username: u.username, name: u.name, admin: !!u.admin, uploader: !!u.uploader }; return true; }
  return false;
}
function logout() {
  if (dirty && !confirm('You have unsaved uploads. Log out anyway? (They stay on this PC as a draft.)')) return;
  try { sessionStorage.removeItem(SESSION_KEY); localStorage.removeItem(SESSION_KEY); } catch (e) {}
  currentUser = null;
  renderUserBox();
  showAuth('login');
}
function renderUserBox() {
  const el = document.getElementById('userBox');
  if (!el) return;
  el.innerHTML = currentUser
    ? `<span title="${esc(currentUser.username)}">👤 <b>${esc(currentUser.name)}</b>${currentUser.admin ? ' <span class="loc-tag">ADMIN</span>' : ''}</span><button class="btn btn-ghost btn-sm" onclick="logout()">Log out</button>`
    : '';
}

// Users are changed on the LATEST copy in the folder, so two admins don't overwrite each other
async function writeUsers(change) {
  if (cloudMode) {
    if (change) { const r = change(usersDb); if (r === false) return false; }
    usersDb.updatedAt = nowText();
    try { localStorage.setItem('autocount_portal_users_draft', JSON.stringify(usersDb)); } catch (e) {}
    pendingLog.push({ action: 'Changed the user list', company: db.current, part: 'users' });
    dirty = true; saveStore(); renderUserAdmin(); renderSyncBar();
    if (ghToken() && currentUser) { await saveToShared(); return !dirty; }
    if (!currentUser) return true;     // very first account: saved with the first data save
    alert('User list changed on this PC. Click 💾 Save to Cloud (needs the GitHub key) so it works on other PCs.');
    return true;
  }
  const h = await getFolder(true);
  if (h) {
    const latest = parseJsVar(await readFolderText(h, USERS_FILE), 'PORTAL_USERS');
    if (latest && Array.isArray(latest.users) && change) usersDb = latest;
  }
  if (change) { const r = change(usersDb); if (r === false) return false; }
  usersDb.updatedAt = nowText();
  const text = '/* AutoCount PO Portal users. Passwords are hashed. Do not edit by hand. */\nwindow.PORTAL_USERS = ' + JSON.stringify(usersDb) + ';\n';
  try { localStorage.setItem('autocount_portal_users_draft', JSON.stringify(usersDb)); } catch (e) {}
  if (!h) {
    if (!fsSupported() && confirm('This browser cannot save into the folder directly. Download "portal-users.js" and copy it into the shared folder?')) downloadText(USERS_FILE, text);
    renderUserAdmin();
    return false;
  }
  try {
    await writeFolderText(h, USERS_FILE, text);
    usersFromFolder = true;
    try { localStorage.removeItem('autocount_portal_users_draft'); } catch (e) {}
    renderUserAdmin();
    return true;
  } catch (err) { alert('Could not save the user list: ' + err.message); return false; }
}

// ---------- Settings: users ----------
function renderUserAdmin() {
  const box = document.getElementById('userAdmin');
  if (!box) return;
  const me = currentUser;
  let html = '';
  if (me) html += `<div class="loc-add" style="margin:0 0 14px 0;">
      <span style="flex:1;">Logged in as <b>${esc(me.name)}</b> (${esc(me.username)})</span>
      <button class="btn btn-settings btn-sm" onclick="changeMyPassword()">🔑 Change my password</button></div>`;
  html += `<table class="audit-table loc-master-table"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Created</th><th></th></tr></thead><tbody>` +
    usersDb.users.map(u => `<tr><td><b>${esc(u.name)}</b></td><td>${esc(u.username)}</td><td>${u.admin ? 'Admin' : u.uploader ? 'Uploader' : 'Viewer'}</td><td class="muted">${esc(u.createdAt || '')}</td>
      <td class="text-right">${me && me.admin ? `<button class="btn btn-settings btn-sm" onclick="resetUserPassword('${esc(u.username)}')">Reset password</button>
        ${u.username !== me.username ? `${u.admin ? '' : `<label class="auth-check" style="display:inline-flex;margin-right:6px;" title="Can upload and save"><input type="checkbox" ${u.uploader ? 'checked' : ''} onchange="toggleUploader('${esc(u.username)}')"> Uploader</label>`}<button class="btn btn-settings btn-sm" onclick="toggleAdmin('${esc(u.username)}')">${u.admin ? 'Remove admin' : 'Make admin'}</button>
        <button class="btn btn-danger btn-sm" onclick="deleteUser('${esc(u.username)}')">Delete</button>` : ''}` : ''}</td></tr>`).join('') +
    '</tbody></table>';
  if (me && me.admin) html += `
    <form class="user-add" onsubmit="addUser(event)">
      <input id="nuName" placeholder="Name, e.g. Mei Ling" required>
      <input id="nuUser" placeholder="Username" required>
      <input id="nuPw" type="password" placeholder="Password" required minlength="4" autocomplete="new-password">
      <label class="auth-check"><input type="checkbox" id="nuAdmin"> Admin</label>
      <button class="btn btn-excel" type="submit">＋ Add user</button>
    </form>`;
  else if (me) html += '<p class="muted" style="margin-top:10px;">Only an admin can add or remove users.</p>';
  if (cloudMode) { if (pendingLog.some(e => e.part === 'users')) html += '<p class="note-warn" style="margin-top:10px;">⚠ User list not saved to the cloud yet. <a href="#" onclick="saveToShared();return false;">💾 Save to Cloud</a></p>'; }
  else if (!usersFromFolder && usersDb.users.length) html += '<p class="note-warn" style="margin-top:10px;">⚠ User list not saved to the shared folder yet. <a href="#" onclick="writeUsers();return false;">Save it now</a></p>';
  box.innerHTML = html;
}
async function addUser(e) {
  e.preventDefault();
  const name = document.getElementById('nuName').value.trim();
  const username = document.getElementById('nuUser').value.trim().toLowerCase();
  const pw = document.getElementById('nuPw').value;
  const admin = document.getElementById('nuAdmin').checked;
  if (!/^[a-z0-9._-]{2,30}$/.test(username)) return alert('Username: 2–30 letters/numbers, no spaces.');
  const salt = newSalt(), hash = await hashPw(salt, pw);
  const wrap = cloudMode && cloudKey ? await wrapDataKey(cloudKey.key, pw) : undefined;
  const ok = await writeUsers(d => {
    if (d.users.some(u => u.username === username)) { alert('That username already exists.'); return false; }
    d.users.push(Object.assign({ username, name, salt, hash, admin, createdAt: nowText(), createdBy: currentUser.username }, wrap ? { wrap } : {}));
  });
  if (ok !== false) showToast(`User "${name}" added. Tell them their username and password.`);
}
async function resetUserPassword(username) {
  const pw = prompt(`New password for ${username}:`);
  if (!pw) return;
  if (pw.length < 4) return alert('Password must be at least 4 characters.');
  const salt = newSalt(), hash = await hashPw(salt, pw);
  const wrap = cloudMode && cloudKey ? await wrapDataKey(cloudKey.key, pw) : undefined;
  const ok = await writeUsers(d => { const u = d.users.find(x => x.username === username); if (!u) return false; u.salt = salt; u.hash = hash; if (wrap) u.wrap = wrap; });
  if (ok) showToast('Password changed.');
}
async function changeMyPassword() {
  const cur = prompt('Current password:');
  if (cur == null) return;
  const u = findUser(currentUser.username);
  if (!u || (await hashPw(u.salt, cur)) !== u.hash) return alert('Current password is wrong.');
  const pw = prompt('New password (at least 4 characters):');
  if (!pw || pw.length < 4) return;
  const salt = newSalt(), hash = await hashPw(salt, pw);
  const wrap = cloudMode && cloudKey ? await wrapDataKey(cloudKey.key, pw) : undefined;
  const ok = await writeUsers(d => { const x = d.users.find(v => v.username === currentUser.username); if (!x) return false; x.salt = salt; x.hash = hash; if (wrap) x.wrap = wrap; });
  if (ok) showToast('Your password was changed.');
}
async function toggleUploader(username) {
  await writeUsers(d => { const u = d.users.find(x => x.username === username); if (!u) return false; u.uploader = !u.uploader; });
}
async function toggleAdmin(username) {
  await writeUsers(d => { const u = d.users.find(x => x.username === username); if (!u) return false; u.admin = !u.admin; });
}
async function deleteUser(username) {
  if (!confirm(`Delete user "${username}"?`)) return;
  await writeUsers(d => { d.users = d.users.filter(u => u.username !== username); });
}

// ====================================================
// REPORT: Month Comparison (month-end roll-forward)
// Outstanding end of A + new PO issued after A − received = outstanding end of B
// ====================================================
function lastDayISO(yymm) {
  const y = 2000 + parseInt(yymm.slice(0, 2), 10), m = parseInt(yymm.slice(2), 10);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
function firstDayISO(yymm) { return `20${yymm.slice(0, 2)}-${yymm.slice(2)}-01`; }
function daysBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }
function addMonth(yymm, n) {
  let y = 2000 + parseInt(yymm.slice(0, 2), 10), m = parseInt(yymm.slice(2), 10) + n;
  while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; }
  return String(y).slice(2) + String(m).padStart(2, '0');
}
function monthShort(yymm) {
  const names = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${names[parseInt(yymm.slice(2), 10) - 1]} 20${yymm.slice(0, 2)}`;
}

// Received qty per PO line counting only GRNs dated on/before cutIso (same rules as the main matching)
const asOfCache = {};
function allocateAsOf(cutIso) {
  const ck = dataVersion + '|' + cutIso;
  if (asOfCache[ck]) return asOfCache[ck];
  const n = rawPOList.length;
  const got = new Float64Array(n), lastGrn = new Array(n).fill('');
  const index = {};
  rawPOList.forEach(p => { const k = lineKey(p.docNo, p.itemCode); (index[k] = index[k] || []).push(p); });
  rawGRNList.filter(g => g.poNo && g.grnIso && g.grnIso <= cutIso)
    .sort((a, b) => a.grnIso.localeCompare(b.grnIso))
    .forEach(g => {
      const lines = index[lineKey(g.poNo, g.itemCode)];
      if (!lines) return;
      let left = g.qty;
      const desc = up(g.description);
      const score = p => grnLineScore(p, g, desc);
      const ordered = lines.slice().sort((a, b) => score(b) - score(a) || a.id - b.id);
      for (const p of ordered) {
        if (left <= EPS) break;
        const room = p.qty - got[p.id];
        if (room <= EPS) continue;
        const take = Math.min(room, left);
        got[p.id] += take; left -= take; lastGrn[p.id] = g.grnIso;
      }
      if (left > EPS) { got[ordered[0].id] += left; lastGrn[ordered[0].id] = g.grnIso; }
    });
  Object.keys(asOfCache).forEach(k => { if (!k.startsWith(dataVersion + '|')) delete asOfCache[k]; });
  return (asOfCache[ck] = { got, lastGrn });
}

// Every GRN quantity given to each PO line, in date order: [iso, loc, qty, GRN amount]
let allocEvCache = { ver: -1, ev: null };
function allocEvents() {
  if (allocEvCache.ver === dataVersion) return allocEvCache.ev;
  const n = rawPOList.length, got = new Float64Array(n), ev = new Array(n);
  const index = {};
  rawPOList.forEach(p => { const k = lineKey(p.docNo, p.itemCode); (index[k] = index[k] || []).push(p); });
  rawGRNList.filter(g => g.poNo && g.grnIso).sort((a, b) => a.grnIso.localeCompare(b.grnIso)).forEach(g => {
    const lines = index[lineKey(g.poNo, g.itemCode)];
    if (!lines) return;
    let left = g.qty;
    const desc = up(g.description);
    const score = p => grnLineScore(p, g, desc);
    const ordered = lines.slice().sort((a, b) => score(b) - score(a) || a.id - b.id);
    const give = (p, q, over) => { got[p.id] += q; (ev[p.id] = ev[p.id] || []).push([g.grnIso, g.loc, q, Math.abs(g.qty) > EPS ? g.subTotal * q / g.qty : 0, !!over, g]); };
    if (!(left > EPS)) { (ev[ordered[0].id] = ev[ordered[0].id] || []).push([g.grnIso, g.loc, 0, g.subTotal, true, g]); return; }   // no qty (or a return): amount only
    for (const p of ordered) {
      if (left <= EPS) break;
      const take = Math.min(p.qty - got[p.id], left);
      if (take <= EPS) continue;
      give(p, take); left -= take;
    }
    if (left > EPS) give(ordered[0], left, true);
  });
  allocEvCache = { ver: dataVersion, ev };
  return ev;
}

function cmpMonthList() {
  const ms = new Set();
  rawPOList.forEach(p => p.yymm && p.yymm !== '0000' && ms.add(p.yymm));
  rawGRNList.forEach(g => g.grnYYMM && g.grnYYMM !== '0000' && ms.add(g.grnYYMM));
  const sorted = [...ms].sort();
  if (!sorted.length) return [];
  const out = [];
  for (let m = addMonth(sorted[0], -1); m <= sorted[sorted.length - 1]; m = addMonth(m, 1)) out.push(m);
  return out;
}
function populateCmpPickers() {
  const a = document.getElementById('cmpMonthA'), b = document.getElementById('cmpMonthB');
  if (!a || !b) return null;
  const months = cmpMonthList();
  if (a.dataset.ver !== String(dataVersion)) {
    const pa = a.value, pb = b.value;
    const opts = months.slice().reverse().map(m => `<option value="${m}">${monthShort(m)}</option>`).join('');
    a.innerHTML = opts; b.innerHTML = opts;
    const latest = months[months.length - 1];
    b.value = months.includes(pb) ? pb : latest;
    a.value = months.includes(pa) ? pa : addMonth(b.value, -1);
    a.dataset.ver = b.dataset.ver = String(dataVersion);
  }
  if (a.value >= b.value) a.value = addMonth(b.value, -1);
  return { A: a.value, B: b.value, months };
}
function onCmpMonthChange(which) {
  const a = document.getElementById('cmpMonthA'), b = document.getElementById('cmpMonthB');
  if (which === 'B' && a.value >= b.value) a.value = addMonth(b.value, -1);
  if (which === 'A' && a.value >= b.value) b.value = addMonth(a.value, 1);
  renderActiveTab();
}
function ageBucket(d) { return d <= 30 ? 0 : d <= 60 ? 1 : d <= 90 ? 2 : 3; }
const AGE_LABELS = ['0–30 days', '31–60 days', '61–90 days', 'Over 90 days'];

function renderMonthCompare() {
  const wrap = document.getElementById('cmpBody');
  const stats = document.getElementById('cmpStats');
  if (!wrap) return;
  if (!rawPOList.length) { stats.innerHTML = ''; wrap.innerHTML = `<div class="empty-state">${noDataMsg()}</div>`; return; }
  const sel = populateCmpPickers();
  if (!sel) return;
  const { A, B } = sel;
  const endA = lastDayISO(A), endB = lastDayISO(B), startB = firstDayISO(addMonth(A, 1));
  const consecutive = addMonth(A, 1) === B;
  const periodLbl = consecutive ? monthShort(B) : `${monthShort(addMonth(A, 1))} – ${monthShort(B)}`;
  document.querySelectorAll('.cmp-a').forEach(e => e.innerText = monthShort(A));
  document.querySelectorAll('.cmp-b').forEach(e => e.innerText = monthShort(B));
  document.querySelectorAll('.cmp-period').forEach(e => e.innerText = periodLbl);

  const q = getSearchFilter();
  const lines = rawPOList.filter(p => locAllowed(p.loc) && poMatchesSearch(p, q) && p.iso && p.iso <= endB);
  const sA = allocateAsOf(endA), sB = allocateAsOf(endB);

  const bal = balAt;
  const cxIn = p => { const c = cancelOf(p); return c && c.date >= startB && c.date <= endB ? cancelledValue(p) : 0; };

  // ---- bridge per location ----
  const agg = {};
  const G = { open: 0, nw: 0, close: 0, cx: 0, openPO: new Set(), closePO: new Set(), newPO: new Set() };
  lines.forEach(p => {
    const a = agg[p.loc] || (agg[p.loc] = { open: 0, nw: 0, close: 0, cx: 0, openPO: new Set(), closePO: new Set(), newPO: new Set() });
    const bA = bal(p, sA, endA), bB = bal(p, sB, endB);
    const nv = p.iso >= startB ? p.lineSubTotal : 0;
    const cv = cxIn(p);
    [a, G].forEach(t => {
      t.open += bA; t.close += bB; t.nw += nv; t.cx += cv;
      if (bA > 0.005) t.openPO.add(up(p.docNo));
      if (bB > 0.005) t.closePO.add(up(p.docNo));
      if (nv) t.newPO.add(up(p.docNo));
    });
  });
  const codes = Object.keys(agg).sort((a, b) => (a === NO_LOC) - (b === NO_LOC) || a.localeCompare(b));
  const chg = (o, c) => {
    const d = c - o;
    if (Math.abs(d) < 0.005) return '<span class="muted">—</span>';
    return d > 0 ? `<span class="chg-up">▲ ${rm(d)}</span>` : `<span class="chg-down">▼ ${rm(-d)}</span>`;
  };
  const bridgeSheet = [];
  const bridgeRows = codes.map(c => {
    const a = agg[c], recv = a.open + a.nw - a.cx - a.close;
    bridgeSheet.push({ 'Location Code': c || '(blank)', 'Location': locDesc(c), [`Outstanding end ${monthShort(A)}`]: a.open,
      [`New PO ${periodLbl}`]: a.nw, [`Received ${periodLbl}`]: recv, 'Cancelled': a.cx, [`Outstanding end ${monthShort(B)}`]: a.close, 'Change': a.close - a.open,
      [`POs outstanding end ${monthShort(A)}`]: a.openPO.size, [`POs outstanding end ${monthShort(B)}`]: a.closePO.size });
    return `<tr>
      <td><b class="loc-click" data-goto-loc="${esc(c)}">${esc(c || '(No location)')}</b><div class="loc-desc">${esc(c ? locDesc(c) : '')}</div></td>
      <td class="text-right">${rm(a.open)}<div class="muted">${a.openPO.size} POs</div></td>
      <td class="text-right">+ ${rm(a.nw)}<div class="muted">${a.newPO.size} POs</div></td>
      <td class="text-right" style="color:var(--accent-green);">− ${rm(recv)}${a.cx > 0.005 ? `<div class="muted">cancelled − ${rm(a.cx)}</div>` : ''}</td>
      <td class="text-right" style="font-weight:800;color:${a.close > 0.005 ? 'var(--accent-orange)' : '#15803d'};">${rm(a.close)}<div class="muted">${a.closePO.size} POs</div></td>
      <td class="text-right">${chg(a.open, a.close)}</td></tr>`;
  }).join('');
  const gRecv = G.open + G.nw - G.cx - G.close;

  stats.innerHTML = `
    <div class="cmp-stat"><div class="kpi-label">Outstanding end ${monthShort(A)}</div><div class="kpi-value">${rm(G.open)}</div><div class="muted">${G.openPO.size} POs</div></div>
    <div class="cmp-op">+</div>
    <div class="cmp-stat"><div class="kpi-label">New PO ${esc(periodLbl)}</div><div class="kpi-value blue">${rm(G.nw)}</div><div class="muted">${G.newPO.size} POs</div></div>
    <div class="cmp-op">−</div>
    <div class="cmp-stat"><div class="kpi-label">Received (GRN) ${esc(periodLbl)}</div><div class="kpi-value green">${rm(gRecv)}</div>${G.cx > 0.005 ? `<div class="muted">+ cancelled ${rm(G.cx)}</div>` : ''}</div>
    <div class="cmp-op">=</div>
    <div class="cmp-stat cmp-stat-end"><div class="kpi-label">Outstanding end ${monthShort(B)}</div><div class="kpi-value orange">${rm(G.close)}</div><div class="muted">${G.closePO.size} POs · ${chg(G.open, G.close)}</div></div>`;

  // data coverage note
  const poStart = rawPOList.map(p => p.iso).filter(Boolean).sort()[0] || '';
  const coverWarn = poStart > firstDayISO(A);
  const note = `<div class="cmp-note ${coverWarn ? 'note-warn' : 'muted'}">${coverWarn
    ? `⚠ Your PO file starts on ${dateDMY(poStart)}, so "Outstanding end ${monthShort(A)}" only includes POs from that date. Export the PO listing from an earlier date (e.g. 3–6 months back) for a complete opening balance.`
    : `PO data from ${dateDMY(poStart)}. This report ignores the PO/GRN date boxes in the top bar; it uses month-end dates. Location and search filters apply.`}</div>`;

  // ---- detail sections ----
  const byDoc = (arr) => {
    const m = {};
    arr.forEach(p => {
      const k = up(p.docNo);
      const d = m[k] || (m[k] = { docNo: p.docNo, iso: p.iso, docDate: p.docDate, creditorName: p.creditorName, locs: new Set(), val: 0, a: 0, b: 0, last: '', lines: 0 });
      d.locs.add(p.loc); d.val += p.lineSubTotal; d.a += bal(p, sA, endA); d.b += bal(p, sB, endB); d.lines++;
      if (sB.lastGrn[p.id] > d.last) d.last = sB.lastGrn[p.id];
    });
    return Object.values(m);
  };
  const locCell = d => isMultiLocView() ? ' ' + locTag([...d.locs].sort()) : '';

  // 1) Received during the period on POs that were outstanding at end of A
  const recvDocs = byDoc(lines.filter(p => p.iso <= endA && bal(p, sA, endA) - bal(p, sB, endB) - cxIn(p) > 0.005))
    .map(d => Object.assign(d, { got: d.a - d.b })).sort((x, y) => y.got - x.got);
  const recvTot = recvDocs.reduce((s, d) => s + d.got, 0);
  const recvSheet = recvDocs.map(d => withLoc({ 'PO No': d.docNo, 'PO Date': d.docDate, 'Creditor': d.creditorName,
    [`Outstanding end ${monthShort(A)}`]: d.a, 'Received': d.got, [`Outstanding end ${monthShort(B)}`]: d.b,
    'Status': d.b > 0.005 ? 'Partial' : 'Closed', 'Last GRN': dateDMY(d.last), 'Days PO to GRN': d.last ? daysBetween(d.iso, d.last) : '' }, [...d.locs]));
  const recvHtml = recvDocs.map(d => `<tr>
      <td>${poLink(d.docNo)}${locCell(d)}</td><td>${esc(d.docDate)}</td><td><span class="wrap">${esc(d.creditorName)}</span></td>
      <td class="text-right">${rm(d.a)}</td><td class="text-right" style="color:var(--accent-green);font-weight:700;">${rm(d.got)}</td>
      <td>${d.b > 0.005 ? `<span class="status-badge partial">Partial · ${rm(d.b)} left</span>` : '<span class="status-badge done">Closed</span>'}</td>
      <td>${dateDMY(d.last)}</td><td class="text-right">${d.last ? daysBetween(d.iso, d.last) + ' d' : '-'}</td></tr>`).join('');

  // 2) New POs (issued in the period) still outstanding at end of B
  const newDocs = byDoc(lines.filter(p => p.iso >= startB && bal(p, sB, endB) > 0.005)).sort((x, y) => y.b - x.b);
  const newTot = newDocs.reduce((s, d) => s + d.b, 0);
  const newSheet = newDocs.map(d => withLoc({ 'PO No': d.docNo, 'PO Date': d.docDate, 'Creditor': d.creditorName,
    'PO Value (these lines)': d.val, [`Outstanding end ${monthShort(B)}`]: d.b, 'Days waiting': daysBetween(d.iso, endB) }, [...d.locs]));
  const newHtml = newDocs.map(d => `<tr>
      <td>${poLink(d.docNo)}${locCell(d)}</td><td>${esc(d.docDate)}</td><td><span class="wrap">${esc(d.creditorName)}</span></td>
      <td class="text-right">${rm(d.val)}</td><td class="text-right" style="color:var(--accent-orange);font-weight:800;">${rm(d.b)}</td>
      <td class="text-right">${daysBetween(d.iso, endB)} d</td></tr>`).join('');

  // 3) Aging of everything outstanding at end of B
  const outB = lines.filter(p => bal(p, sB, endB) > 0.005);
  const buckets = [0, 1, 2, 3].map(() => ({ val: 0, docs: new Set() }));
  outB.forEach(p => { const b = buckets[ageBucket(daysBetween(p.iso, endB))]; b.val += bal(p, sB, endB); b.docs.add(up(p.docNo)); });
  const oldDocs = byDoc(outB.filter(p => p.iso <= endA)).map(d => Object.assign(d, { age: daysBetween(d.iso, endB) })).sort((x, y) => y.age - x.age || y.b - x.b);
  const oldTot = oldDocs.reduce((s, d) => s + d.b, 0);
  const agingSheet = oldDocs.map(d => withLoc({ 'PO No': d.docNo, 'PO Date': d.docDate, 'Creditor': d.creditorName,
    'Days waiting': d.age, 'Age group': AGE_LABELS[ageBucket(d.age)], [`Outstanding end ${monthShort(A)}`]: d.a, [`Outstanding end ${monthShort(B)}`]: d.b,
    'Last GRN': d.last ? dateDMY(d.last) : 'none' }, [...d.locs]));
  const bucketHtml = `<div class="age-grid">${buckets.map((b, i) => `<div class="age-box age-${i}">
      <div class="kpi-label">${AGE_LABELS[i]}</div><div class="age-val">${rm(b.val)}</div><div class="muted">${b.docs.size} POs</div></div>`).join('')}</div>`;
  const oldHtml = oldDocs.map(d => `<tr>
      <td>${poLink(d.docNo)}${locCell(d)}</td><td>${esc(d.docDate)}</td><td><span class="wrap">${esc(d.creditorName)}</span></td>
      <td class="text-right"><span class="age-pill age-${ageBucket(d.age)}">${d.age} d</span></td>
      <td class="text-right">${rm(d.a)}</td><td class="text-right" style="color:var(--accent-orange);font-weight:800;">${rm(d.b)}</td>
      <td>${d.last ? dateDMY(d.last) : '<span class="muted">no GRN yet</span>'}</td></tr>`).join('');

  // 4) Creditor GRN speed: GRNs dated in the period
  const poById = {};
  rawPOList.forEach(p => { if (!poById[up(p.docNo)]) poById[up(p.docNo)] = p; });
  const cred = {};
  rawGRNList.forEach(g => {
    if (!g.poNo || !g.poIso || g.grnIso < startB || g.grnIso > endB || !locAllowed(g.loc) || !grnMatchesSearch(g, q)) return;
    const k = g.creditorCode || g.creditorName;
    const c = cred[k] || (cred[k] = { code: g.creditorCode, name: g.creditorName, n: 0, days: 0, max: 0, grns: new Set(), late: 0, val: 0 });
    const d = Math.max(0, daysBetween(g.poIso, g.grnIso));
    c.n++; c.days += d; c.max = Math.max(c.max, d); c.grns.add(g.grnNo); c.val += g.subTotal; if (d > 30) c.late++;
  });
  outB.forEach(p => {
    const k = p.creditorCode || p.creditorName;
    const c = cred[k] || (cred[k] = { code: p.creditorCode, name: p.creditorName, n: 0, days: 0, max: 0, grns: new Set(), late: 0, val: 0 });
    c.out = (c.out || 0) + bal(p, sB, endB);
    c.oldest = Math.max(c.oldest || 0, daysBetween(p.iso, endB));
  });
  const credList = Object.values(cred).sort((x, y) => (y.n ? y.days / y.n : -1) - (x.n ? x.days / x.n : -1) || (y.oldest || 0) - (x.oldest || 0));
  const credSheet = credList.map(c => ({ 'Creditor Code': c.code, 'Creditor': c.name, 'GRN lines in period': c.n, 'GRN docs': c.grns.size,
    'Avg days PO to GRN': c.n ? Math.round(c.days / c.n * 10) / 10 : '', 'Slowest (days)': c.n ? c.max : '', 'Lines over 30 days': c.late,
    [`Still outstanding end ${monthShort(B)}`]: c.out || 0, 'Oldest waiting (days)': c.oldest || '' }));
  const credHtml = credList.map(c => {
    const avg = c.n ? c.days / c.n : null;
    return `<tr><td><b>${c.code ? esc(c.code) + ' ' : ''}</b>${esc(c.name)}</td>
      <td class="text-right">${c.n || '-'}</td>
      <td class="text-right">${avg == null ? '-' : `<span class="age-pill age-${ageBucket(avg)}">${avg.toFixed(1)} d</span>`}</td>
      <td class="text-right">${c.n ? c.max + ' d' : '-'}</td>
      <td class="text-right">${c.late || '-'}</td>
      <td class="text-right" style="color:${c.out ? 'var(--accent-orange)' : '#64748b'};font-weight:700;">${c.out ? rm(c.out) : '-'}</td>
      <td class="text-right">${c.oldest ? c.oldest + ' d' : '-'}</td></tr>`;
  }).join('');

  const section = (id, icon, title, sub, total, inner, open) => `
    <details class="cmp-sec" ${open ? 'open' : ''} id="${id}">
      <summary><span class="cmp-sec-title">${icon} ${title}</span><span class="muted">${sub}</span><span class="cmp-sec-total">${total}</span></summary>
      <div class="cmp-sec-body">${inner}</div></details>`;
  const tbl = (head, body, empty) => body ? `<div class="table-container"><table class="audit-table cmp-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>` : `<div class="empty-state" style="padding:16px;">${empty}</div>`;

  wrap.innerHTML = note + `
    <div class="table-container"><table class="audit-table" id="cmpBridgeTable">
      <thead><tr><th>LOCATION</th><th class="text-right">OUTSTANDING END ${monthShort(A)}</th><th class="text-right">+ NEW PO ${esc(periodLbl)}</th>
        <th class="text-right">− RECEIVED ${esc(periodLbl)}</th><th class="text-right">= OUTSTANDING END ${monthShort(B)}</th><th class="text-right">CHANGE</th></tr></thead>
      <tbody>${bridgeRows || '<tr><td colspan="6" class="empty-state">No POs for these filters.</td></tr>'}</tbody>
      <tfoot><tr><td>TOTAL (${codes.length} location${codes.length === 1 ? '' : 's'})</td><td class="text-right">${rm(G.open)}</td><td class="text-right">+ ${rm(G.nw)}</td>
        <td class="text-right" style="color:#4ade80;">− ${rm(gRecv)}</td><td class="text-right" style="color:#fb923c;">${rm(G.close)}</td>
        <td class="text-right">${G.close - G.open > 0.005 ? '▲ ' + rm(G.close - G.open) : G.open - G.close > 0.005 ? '▼ ' + rm(G.open - G.close) : '—'}</td></tr></tfoot>
    </table></div>` +
    section('cmpRecv', '✅', `Received in ${esc(periodLbl)} on older POs`, `POs outstanding at end of ${monthShort(A)} that got GRN`, rm(recvTot),
      tbl('<th>PO</th><th>PO Date</th><th>Creditor</th><th class="text-right">Outstanding end ' + monthShort(A) + '</th><th class="text-right">Received</th><th>Status</th><th>Last GRN</th><th class="text-right">Days to GRN</th>', recvHtml, 'None of the older POs were received in this period.'), true) +
    section('cmpNew', '🆕', `New POs in ${esc(periodLbl)} not received yet`, `issued in the period, still outstanding at end of ${monthShort(B)}`, rm(newTot),
      tbl('<th>PO</th><th>PO Date</th><th>Creditor</th><th class="text-right">PO Value</th><th class="text-right">Outstanding</th><th class="text-right">Waiting</th>', newHtml, 'All new POs in this period have been received. 🎉')) +
    section('cmpAge', '🐢', `Slow GRN — still waiting since ${monthShort(A)} or earlier`, `aging of everything outstanding at end of ${monthShort(B)}`, rm(oldTot),
      bucketHtml + tbl('<th>PO</th><th>PO Date</th><th>Creditor</th><th class="text-right">Waiting</th><th class="text-right">Outstanding end ' + monthShort(A) + '</th><th class="text-right">Outstanding end ' + monthShort(B) + '</th><th>Last GRN</th>', oldHtml, 'Nothing older than this period is still outstanding. 🎉')) +
    section('cmpCred', '🏢', 'Creditor GRN speed', `GRNs dated in ${esc(periodLbl)} · slowest first`, `${credList.filter(c => c.n).length} creditors`,
      tbl('<th>Creditor</th><th class="text-right">GRN lines</th><th class="text-right">Avg days PO→GRN</th><th class="text-right">Slowest</th><th class="text-right">Lines &gt; 30 days</th><th class="text-right">Still outstanding</th><th class="text-right">Oldest waiting</th>', credHtml, 'No GRNs in this period.'));

  exportStore.cmpTable = { summary: bridgeSheet, detail: null, sheets: [
    ['Received', recvSheet], ['New Outstanding', newSheet], ['Slow GRN Aging', agingSheet], ['Creditor Speed', credSheet]] };
}

// print: open every section
window.addEventListener('beforeprint', () => document.querySelectorAll('.cmp-sec').forEach(d => { d.dataset.wasOpen = d.open ? '1' : ''; if (document.body.classList.contains('print-mode-details')) d.open = true; }));
window.addEventListener('afterprint', () => document.querySelectorAll('.cmp-sec').forEach(d => { if (d.dataset.wasOpen !== undefined) d.open = d.dataset.wasOpen === '1'; }));

// ====================================================
// Tiny XLSX writer (no internet / library needed): text, numbers, formulas,
// bold/size/colour, fills, borders, wrap/alignment, number formats, merged
// cells, column widths, freeze panes, A4 print setup.
// ====================================================
function makeXlsx() {
  const sheets = [];
  const styleKeys = [''], styleList = [{}];
  const styleId = st => {
    if (!st) return 0;
    const k = JSON.stringify(st);
    let i = styleKeys.indexOf(k);
    if (i < 0) { i = styleKeys.length; styleKeys.push(k); styleList.push(st); }
    return i;
  };
  const xe = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  const colName = c => { let s = ''; c++; while (c) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };
  const ref = (r, c) => colName(c) + (r + 1);

  function sheet(name, opt = {}) {
    const sh = { name: name.replace(/[\\\/\?\*\[\]:]/g, ' ').slice(0, 31), rows: {}, merges: [], cols: opt.cols || [], heights: {}, freeze: opt.freeze, landscape: !!opt.landscape, printTitles: opt.printTitles };
    sh.cell = (r, c, v, st, f) => { (sh.rows[r] = sh.rows[r] || {})[c] = { v, s: styleId(st), f }; return sh; };
    sh.merge = (r1, c1, r2, c2) => { sh.merges.push(ref(r1, c1) + ':' + ref(r2, c2)); return sh; };
    sh.height = (r, h) => { sh.heights[r] = h; return sh; };
    sh.ref = ref;
    sheets.push(sh);
    return sh;
  }

  function sheetXml(sh) {
    const rowsIdx = Object.keys(sh.rows).map(Number).concat(Object.keys(sh.heights).map(Number));
    const uniq = [...new Set(rowsIdx)].sort((a, b) => a - b);
    let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">';
    x += '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>';
    x += '<sheetViews><sheetView workbookViewId="0">' + (sh.freeze ? `<pane ySplit="${sh.freeze}" topLeftCell="A${sh.freeze + 1}" activePane="bottomLeft" state="frozen"/>` : '') + '</sheetView></sheetViews>';
    x += '<sheetFormatPr defaultRowHeight="15"/>';
    if (sh.cols.length) x += '<cols>' + sh.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>';
    x += '<sheetData>';
    uniq.forEach(r => {
      const cells = sh.rows[r] || {};
      x += `<row r="${r + 1}"${sh.heights[r] ? ` ht="${sh.heights[r]}" customHeight="1"` : ''}>`;
      Object.keys(cells).map(Number).sort((a, b) => a - b).forEach(c => {
        const { v, s, f } = cells[c];
        const a = ref(r, c);
        if (f) x += `<c r="${a}" s="${s}"><f>${xe(f)}</f>${typeof v === 'number' && isFinite(v) ? `<v>${v}</v>` : ''}</c>`;
        else if (v === null || v === undefined || v === '') x += `<c r="${a}" s="${s}"/>`;
        else if (typeof v === 'number' && isFinite(v)) x += `<c r="${a}" s="${s}"><v>${v}</v></c>`;
        else x += `<c r="${a}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xe(v)}</t></is></c>`;
      });
      x += '</row>';
    });
    x += '</sheetData>';
    if (sh.merges.length) x += `<mergeCells count="${sh.merges.length}">` + sh.merges.map(m => `<mergeCell ref="${m}"/>`).join('') + '</mergeCells>';
    x += '<pageMargins left="0.3" right="0.3" top="0.4" bottom="0.4" header="0.2" footer="0.2"/>';
    x += `<pageSetup paperSize="9" orientation="${sh.landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>`;
    x += '</worksheet>';
    return x;
  }

  function stylesXml() {
    const fonts = ['<font><sz val="10"/><name val="Arial"/></font>'], fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'],
      borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'], numFmts = [];
    const idx = (arr, xml) => { let i = arr.indexOf(xml); if (i < 0) { i = arr.length; arr.push(xml); } return i; };
    const xfs = styleList.map(st => {
      const font = `<font>${st.b ? '<b/>' : ''}${st.i ? '<i/>' : ''}${st.u ? '<u/>' : ''}<sz val="${st.sz || 10}"/>${st.color ? `<color rgb="FF${st.color}"/>` : ''}<name val="${st.font || 'Arial'}"/></font>`;
      const fi = idx(fonts, font);
      const fl = st.fill ? idx(fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${st.fill}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
      const bd = st.border ? idx(borders, `<border><left style="${st.border}"><color rgb="FF000000"/></left><right style="${st.border}"><color rgb="FF000000"/></right><top style="${st.border}"><color rgb="FF000000"/></top><bottom style="${st.border}"><color rgb="FF000000"/></bottom><diagonal/></border>`) : 0;
      let nf = 0;
      if (st.num) { const code = st.num; let i = numFmts.indexOf(code); if (i < 0) { i = numFmts.length; numFmts.push(code); } nf = 164 + i; }
      const al = (st.h || st.v || st.wrap) ? `<alignment${st.h ? ` horizontal="${st.h}"` : ''}${st.v ? ` vertical="${st.v}"` : ''}${st.wrap ? ' wrapText="1"' : ''}/>` : '';
      return `<xf numFmtId="${nf}" fontId="${fi}" fillId="${fl}" borderId="${bd}" xfId="0"${nf ? ' applyNumberFormat="1"' : ''}${fi ? ' applyFont="1"' : ''}${fl ? ' applyFill="1"' : ''}${bd ? ' applyBorder="1"' : ''}${al ? ' applyAlignment="1">' + al + '</xf>' : '/>'}`;
    });
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      (numFmts.length ? `<numFmts count="${numFmts.length}">` + numFmts.map((c, i) => `<numFmt numFmtId="${164 + i}" formatCode="${xe(c)}"/>`).join('') + '</numFmts>' : '') +
      `<fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills><borders count="${borders.length}">${borders.join('')}</borders>` +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  }

  function files() {
    const out = [];
    out.push(['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>']);
    out.push(['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>']);
    out.push(['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      sheets.map((s, i) => `<sheet name="${xe(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets>' +
      (sheets.some(s => s.printTitles) ? '<definedNames>' + sheets.map((s, i) => s.printTitles ? `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">'${xe(s.name.replace(/'/g, "''"))}'!$${s.printTitles[0]}:$${s.printTitles[1]}</definedName>` : '').join('') + '</definedNames>' : '') +
      '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>']);
    out.push(['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`]);
    sheets.forEach((s, i) => out.push([`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]));
    out.push(['xl/styles.xml', stylesXml()]);
    return out;
  }

  // ZIP (stored, no compression) + CRC32
  const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function zip() {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    files().forEach(([name, text]) => {
      const nb = enc.encode(name), data = enc.encode(text), crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true);
      lh.setUint32(22, data.length, true); lh.setUint16(26, nb.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), nb, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nb.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), nb);
      offset += 30 + nb.length + data.length;
    });
    const cdSize = central.reduce((s, a) => s + a.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, central.length / 2, true); end.setUint16(10, central.length / 2, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  function download(filename) {
    const blob = zip();
    window.__lastXlsx = blob;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }
  return { sheet, zip, download, ref };
}

// ====================================================
// CANCELLED PO (marked in the portal, saved in the shared data)
// ====================================================
// ---------- creditor of a PO (set by hand when the PO file has no creditor) ----------
function creditorRowHtml(p, cols) {
  const src = { po: 'from PO file', grn: 'from GRN', item: '≈ guessed from the last supplier of this item', manual: 'set by hand', none: 'unknown — no GRN yet' }[p.credSource] || '';
  const o = (store.poCreditors || {})[up(p.docNo)];
  return `<tr class="modal-section cred-row"><td colspan="${cols}">
    <b>Creditor:</b> ${p.creditorCode ? esc(p.creditorCode) + ' · ' : ''}<b><span class="wrap">${esc(p.creditorName)}</span></b>${p.origCreditor ? ` <span class="muted">(was "${esc(p.origCreditor)}" — grouped by a creditor rule)</span>` : ''}
    <span class="muted">(${esc(src)}${o ? ' by ' + esc(o.byName || o.by || '') + ', ' + esc(o.at || '') : ''})</span>
    <span class="cred-edit">
      <input list="credList" id="pcInput" placeholder="Type to find creditor…" style="min-width:260px;">
      <datalist id="credList">${knownCreditors().map(c => `<option value="${esc(c.code ? c.code + ' — ' + c.name : c.name)}"></option>`).join('')}</datalist>
      <button class="btn btn-excel btn-sm" onclick="setPOCreditor('${esc(p.docNo)}')">✎ Change creditor</button>
      ${o ? `<button class="btn btn-ghost btn-sm" onclick="setPOCreditor('${esc(p.docNo)}', true)">↺ Back to automatic</button>` : ''}
    </span></td></tr>`;
}
function knownCreditors() {
  const m = {};
  Object.entries(store.credMaster || {}).forEach(([code, name]) => { m[code + '|' + name] = { code, name }; });
  rawGRNList.forEach(g => { if (g.creditorName) m[(g.creditorCode || '') + '|' + g.creditorName] = { code: g.creditorCode || '', name: g.creditorName }; });
  rawPOList.forEach(p => { if (p.creditorName && p.credSource !== 'none') m[(p.creditorCode || '') + '|' + p.creditorName] = { code: p.creditorCode || '', name: p.creditorName }; });
  return Object.values(m).sort((a, b) => a.name.localeCompare(b.name));
}
function setPOCreditor(docNo, reset) {
  if (!currentUser) return alert('Please log in first.');
  store.poCreditors = store.poCreditors || {};
  const key = up(docNo);
  if (reset) {
    delete store.poCreditors[key];
    logAction(`Creditor of PO ${docNo} back to automatic`, null, 'pocred');
  } else {
    const v = ((document.getElementById('pcInput') || {}).value || '').trim();
    if (!v) return alert('Type or choose a creditor first.');
    const known = knownCreditors().find(c => (c.code ? c.code + ' — ' + c.name : c.name) === v);
    const parts = v.split(' — ');
    const c = known || (parts.length > 1 ? { code: parts[0].trim(), name: parts.slice(1).join(' — ').trim() } : { code: '', name: v });
    store.poCreditors[key] = { code: c.code, name: c.name, by: currentUser.username, byName: currentUser.name, at: nowText() };
    logAction(`Set creditor of PO ${docNo} to ${c.name}`, null, 'pocred');
  }
  pendingLog[pendingLog.length - 1].keys = [key];
  rebuildCombined();
  saveStore();
  renderActiveTab();
  openPODrillDown(docNo);
  showToast('Creditor updated. Click 💾 Save so everyone sees it.');
}

function cancelOf(p) { const c = store.cancels && store.cancels[p.ckey]; return c && c.date ? c : (p.cxImp || null); }
// Cancelled PO lines from AutoCount's "Cancelled Purchase Order Detail Listing" (store.cxLines)
function applyCancelImport() {
  cxUnmatched = [];
  const list = store.cxLines || [];
  if (!list.length) return;
  const idx = {};
  rawPOList.forEach(p => { (idx[lineKey(p.docNo, p.itemCode)] = idx[lineKey(p.docNo, p.itemCode)] || []).push(p); });
  const used = {};
  list.slice().sort((a, b) => (a.iso || '').localeCompare(b.iso || '')).forEach(x => {
    const L = idx[lineKey(x.poNo, x.itemCode)];
    if (!L) { cxUnmatched.push(x); return; }
    const score = p => (up(p.loc) === up(x.loc) ? 4 : 0) + (Math.abs(p.unitCost - x.unitPrice) < 0.005 ? 2 : 0) + (up(p.description) === up(x.description) ? 1 : 0) - (used[p.id] || 0) * 8;
    const p = L.slice().sort((a, b) => score(b) - score(a) || a.id - b.id)[0];
    used[p.id] = (used[p.id] || 0) + 1;
    const prev = p.cxImp;
    p.cxImp = { date: prev && prev.date > x.iso ? prev.date : (x.iso || p.iso), qty: (prev ? prev.qty : 0) + x.qty, amt: (prev ? prev.amt : 0) + x.amt,
      doc: prev ? prev.doc + ', ' + x.doc : x.doc, reason: 'AutoCount ' + (prev ? prev.doc + ', ' + x.doc : x.doc), byName: 'AutoCount', fromFile: true };
  });
}
let cxUnmatched = [];
// value still outstanding at date `cut` (cancelled lines count as 0 from their cancel date)
function balAt(p, s, cut) {
  if (!p.iso || p.iso > cut) return 0;
  const c = cancelOf(p);
  if (c && c.date <= cut) return c.qty ? Math.max(0, p.qty - c.qty - s.got[p.id]) * p.unitCost : 0;
  return Math.max(0, p.qty - s.got[p.id]) * p.unitCost;
}
// value that was cancelled (what was still open on the cancel date)
function cancelledValue(p) {
  const c = cancelOf(p);
  if (!c) return 0;
  const s = allocateAsOf(c.date < p.iso ? p.iso : c.date);
  const open = Math.max(0, p.qty - s.got[p.id]);
  return (c.qty ? Math.min(c.qty, open) : open) * p.unitCost;
}
function todayISO() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }

function cancelUiHtml(poNo, cols) {
  return `<tr class="modal-section cx-bar"><td colspan="${cols}">
    <b>Cancel PO lines:</b> tick the line(s) above, then
    <input type="date" id="cxDate" value="${todayISO()}" title="Cancel date">
    <input type="text" id="cxReason" placeholder="Reason, e.g. supplier no stock" style="min-width:220px;">
    <button class="btn btn-danger btn-sm" onclick="applyCancel('${esc(poNo)}', false)">✖ Mark as cancelled</button>
    <button class="btn btn-settings btn-sm" onclick="applyCancel('${esc(poNo)}', true)">↺ Undo cancel</button>
    <span class="muted"> · cancelled amounts go to the "Cancelled PO" column and leave the outstanding</span></td></tr>`;
}
function applyCancel(poNo, undo) {
  if (!currentUser) return alert('Please log in first.');
  const keys = [...document.querySelectorAll('#docModalTbody .cx:checked')].map(i => i.value);
  if (!keys.length) return alert('Tick the PO line(s) first.');
  const date = (document.getElementById('cxDate') || {}).value || todayISO();
  const reason = ((document.getElementById('cxReason') || {}).value || '').trim();
  store.cancels = store.cancels || {};
  const lines = rawPOList.filter(p => keys.includes(p.ckey));
  if (!undo) {
    const early = lines.find(p => date < p.iso);
    if (early && !confirm(`The cancel date is before the PO date (${early.docDate}). Use the PO date instead?`)) return;
  }
  keys.forEach(k => {
    const p = lines.find(x => x.ckey === k);
    if (undo) delete store.cancels[k];
    else store.cancels[k] = { date: p && date < p.iso ? p.iso : date, reason, by: currentUser.username, byName: currentUser.name, at: nowText() };
  });
  const amt = undo ? 0 : lines.reduce((s, p) => s + cancelledValue(p), 0);
  logAction(undo ? `Undid cancel on PO ${poNo} (${keys.length} line(s))`
    : `Cancelled PO ${poNo}: ${keys.length} line(s), ${rm(amt)}${reason ? ' — ' + reason : ''}`, null, 'cancel');
  pendingLog[pendingLog.length - 1].keys = keys;
  saveStore();
  renderActiveTab();
  openPODrillDown(poNo);
  showToast(undo ? 'Cancel removed. Click 💾 Save to share it.' : 'Marked as cancelled. Click 💾 Save so everyone sees it.');
}

// ====================================================
// REPORT: Summary Different PO VS GRN (follows the MJLD Excel template)
//   Previous PO Bal B/F + Current PO = Total − GRN − Cancelled PO = Current PO C/F
// ====================================================
const MON3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function monApos(yymm, long) { return `${MON3[parseInt(yymm.slice(2), 10) - 1]}'${long ? '20' : ''}${yymm.slice(0, 2)}`; }
function isoShort(iso) { return iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}` : ''; }
function isoMinusDay(iso) { return new Date(Date.parse(iso) - 86400000).toISOString().slice(0, 10); }

let sumMonths = new Set();
function sumMonthsSorted() { return [...sumMonths].sort(); }
function renderSumMonthPick() {
  const box = document.getElementById('sumMonthPick');
  if (!box) return;
  const months = cmpMonthList().slice(1);
  const list = sumMonthsSorted();
  const lbl = !list.length ? 'Choose…' : list.length === 1 ? monApos(list[0], true) : `${monApos(list[0])} – ${monApos(list[list.length - 1])} (${list.length})`;
  const open = box.classList.contains('open');
  const years = {};
  months.forEach(m => { (years['20' + m.slice(0, 2)] = years['20' + m.slice(0, 2)] || []).push(m); });
  box.innerHTML = `<button class="sum-mbtn" onclick="this.parentNode.classList.toggle('open')">📅 ${esc(lbl)} ▾</button>
    <div class="sum-mlist">${Object.keys(years).sort().reverse().map(y => `<div class="sum-myear"><b>${y}</b>${years[y].map(m =>
      `<button class="mchip ${sumMonths.has(m) ? 'on' : ''}" onclick="toggleSumMonth('${m}', event)">${monthShort(m).slice(0, 3)}</button>`).join('')}</div>`).join('')}
      <div class="muted small-text" style="margin-top:6px;">Tick one month, or several months for one combined period. <a href="#" onclick="toggleSumMonth('LATEST', event)">Latest only</a></div></div>`;
  if (open) box.classList.add('open');
}
function toggleSumMonth(m, ev) {
  if (ev) { ev.preventDefault(); ev.stopPropagation(); }
  if (m === 'LATEST') { const ms = cmpMonthList().slice(1); sumMonths = new Set(ms.length ? [ms[ms.length - 1]] : []); }
  else if (sumMonths.has(m)) sumMonths.delete(m); else sumMonths.add(m);
  const r = document.querySelector('input[name="sumMode"][value="month"]'); if (r) r.checked = true;
  const sel = document.getElementById('sumMonth'); if (sel) sel.value = sumMonthsSorted().slice(-1)[0] || '';
  renderActiveTab();
}
document.addEventListener('click', e => {
  const b = document.getElementById('sumMonthPick');
  if (b && b.classList.contains('open') && !b.contains(e.target)) b.classList.remove('open');
});
function populateSumPickers() {
  const sel = document.getElementById('sumMonth');
  if (!sel) return;
  if (sel.dataset.ver !== String(dataVersion)) {
    const prev = sel.value;
    const months = cmpMonthList().slice(1);      // months that have data
    sel.innerHTML = months.slice().reverse().map(m => `<option value="${m}">${monApos(m, true)}</option>`).join('');
    sel.value = months.includes(prev) ? prev : (months[months.length - 1] || '');
    sel.dataset.ver = String(dataVersion);
    [...sumMonths].forEach(m => { if (!months.includes(m)) sumMonths.delete(m); });
    if (!sumMonths.size && sel.value) sumMonths.add(sel.value);
    const f = document.getElementById('sumFrom'), t = document.getElementById('sumTo');
    if (f && !f.value && months.length) {
      const allDates = rawGRNList.map(g => g.grnIso).concat(rawPOList.map(p => p.iso)).filter(Boolean).sort();
      const last = allDates[allDates.length - 1];
      t.value = last;
      const d = new Date(Date.parse(last)); const dow = (d.getUTCDay() + 6) % 7;   // Monday of that week
      f.value = new Date(Date.parse(last) - dow * 86400000).toISOString().slice(0, 10);
    }
  }
}
function getSumPeriod() {
  const mode = (document.querySelector('input[name="sumMode"]:checked') || {}).value || 'month';
  if (mode === 'custom') {
    let s = document.getElementById('sumFrom').value, e = document.getElementById('sumTo').value;
    if (!s || !e) return null;
    if (s > e) [s, e] = [e, s];
    const lbl = `${isoShort(s)} – ${isoShort(e)}`;
    return { start: s, end: e, title: `Summary Different PO VS GRN ${lbl}`, short: lbl, file: `${s}_to_${e}` };
  }
  // months ticked in the picker (old single select still works for scripts: it sets one month)
  const selEl = document.getElementById('sumMonth');
  if (selEl && selEl.value && (!sumMonths.size || (sumMonths.size === 1 && !sumMonths.has(selEl.value) && selEl.dataset.forced !== '1'))) { sumMonths = new Set([selEl.value]); }
  const list = sumMonthsSorted();
  if (!list.length) return null;
  const a = list[0], b = list[list.length - 1];
  if (list.length === 1) return { start: firstDayISO(a), end: lastDayISO(a), title: `Summary Different PO VS GRN ${monApos(a, true)}`, short: monApos(a), file: monApos(a).replace("'", ''), months: list };
  let gap = false;
  for (let m = a; m < b; m = addMonth(m, 1)) if (!sumMonths.has(m)) gap = true;
  const lbl = `${monApos(a)} – ${monApos(b)}`;
  return { start: firstDayISO(a), end: lastDayISO(b), title: `Summary Different PO VS GRN ${lbl}`, short: lbl, file: `${monApos(a).replace("'", '')}-${monApos(b).replace("'", '')}`, months: list, gap };
}

let sumCache = null;
function computeSummary() {
  const per = getSumPeriod();
  if (!per) return null;
  const { start, end } = per;
  const cutBF = isoMinusDay(start);
  const q = getSearchFilter();
  const follow = locFollowsGrn();
  const lines = rawPOList.filter(p => (locAllowed(p.loc) || (follow && p.xfer && Object.keys(p.xfer).some(locAllowed))) && poMatchesSearch(p, q) && p.iso && p.iso <= end);
  const EV = allocEvents();
  const sBF = allocateAsOf(cutBF), sE = allocateAsOf(end);
  const split = (document.getElementById('sumLayout') || {}).value === 'location';
  const hideZero = (document.getElementById('sumHideZero') || {}).checked !== false;

  const blocks = {};
  const cancelsInPeriod = [];
  lines.forEach(p => {
    const bf = balAt(p, sBF, cutBF);
    const nw = p.iso >= start ? p.lineSubTotal : 0;
    const cf = balAt(p, sE, end);
    const c = cancelOf(p);
    const cx = c && c.date >= start && c.date <= end ? cancelledValue(p) : 0;
    const grnPO = bf + nw - cx - cf;                  // PO value used up in the period (at PO price)
    // GRN = the real GRN amount (same as AutoCount); the gap to the PO price is the price difference
    const amtByLoc = {}; let grn = 0;
    (EV[p.id] || []).forEach(([iso, l, qq, amt]) => { if (iso > cutBF && iso <= end) { amtByLoc[l] = (amtByLoc[l] || 0) + amt; grn += amt; } });
    const pd = grn - grnPO;
    if (Math.abs(bf) < 0.005 && Math.abs(nw) < 0.005 && Math.abs(cf) < 0.005 && Math.abs(cx) < 0.005 && Math.abs(grn) < 0.005 && Math.abs(pd) < 0.005) return;
    if (cx && locAllowed(p.loc)) cancelsInPeriod.push({ p, c, cx });
    // how this period's GRN splits over the locations that received it
    let shares = null;
    if (follow && p.xfer && Object.keys(amtByLoc).some(l => l !== p.loc)) shares = amtByLoc;
    const getBlock = l => { const bk = split ? l : '*'; return blocks[bk] || (blocks[bk] = { loc: bk, creds: {}, po: new Set(), keys: new Set(), tot: { bf: 0, nw: 0, grn: 0, cx: 0, cf: 0, xin: 0, xout: 0 } }); };
    const getRow = b => { const ck = p.creditorCode || up(p.creditorName); return b.creds[ck] || (b.creds[ck] = { code: p.creditorCode, name: p.creditorName, bf: 0, nw: 0, grn: 0, cx: 0, cf: 0, xin: 0, xout: 0, docs: {} }); };
    const getDoc = r => r.docs[up(p.docNo)] || (r.docs[up(p.docNo)] = { docNo: p.docNo, docDate: p.docDate, iso: p.iso, locs: new Set(), bf: 0, nw: 0, grn: 0, cx: 0, cf: 0, xin: 0, xout: 0 });
    let grnHere = grn;
    if (shares) {
      grnHere = 0;
      if (Object.keys(shares).length === 0) grnHere = grn;
      Object.keys(shares).forEach(l => {
        const v = shares[l];
        // same table as the PO (own location, or whole-company view with both locations ticked)
        if (l === p.loc || (!split && locAllowed(l) && locAllowed(p.loc))) { grnHere += v; return; }
        if (locAllowed(p.loc)) {
          const b = getBlock(p.loc), r = getRow(b), d = getDoc(r);
          r.xout += v; b.tot.xout += v; d.xout += v; (d.outTo = d.outTo || {})[l] = (d.outTo[l] || 0) + v; r.moved = true;
        }
        if (locAllowed(l)) {
          const b = getBlock(l), r = getRow(b), d = getDoc(r);
          // shown here as Previous PO Bal. B/F and GRN (same amount), so this location's table balances
          r.bf += v; r.grn += v; r.xin += v; b.tot.bf += v; b.tot.grn += v; b.tot.xin += v; d.bf += v; d.grn += v; d.xin += v; d.fromLoc = p.loc; d.locs.add(l);
          b.keys.add(lineKey(p.docNo, p.itemCode) + (split ? '|' + l : '')); r.moved = true;
        }
      });
    }
    if (!locAllowed(p.loc)) return;
    const b = getBlock(p.loc), r = getRow(b), d = getDoc(r);
    r.bf += bf; r.nw += nw; r.grn += grnHere; r.cx += cx; r.cf += cf; r.pd = (r.pd || 0) + pd;
    b.tot.bf += bf; b.tot.nw += nw; b.tot.grn += grnHere; b.tot.cx += cx; b.tot.cf += cf; b.tot.pd = (b.tot.pd || 0) + pd;
    if (nw) b.po.add(up(p.docNo));
    b.keys.add(lineKey(p.docNo, p.itemCode) + (split ? '|' + p.loc : ''));
    d.locs.add(p.loc); d.bf += bf; d.nw += nw; d.grn += grnHere; d.cx += cx; d.cf += cf; d.pd = (d.pd || 0) + pd;
  });
  // GRN not linked to any uploaded PO line (no PO number, or the PO is not uploaded) — taken straight from the GRN
  rawGRNList.forEach(g => {
    if (g.matched || !g.grnIso || g.grnIso < start || g.grnIso > end || !locAllowed(g.loc) || !grnMatchesSearch(g, q)) return;
    const bk = split ? g.loc : '*';
    const b = blocks[bk] || (blocks[bk] = { loc: bk, creds: {}, po: new Set(), keys: new Set(), tot: { bf: 0, nw: 0, grn: 0, cx: 0, cf: 0, xin: 0, xout: 0 } });
    const ck = g.creditorCode || up(g.creditorName);
    const r = b.creds[ck] || (b.creds[ck] = { code: g.creditorCode, name: g.creditorName, bf: 0, nw: 0, grn: 0, cx: 0, cf: 0, xin: 0, xout: 0, docs: {} });
    // No PO at all (e.g. internal company): a purchase of this period -> Current PO + GRN.
    // PO number on the GRN but that PO is not uploaded (older PO) -> Previous PO Bal. B/F + GRN.
    // Either way C/F is unchanged.
    r.np = (r.np || 0) + g.subTotal; b.tot.np = (b.tot.np || 0) + g.subTotal;
    if (g.poNo) { r.bf += g.subTotal; b.tot.bf += g.subTotal; }
    else { r.nw += g.subTotal; b.tot.nw += g.subTotal; r.noPo = (r.noPo || 0) + g.subTotal; b.tot.noPo = (b.tot.noPo || 0) + g.subTotal; }
    r.grn += g.subTotal; b.tot.grn += g.subTotal;
    (b.npDocs = b.npDocs || new Set()).add(g.grnNo);
    r.npGrns = r.npGrns || {};
    const d = r.npGrns[g.grnNo] || (r.npGrns[g.grnNo] = { grnNo: g.grnNo, grnDate: g.grnDate, grnIso: g.grnIso, poNo: g.poNo, locs: new Set(), amt: 0 });
    d.amt += g.subTotal; d.locs.add(g.loc);
  });
  // GRN document count per block (GRNs dated in the period for these PO lines)
  Object.values(blocks).forEach(b => {
    b.tot.np = b.tot.np || 0; b.npCount = b.npDocs ? b.npDocs.size : 0;
    Object.values(b.creds).forEach(r => { r.np = r.np || 0; });
    const g = new Set();
    rawGRNList.forEach(x => {
      if (!x.poNo || x.grnIso < start || x.grnIso > end || !locAllowed(x.loc)) return;
      if (b.keys.has(lineKey(x.poNo, x.itemCode) + (split ? '|' + x.loc : ''))) g.add(x.grnNo);
    });
    if (b.npDocs) b.npDocs.forEach(x => g.add(x));
    b.grnDocs = g.size;
    b.rows = Object.values(b.creds).sort((a, c) => a.name.localeCompare(c.name));
    if (hideZero) b.rows = b.rows.filter(r => [r.bf, r.nw, r.grn, r.cx, r.cf, r.np, r.xout, r.pd || 0].some(v => Math.abs(v) >= 0.005));
  });
  const order = Object.keys(blocks).sort((a, b) => (a === NO_LOC) - (b === NO_LOC) || a.localeCompare(b));
  return (sumCache = { per, cutBF, split, blocks: order.map(k => blocks[k]), cancels: cancelsInPeriod });
}

function sumBlockName(b) {
  if (b.loc === '*') {
    const base = companyDisplay(db.current);
    return locSel ? `${base} — ${[...locSel].sort().map(c => c || 'No location').join(', ')}` : base;
  }
  return b.loc ? `${b.loc} — ${locDesc(b.loc) || b.loc}` : 'No location';
}
// Same look as the Excel "RM" accounting format: RM on the left, amount on the right, "-" for zero
const rmCell = v => `<span class="rmc"><span>RM</span><span>${Math.abs(v) < 0.005 ? '-' : fmt(v)}</span></span>`;
const sumAmt = v => rmCell(v);

function renderPoGrnSummary() {
  const body = document.getElementById('sumBody');
  if (!body) return;
  populateSumPickers();
  const custom = ((document.querySelector('input[name="sumMode"]:checked') || {}).value) === 'custom';
  renderSumMonthPick();
  const mp = document.getElementById('sumMonthPick'); if (mp) mp.classList.toggle('disabled', custom);
  document.getElementById('sumFrom').disabled = !custom;
  document.getElementById('sumTo').disabled = !custom;
  if (!rawPOList.length && !rawGRNList.length) { body.innerHTML = `<div class="empty-state">${noDataMsg()}</div>`; return; }
  const S = computeSummary();
  if (!S) { body.innerHTML = '<div class="empty-state">Choose a month or dates.</div>'; return; }
  const { per, cutBF } = S;

  const poStart = rawPOList.map(p => p.iso).filter(Boolean).sort()[0] || '';
  let html = '';
  if (poStart > isoMinusDay(per.start)) html += `<div class="cmp-note note-warn no-print">⚠ Your PO file starts on ${dateDMY(poStart)}. "Previous PO Bal. B/F" only includes POs from that date — export the PO listing from further back for a complete B/F.</div>`;
  { const sm = k => S.blocks.reduce((s, b) => s + (b.tot[k] || 0), 0);
    const nw = sm('nw'), noPo = sm('noPo'), oldPo = sm('np') - noPo;
    if (noPo > 0.005 || oldPo > 0.005) html += `<div class="cmp-note no-print">ℹ ${noPo > 0.005 ? `"Current PO" = PO listing <b>${rm(nw - noPo)}</b> + GRN without PO no. <b>${rm(noPo)}</b> (e.g. internal / direct GRN).` : ''}
      ${oldPo > 0.005 ? ` "Previous PO Bal. B/F" includes <b>${rm(oldPo)}</b> GRN for older POs not uploaded.` : ''}</div>`; }
  if (per.gap) html += `<div class="cmp-note no-print">ℹ The months you ticked are not next to each other — the table covers the whole period ${dateDMY(per.start)} – ${dateDMY(per.end)}.</div>`;
  if (!S.blocks.length) html += '<div class="empty-state">No PO movement in this period for these filters.</div>';

  S.blocks.forEach((b, bi) => {
    const t = b.tot;
    const rows = b.rows.map((r, i) => {
      const id = `sumSub_${bi}_${i}`;
      const docs = Object.values(r.docs).sort((a, c) => a.iso.localeCompare(c.iso));
      const sub = docs.map(d => `<tr>
          <td>${poLink(d.docNo)}${isMultiLocView() && !S.split ? locTag([...d.locs].sort()) : ''}${d.fromLoc && d.xin ? ` <span class="gk gk-mixed" title="PO raised at ${esc(d.fromLoc)} — the GRN received here is shown in B/F and GRN">PO at ${esc(d.fromLoc)} · GRN here</span>` : ''}${Math.abs(d.pd || 0) >= 0.005 ? ` <span class="gk gk-mixed" title="GRN amount ${(d.pd > 0 ? 'higher' : 'lower')} than the PO price (price or extra quantity)">price diff ${d.pd > 0 ? '+' : '−'}${fmt(Math.abs(d.pd))}</span>` : ''}${d.outTo ? ` <span class="gk gk-oldpo" title="GRN of this PO received at other locations (shown in their tables)">↪ ${esc(Object.keys(d.outTo).sort().map(l => `${l}: ${fmt(d.outTo[l])}`).join(', '))}</span>` : ''}</td><td class="nw">${esc(d.docDate)}</td>
          <td class="text-right">${sumAmt(d.bf)}</td><td class="text-right">${sumAmt(d.nw)}</td><td class="text-right">${sumAmt(d.bf + d.nw)}</td>
          <td class="text-right">${sumAmt(d.grn)}</td><td class="text-right">${sumAmt(d.cx)}</td>
          <td class="text-right" style="font-weight:700;${d.cf > 0.005 ? 'color:var(--accent-orange);' : ''}">${sumAmt(d.cf)}</td></tr>`).join('');
      const npList = Object.values(r.npGrns || {}).sort((a, c) => a.grnIso.localeCompare(c.grnIso));
      const npSub = npList.length ? `<table class="sub-item-table" style="margin-top:6px;"><thead><tr><th>GRN without PO / PO not uploaded</th><th>GRN Date</th><th>PO No. on GRN</th><th>Shown in</th><th class="text-right">Amount (RM)</th></tr></thead><tbody>` +
        npList.map(d => `<tr><td><b>${esc(d.grnNo)}</b>${isMultiLocView() && !S.split ? locTag([...d.locs].sort()) : ''}</td><td>${esc(d.grnDate)}</td><td>${d.poNo ? esc(d.poNo) + ' <span class="gk gk-oldpo">not uploaded</span>' : '<span class="gk gk-nopo">No PO</span>'}</td><td>${d.poNo ? 'B/F + GRN' : 'Current PO + GRN'}</td><td class="text-right">${rmCell(d.amt)}</td></tr>`).join('') + '</tbody></table>' : '';
      return `<tr class="sum-row">
          <td class="text-center">${i + 1}</td>
          <td><span class="arrow-toggle" data-toggle="${id}">▶</span> <span class="wrap">${esc(r.name)}</span>${r.moved ? ' <span class="gk gk-mixed no-print" title="Has PO received at another location — open ▶">↪</span>' : ''}</td>
          <td class="text-center sum-code">${esc(r.code || '')}</td>
          <td class="text-right">${sumAmt(r.bf)}</td><td class="text-right">${sumAmt(r.nw)}</td>
          <td class="text-right">${sumAmt(r.bf + r.nw)}</td><td class="text-right">${sumAmt(r.grn)}</td>
          <td class="text-right">${sumAmt(r.cx)}</td>
          <td class="text-right sum-cf${r.cf > 0.005 ? ' has-bal' : ''}">${sumAmt(r.cf)}</td></tr>
        <tr id="${id}" class="detail-subrow"><td></td><td colspan="8" class="detail-subrow-cell">
          <table class="sub-item-table"><thead><tr><th>PO No.</th><th>PO Date</th><th class="text-right">B/F</th><th class="text-right">Current PO</th>
            <th class="text-right">Total</th><th class="text-right">GRN</th><th class="text-right">Cancelled</th><th class="text-right">C/F</th></tr></thead>
          <tbody>${sub || '<tr><td colspan="8" class="muted">No PO lines.</td></tr>'}</tbody></table>${npSub}</td></tr>`;
    }).join('');
    const xin = t.xin || 0, xout = t.xout || 0;
    const pdT = t.pd || 0;
    const check = Math.abs(t.bf + t.nw - t.grn - xout + pdT - t.cx - t.cf) < 0.05;
    html += `<div class="sum-block${bi ? ' sum-break' : ''}">
      <div class="sum-title">${esc(per.title)}</div>
      <div class="sum-sub">${esc(sumBlockName(b))}</div>
      <div class="table-container"><table class="sum-table">
        <thead>
          <tr class="sum-head"><th class="sum-bil"></th><th></th><th></th>
            <th>Previous PO Bal.<br>B/F ${isoShort(cutBF)}</th>
            <th>Current PO<br>${esc(per.short)}<br>(Qty:${b.po.size})</th>
            <th>Total<br>(RM)</th>
            <th>GRN<br>${esc(per.short)}<br>(Qty:${b.grnDocs})</th>
            <th>Cancelled<br>PO</th>
            <th>Current PO C/F<br>${esc(per.short)}</th></tr>
          <tr class="sum-tot"><td></td><td class="text-right">TOTAL</td><td></td>
            <td class="text-right">${rmCell(t.bf)}</td><td class="text-right">${rmCell(t.nw)}</td><td class="text-right">${rmCell(t.bf + t.nw)}</td>
            <td class="text-right">${rmCell(t.grn)}</td><td class="text-right">${rmCell(t.cx)}</td><td class="text-right">${rmCell(t.cf)}</td></tr>
          <tr class="sum-amt"><th>Bil</th><th>Description</th><th>Creditor<br>Code</th><th>Amount<br>(RM)</th><th>Amount<br>(RM)</th><th>Amount<br>(RM)</th><th>Amount<br>(RM)</th><th>Amount<br>(RM)</th><th>Amount<br>(RM)</th></tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="9" class="empty-state">No creditors.</td></tr>'}</tbody>
      </table></div>
      <div class="sum-check ${check ? '' : 'note-warn'}">${check ? '✓' : '⚠'} Check: B/F ${rm(t.bf)} + Current PO ${rm(t.nw)} − GRN ${rm(t.grn)}${xout > 0.005 ? ` − GRN of this location's PO received elsewhere ${rm(xout)}` : ''}${Math.abs(pdT) >= 0.005 ? ` ${pdT > 0 ? '+' : '−'} price difference GRN vs PO ${rm(Math.abs(pdT))}` : ''} − Cancelled ${rm(t.cx)} = C/F ${rm(t.cf)} · ${b.rows.length} creditors${xin > 0.005 ? `<div class="muted small-text">Includes ${rm(xin)} GRN received here for POs raised at other locations — counted in both B/F and GRN.</div>` : ''}</div>
    </div>`;
  });

  if (S.cancels.length) {
    html += `<div class="sum-block sum-cancels"><div class="sum-sub">Cancelled PO in this period</div>
      <table class="audit-table cmp-table"><thead><tr><th>PO No.</th><th>Creditor</th><th>Item</th><th>Cancel Date</th><th>Reason</th><th>By</th><th class="text-right">Amount (RM)</th></tr></thead><tbody>` +
      S.cancels.map(({ p, c, cx }) => `<tr><td>${poLink(p.docNo)}${locTag(p.loc)}</td><td><span class="wrap">${esc(p.creditorName)}</span></td><td>${esc(p.itemCode)} <span class="wrap">${esc(p.description)}</span></td>
        <td>${dateDMY(c.date)}</td><td>${esc(c.reason || '')}</td><td>${esc(c.byName || c.by || '')}</td><td class="text-right">${rmCell(cx)}</td></tr>`).join('') +
      '</tbody></table></div>';
  }
  html += `<p class="muted no-print" style="margin-top:12px;font-size:0.8rem;">How it works: B/F = PO balance not yet received at ${isoShort(cutBF)}. Current PO = POs dated in the period. GRN = value received in the period against PO lines (at PO price). GRNs with <b>no PO number</b> (e.g. internal company) are added to <b>Current PO and GRN</b> of the month they were received; GRNs whose PO is <b>not uploaded</b> (older PO) are added to <b>B/F and GRN</b>. Both use the GRN amount, so C/F is not affected. Cancelled PO = lines marked as cancelled in the portal (open a PO → tick lines → Mark as cancelled). C/F = balance still not received at ${isoShort(per.end)}. Next period's B/F always equals this C/F. Location filter and search in the top bar apply.</p>`;
  body.innerHTML = html;
}

// ---------- Excel in the same layout as the user's template (SUMMARY_DIFFERENT_PO_VS_GRN_MJLD.xlsx) ----------
function companyInitials(name) {
  return String(name || '').replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 6);
}
function exportSummaryXlsx() {
  const S = computeSummary();
  if (!S || !S.blocks.length) return alert('Nothing to export for this period.');
  const X = makeXlsx();
  const RM = '_-"RM"* #,##0.00_-;\\-"RM"* #,##0.00_-;_-"RM"* "-"??_-;_-@_-';
  const F = { font: 'Cambria', sz: 14 };
  const st = {
    title: Object.assign({}, F, { b: true, h: 'center', v: 'center' }),
    head: Object.assign({}, F, { b: true, h: 'center', v: 'center', wrap: true, border: 'thin' }),
    tot: Object.assign({}, F, { b: true, h: 'center', v: 'center', border: 'thin', num: RM }),
    amtHead: Object.assign({}, F, { b: true, h: 'center', v: 'center', wrap: true, border: 'thin' }),
    bilHead: Object.assign({}, F, { b: true, h: 'center', v: 'center', border: 'thin' }),
    descHead: Object.assign({}, F, { b: true, h: 'left', v: 'center', wrap: true, border: 'thin' }),
    bil: Object.assign({}, F, { h: 'center', v: 'center', border: 'thin' }),
    desc: Object.assign({}, F, { h: 'left', v: 'center', wrap: true, border: 'thin' }),
    code: Object.assign({}, F, { sz: 11, h: 'center', v: 'center', wrap: true, border: 'thin' }),
    num: Object.assign({}, F, { h: 'center', v: 'center', border: 'thin', num: RM }),
    note: { font: 'Aptos Narrow', sz: 11, v: 'center', wrap: true, color: '595959' }
  };
  // A Bil | B Description | C Code | D B/F | E | F Current PO | G | H Total | I | J GRN | K | L Cancelled | M | N C/F | O Outstanding PO
  const A = 0, B = 1, Cc = 2, D = 3, Fc = 5, H = 7, J = 9, L = 11, N = 13, O = 14;
  const co = companyDisplay(db.current);
  const sheetName = (S.per.file.length <= 6 ? S.per.file.toUpperCase() : S.per.file.slice(0, 20)) + companyInitials(co);
  const sh = X.sheet(sheetName, { cols: [5.6, 30, 13, 24.7, 1.1, 24.7, 1.6, 24.7, 1.5, 24.7, 1.5, 18.2, 1.5, 20.5, 40], freeze: S.blocks.length === 1 ? 6 : 0 });
  const C = (rr, cc) => X.ref(rr, cc);
  const r2 = v => Math.round(v * 100) / 100;
  let r = 0;
  S.blocks.forEach(b => {
    const t = b.tot;
    // rows 1-2: title + company / location (merged A:N)
    sh.cell(r, A, S.per.title, st.title); sh.merge(r, A, r, N); sh.height(r, 17.4); r++;
    sh.cell(r, A, b.loc === '*' ? sumBlockName(b) : sumBlockName(b), st.title); sh.merge(r, A, r, N); sh.height(r, 17.4); r++;
    // row 3: headers
    const hdr = r;
    [[D, `Previous PO Bal. \nB/F ${isoShort(S.cutBF)}`], [Fc, `Current PO \n(Qty:${b.po.size})`], [H, 'Total \n(RM)'],
     [J, `Grn \n(Qty:${b.grnDocs})`], [L, 'Cancelled po'], [N, 'Current PO C/F ']].forEach(([c, txt]) => sh.cell(hdr, c, txt, st.head));
    sh.height(hdr, 34.8); r++;
    // row 4: totals
    const totRow = r, first = r + 3, last = r + 2 + b.rows.length;
    [[D, t.bf], [Fc, t.nw], [H, t.bf + t.nw], [J, t.grn], [L, t.cx], [N, t.cf]].forEach(([c, v]) =>
      sh.cell(totRow, c, r2(v), st.tot, b.rows.length ? `SUM(${C(first, c)}:${C(last, c)})` : null));
    sh.height(totRow, 17.4); r++;
    // row 5: blank
    r++;
    // row 6: Bil | Description | Code | Amount (RM)
    sh.cell(r, A, 'Bil', st.bilHead); sh.cell(r, B, 'Description ', st.descHead); sh.cell(r, Cc, 'Creditor\nCode', st.amtHead);
    [D, Fc, H, J, L, N].forEach(c => sh.cell(r, c, 'Amount \n(RM)', st.amtHead));
    sh.height(r, 34); r++;
    // data rows
    b.rows.forEach((row, i) => {
      const rr = r;
      sh.cell(rr, A, i + 1, st.bil);
      sh.cell(rr, B, row.name, st.desc);
      sh.cell(rr, Cc, row.code || '', st.code);
      sh.cell(rr, D, r2(row.bf), st.num);
      sh.cell(rr, Fc, r2(row.nw), st.num);
      sh.cell(rr, H, r2(row.bf + row.nw), st.num, `${C(rr, D)}+${C(rr, Fc)}`);
      sh.cell(rr, J, r2(row.grn), st.num);
      sh.cell(rr, L, r2(row.cx), st.num);
      const adj = r2(-(row.xout || 0) + (row.pd || 0));
      sh.cell(rr, N, r2(row.cf), st.num, `${C(rr, H)}-${C(rr, J)}-${C(rr, L)}` + (Math.abs(adj) >= 0.005 ? (adj > 0 ? '+' : '-') + Math.abs(adj).toFixed(2) : ''));
      const outPOs = Object.values(row.docs).filter(d => d.cf > 0.005).map(d => d.docNo);
      const notes = [];
      if (outPOs.length) notes.push(outPOs.slice(0, 6).join(', ') + (outPOs.length > 6 ? ` (+${outPOs.length - 6} more)` : ''));
      if ((row.xin || 0) > 0.005) notes.push(`B/F & GRN include PO from other location: ${fmt(row.xin)} (${Object.values(row.docs).filter(d => d.xin).map(d => d.docNo + ' @' + d.fromLoc).slice(0, 4).join(', ')})`);
      if ((row.xout || 0) > 0.005) notes.push(`GRN received at other location: ${fmt(row.xout)}`);
      if (Math.abs(row.pd || 0) >= 0.005) notes.push(`Price difference GRN vs PO: ${row.pd > 0 ? '+' : '-'}${fmt(Math.abs(row.pd))}`);
      if (notes.length) sh.cell(rr, O, notes.join(' · '), st.note);
      sh.height(rr, 45);
      r++;
    });
    r += 3;
  });

  // Sheet 2: every outstanding PO at the end of the period
  st.head = { b: true, h: 'center', v: 'center', wrap: true, border: 'thin', fill: 'D9E1F2' };
  st.cell = { border: 'thin' }; st.cellC = { border: 'thin', h: 'center' }; st.num = { border: 'thin', num: '#,##0.00' };
  const d2 = X.sheet('Outstanding PO C-F', { cols: [16, 12, 12, 38, 40, 14, 16, 12], freeze: 1 });
  ['PO No.', 'PO Date', 'Location', 'Creditor', 'Item', 'PO Qty', 'C/F Amount (RM)', 'Days waiting'].forEach((h, i) => d2.cell(0, i, h, st.head));
  const sE = allocateAsOf(S.per.end);
  const q = getSearchFilter();
  let rr = 1;
  rawPOList.filter(p => locAllowed(p.loc) && poMatchesSearch(p, q) && balAt(p, sE, S.per.end) > 0.005)
    .sort((a, b) => a.creditorName.localeCompare(b.creditorName) || a.iso.localeCompare(b.iso))
    .forEach(p => {
      [p.docNo, p.docDate, p.loc, p.creditorName, `${p.itemCode} ${p.description}`].forEach((v, i) => d2.cell(rr, i, v, st.cell));
      d2.cell(rr, 5, p.qty, st.cell);
      d2.cell(rr, 6, Math.round(balAt(p, sE, S.per.end) * 100) / 100, st.num);
      d2.cell(rr, 7, daysBetween(p.iso, S.per.end), st.cellC);
      rr++;
    });
  // Sheet 3: cancelled in the period
  if (S.cancels.length) {
    const d3 = X.sheet('Cancelled PO', { cols: [16, 38, 40, 12, 30, 14, 16], freeze: 1 });
    ['PO No.', 'Creditor', 'Item', 'Cancel Date', 'Reason', 'By', 'Amount (RM)'].forEach((h, i) => d3.cell(0, i, h, st.head));
    S.cancels.forEach(({ p, c, cx }, i) => {
      [p.docNo, p.creditorName, `${p.itemCode} ${p.description}`, dateDMY(c.date), c.reason || '', c.byName || c.by || ''].forEach((v, j) => d3.cell(i + 1, j, v, st.cell));
      d3.cell(i + 1, 6, Math.round(cx * 100) / 100, st.num);
    });
  }
  const coFile = co.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 25);
  const loc = locSel ? '_' + (locSel.size === 1 ? [...locSel][0] : locSel.size + 'loc') : '';
  X.download(`Summary_PO_vs_GRN_${coFile}${loc}_${S.per.file}.xlsx`);
}





// ====================================================
// Shared month picker (same look as Summary PO vs GRN): drop-down by year, tick several
// ====================================================
const monthPicks = {};          // boxId -> Set of yymm
function renderMonthPicker(boxId, months, fnName) {
  const box = document.getElementById(boxId);
  if (!box) return [];
  const set = monthPicks[boxId] || (monthPicks[boxId] = new Set());
  [...set].forEach(m => { if (!months.includes(m)) set.delete(m); });
  if (!set.size && months.length) set.add(months[months.length - 1]);      // default: latest month
  const list = [...set].sort();
  const lbl = !list.length ? 'Choose…' : list.length === 1 ? monApos(list[0], true) : `${monApos(list[0])} – ${monApos(list[list.length - 1])} (${list.length})`;
  const open = box.classList.contains('open');
  const years = {};
  months.forEach(m => { (years['20' + m.slice(0, 2)] = years['20' + m.slice(0, 2)] || []).push(m); });
  box.innerHTML = `<button class="sum-mbtn" onclick="this.parentNode.classList.toggle('open')">📅 ${esc(lbl)} ▾</button>
    <div class="sum-mlist">${Object.keys(years).sort().reverse().map(y => `<div class="sum-myear"><b>${y}</b>${years[y].map(m =>
      `<button class="mchip ${set.has(m) ? 'on' : ''}" onclick="${fnName}('${boxId}','${m}', event)">${monthShort(m).slice(0, 3)}</button>`).join('')}</div>`).join('')}
      <div class="muted small-text" style="margin-top:6px;">Tick one or several months. <a href="#" onclick="${fnName}('${boxId}','LATEST', event)">Latest only</a> · <a href="#" onclick="${fnName}('${boxId}','ALL', event)">All months</a></div></div>`;
  if (open) box.classList.add('open');
  return list;
}
function toggleMonthPick(boxId, m, ev) {
  if (ev) { ev.preventDefault(); ev.stopPropagation(); }
  const set = monthPicks[boxId] || (monthPicks[boxId] = new Set());
  if (m === 'LATEST') set.clear();
  else if (m === 'ALL') { set.clear(); (monthPicks[boxId + ':all'] || []).forEach(x => set.add(x)); }
  else if (set.has(m)) set.delete(m); else set.add(m);
  renderActiveTab();
}
document.addEventListener('click', e => {
  document.querySelectorAll('.sum-mpick.open').forEach(b => { if (!b.contains(e.target)) b.classList.remove('open'); });
});

// ====================================================
// Folder view helpers (closed by default, contents built when opened)
// ====================================================
let folderRender = {};          // id -> () => html (built the first time the folder is opened)
let folderSeq = 0;
function folderHtml(cls, title, stats, inner, lazy) {
  const id = 'fd' + (++folderSeq);
  if (lazy) folderRender[id] = inner;
  return `<details class="fold ${cls}" id="${id}"${lazy ? ' data-lazy="1"' : ''}><summary><span class="fold-arrow">▶</span><span class="fold-title">${title}</span><span class="fold-stats">${stats}</span></summary>
    <div class="fold-body">${lazy ? '' : inner}</div></details>`;
}
document.addEventListener('toggle', e => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.open || d.dataset.lazy !== '1') return;
  const f = folderRender[d.id];
  if (f) { d.querySelector('.fold-body').innerHTML = f(); d.dataset.lazy = '0'; }
}, true);
function poOpenAll(tabId, open) {
  const root = document.getElementById(tabId);
  if (!root) return;
  // open level by level so lazy folders build their children first
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    root.querySelectorAll('details.fold').forEach(d => {
      if (d.open !== open) {
        if (open && d.dataset.lazy === '1' && folderRender[d.id]) { d.querySelector('.fold-body').innerHTML = folderRender[d.id](); d.dataset.lazy = '0'; }
        d.open = open; changed = true;
      }
    });
    if (!changed || !open) break;
  }
}
function printFolders(tabId, details) {
  const root = document.getElementById(tabId);
  const was = [...root.querySelectorAll('details.fold')].map(d => d.open);
  if (details) poOpenAll(tabId, true);
  else root.querySelectorAll('details.fold').forEach(d => { d.open = !d.classList.contains('fold-leaf') && !d.classList.contains('fold-doc'); });
  triggerPrint(details ? 'details' : 'simple');
  setTimeout(() => { if (!details) root.querySelectorAll('details.fold').forEach((d, i) => { d.open = !!was[i]; }); }, 1500);
}
const foldStats = (n, unit, amt, cls) => `<span class="fs-n">${n} ${unit}</span><span class="fs-amt ${cls || ''}">${rm(amt)}</span>`;

// ====================================================
// REPORT: PO Outstanding — only POs NOT fully received, as at the end of each chosen month
// ====================================================
function poMonthsWithData() {
  const ms = new Set();
  rawPOList.forEach(p => { if (p.yymm && p.yymm !== '0000') ms.add(p.yymm); });
  const sorted = [...ms].sort();
  const end = isoToYYMM(asAtDate() > '2090' ? todayISO() : asAtDate());
  return sorted.filter(m => m <= end);
}
function renderPOOutstanding() {
  const body = document.getElementById('poOutBody');
  if (!body) return;
  folderRender = {}; folderSeq = 0;
  if (!hasScopedData()) { updateKPIs([]); body.innerHTML = `<div class="empty-state">${noDataMsg()}</div>`; return; }
  const all = poMonthsWithData();
  monthPicks['poOutPick:all'] = all;
  const months = renderMonthPicker('poOutPick', all, 'toggleMonthPick');
  const grp = (document.getElementById('poOutGroup') || {}).value || 'po';
  const q = getSearchFilter(), from = fromDate();
  const base = rawPOList.filter(p => locAllowed(p.loc) && poMatchesSearch(p, q) && p.iso && p.iso >= from);
  const exp = [], expDetail = [];
  let html = '', kpiLines = [];
  months.slice().reverse().forEach((m, mi) => {
    const asAt = asAtDate(), end = lastDayISO(m) < asAt ? lastDayISO(m) : asAt, s = allocateAsOf(end);
    const rows = [];
    base.forEach(p => {
      if (p.iso > end) return;
      const bal = balAt(p, s, end);
      if (Math.abs(bal) <= 0.005) return;             // negative lines (discounts) stay with their PO
      const recv = Math.min(s.got[p.id], p.qty);
      rows.push({ p, bal, recvQ: recv, balQ: p.qty < 0 ? p.qty : Math.max(0, p.qty - s.got[p.id]), st: recv > EPS ? 'partial' : 'none', here: p.yymm === m });
    });
    if (mi === 0) kpiLines = rows.map(r => r.p);
    const tot = rows.reduce((a, r) => a + r.bal, 0), docs = new Set(rows.map(r => up(r.p.docNo))).size;
    const part = st => {
      const R = rows.filter(r => r.st === st);
      const sub = here => {
        const L = R.filter(r => r.here === here);
        L.forEach(r => {
          exp.push(withLoc({ 'As at': monApos(m, true), Status: st === 'partial' ? 'Partly received' : 'Not received', 'PO issued': here ? 'This month' : 'Earlier month', 'PO No': r.p.docNo, 'PO Date': r.p.docDate,
            'Creditor Code': r.p.creditorCode, 'Creditor Name': r.p.creditorName, 'Item Code': r.p.itemCode, Description: r.p.description, 'PO Qty': r.p.qty, 'Received Qty': r.recvQ, 'Bal Qty': r.balQ,
            'PO Value': Math.round(r.p.lineSubTotal * 100) / 100, Outstanding: Math.round(r.bal * 100) / 100 }, r.p.loc));
        });
        const amt = L.reduce((a, r) => a + r.bal, 0), n = new Set(L.map(r => up(r.p.docNo))).size;
        const title = here ? `📁 POs issued this month (${monApos(m)})` : '📁 POs from earlier months';
        return L.length ? folderHtml('fold-leaf', title, foldStats(n, 'POs', amt, 'out'), () => outLeafHtml(L, grp, m), true) : '';
      };
      const amt = R.reduce((a, r) => a + r.bal, 0), n = new Set(R.map(r => up(r.p.docNo))).size;
      const title = st === 'partial' ? '📂 Partly received' : '📂 Not received at all';
      return R.length ? folderHtml(`fold-status st-${st}`, title, foldStats(n, 'POs', amt, 'out'), sub(true) + sub(false), false) : '';
    };
    const inner = rows.length ? part('partial') + part('none') : '<div class="empty-state">Everything received — nothing outstanding. 🎉</div>';
    html += folderHtml('fold-month', `<b>${end === lastDayISO(m) ? `As at end of ${monApos(m, true).toUpperCase()}` : `${monApos(m, true).toUpperCase()} — as at ${dateDMY(end)}`}</b>`, foldStats(docs, 'POs', tot, 'out'), inner, false);
  });
  body.innerHTML = html || '<div class="empty-state">Choose a month.</div>';
  // with one month the month folder starts open (status folders stay closed)
  if (months.length === 1) { const d = body.querySelector('details.fold-month'); if (d) d.open = true; }
  updateKPIs(kpiLines);
  exportStore.poOutTable = { summary: exp, detail: null };
}
function outLeafHtml(L, grp, m) {
  const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
  const lineRow = (r, show) => `<tr><td>${show === 'item' ? `${poLink(r.p.docNo, r.p.loc)}${locTag(r.p.loc)}` : `<b>${esc(r.p.itemCode)}</b>`}</td><td>${show === 'item' ? esc(r.p.docDate) : esc(r.p.description)}</td>
    ${show === 'item' ? `<td><span class="wrap">${esc(r.p.creditorName)}</span></td>` : ''}<td class="text-right">${qtyFmt(r.p.qty)}</td><td class="text-right" style="color:var(--accent-green);">${qtyFmt(r.recvQ)}</td>
    <td class="text-right">${qtyFmt(r.balQ)}</td><td class="text-right" style="color:var(--accent-orange);font-weight:700;">${rm(r.bal)}</td></tr>`;
  const groups = {};
  const keyOf = grp === 'item' ? r => up(r.p.itemCode) : grp === 'cred' ? r => r.p.creditorCode || up(r.p.creditorName) : r => up(r.p.docNo) + '|' + r.p.loc;
  L.forEach(r => { (groups[keyOf(r)] = groups[keyOf(r)] || []).push(r); });
  const keys = Object.keys(groups).sort((a, b) => grp === 'po' ? groups[a][0].p.iso.localeCompare(groups[b][0].p.iso) || a.localeCompare(b) : sum(groups[b], r => r.bal) - sum(groups[a], r => r.bal));
  return keys.map(k => {
    const G = groups[k], f = G[0].p, bal = sum(G, r => r.bal);
    let title, sub;
    if (grp === 'po') {
      title = `${poLink(f.docNo, f.loc)}${locTag(f.loc)} <span class="muted">${esc(f.docDate)}</span> · <span class="wrap">${esc(f.creditorName)}</span> <span class="muted small-text">${G.length} line${G.length > 1 ? 's' : ''}</span>`;
      sub = `<table class="sub-item-table"><thead><tr><th>Item</th><th>Description</th><th class="text-right">PO Qty</th><th class="text-right">Received</th><th class="text-right">Bal Qty</th><th class="text-right">Outstanding (RM)</th></tr></thead><tbody>${G.map(r => lineRow(r, 'po')).join('')}</tbody></table>`;
    } else {
      const pos = new Set(G.map(r => up(r.p.docNo))).size;
      title = grp === 'item' ? `<b>${esc(f.itemCode)}</b> <span class="wrap">${esc(f.description)}</span> <span class="muted small-text">${pos} PO${pos > 1 ? 's' : ''} · bal qty ${qtyFmt(sum(G, r => r.balQ))}</span>`
        : `<b><span class="wrap">${esc(f.creditorName)}</span></b> <span class="muted">${esc(f.creditorCode || '')}</span> <span class="muted small-text">${pos} PO${pos > 1 ? 's' : ''}</span>`;
      const show = grp === 'item' ? 'item' : 'cred';
      sub = `<table class="sub-item-table"><thead><tr>${grp === 'item' ? '<th>PO No.</th><th>PO Date</th><th>Creditor</th>' : '<th>Item</th><th>Description</th>'}<th class="text-right">PO Qty</th><th class="text-right">Received</th><th class="text-right">Bal Qty</th><th class="text-right">Outstanding (RM)</th></tr></thead><tbody>${
        (grp === 'cred' ? G.slice().sort((a, b) => a.p.iso.localeCompare(b.p.iso)) : G).map(r => grp === 'cred'
          ? `<tr><td>${poLink(r.p.docNo, r.p.loc)}${locTag(r.p.loc)} <b>${esc(r.p.itemCode)}</b></td><td><span class="wrap">${esc(r.p.description)}</span></td><td class="text-right">${qtyFmt(r.p.qty)}</td><td class="text-right" style="color:var(--accent-green);">${qtyFmt(r.recvQ)}</td><td class="text-right">${qtyFmt(r.balQ)}</td><td class="text-right" style="color:var(--accent-orange);font-weight:700;">${rm(r.bal)}</td></tr>`
          : lineRow(r, show)).join('')}</tbody></table>`;
    }
    return `<details class="fold fold-doc"><summary><span class="fold-arrow">▶</span><span class="fold-title">${title}</span><span class="fold-stats"><span class="fs-amt out">${rm(bal)}</span></span></summary><div class="fold-body">${sub}</div></details>`;
  }).join('');
}

// ====================================================
// REPORT: PO Completed — fully received POs by the GRN month that completed them
// ====================================================
function renderPOCompleted() {
  const body = document.getElementById('poDoneBody');
  if (!body) return;
  folderRender = {}; folderSeq = 0;
  if (!hasScopedData()) { updateKPIs([]); body.innerHTML = `<div class="empty-state">${noDataMsg()}</div>`; return; }
  const q = getSearchFilter(), from = fromDate(), asAt = asAtDate();
  const s = allocateAsOf(asAt);
  const docs = {};
  rawPOList.forEach(p => {
    if (!locAllowed(p.loc) || !poMatchesSearch(p, q) || !p.iso || p.iso < from || p.iso > asAt) return;
    const k = up(p.docNo) + '|' + p.loc;
    const d = docs[k] || (docs[k] = { docNo: p.docNo, docDate: p.docDate, iso: p.iso, yymm: p.yymm, loc: p.loc, cred: p.creditorName, code: p.creditorCode, lines: [], po: 0, recv: 0, cx: 0, open: false, last: '', cxDate: '' });
    d.lines.push(p); d.po += p.lineSubTotal;
    const c = cancelOf(p);
    if (balAt(p, s, asAt) > 0.005) d.open = true;
    d.recv += Math.min(s.got[p.id], p.qty) * p.unitCost;
    if (s.lastGrn[p.id] > d.last) d.last = s.lastGrn[p.id];
    if (c && c.date <= asAt) { d.cx += cancelledValue(p); if (c.date > d.cxDate) d.cxDate = c.date; }
  });
  const done = Object.values(docs).filter(d => !d.open);
  done.forEach(d => { d.done = d.last > d.cxDate ? d.last : d.cxDate; d.doneM = d.done ? isoToYYMM(d.done) : ''; d.kind = d.cx > 0.005 ? 'cancel' : 'full'; });
  const all = [...new Set(done.map(d => d.doneM).filter(Boolean))].sort();
  monthPicks['poDonePick:all'] = all;
  const months = renderMonthPicker('poDonePick', all, 'toggleMonthPick');
  const exp = [];
  let html = '', kpi = [];
  months.slice().reverse().forEach(m => {
    const D = done.filter(d => d.doneM === m);
    D.forEach(d => { kpi.push(...d.lines); exp.push(withLoc({ 'Completed in': monApos(m, true), Type: d.kind === 'cancel' ? 'Cancelled (part or all)' : 'Fully received', 'PO issued': d.yymm === m ? 'This month' : 'Earlier month',
      'PO No': d.docNo, 'PO Date': d.docDate, 'Creditor Code': d.code, 'Creditor Name': d.cred, 'Completed on': dateDMY(d.done), 'Days': daysBetween(d.iso, d.done), 'PO Value': Math.round(d.po * 100) / 100,
      Received: Math.round(d.recv * 100) / 100, Cancelled: Math.round(d.cx * 100) / 100 }, d.loc)); });
    const leaf = (L, title) => L.length ? folderHtml('fold-leaf', title, foldStats(L.length, 'POs', L.reduce((a, d) => a + d.recv, 0), 'done'), () => doneLeafHtml(L), true) : '';
    const F = D.filter(d => d.kind === 'full'), C = D.filter(d => d.kind === 'cancel');
    const inner = leaf(F.filter(d => d.yymm === m), `📁 POs issued this month (${monApos(m)})`) + leaf(F.filter(d => d.yymm !== m), '📁 POs from earlier months') +
      (C.length ? folderHtml('fold-leaf st-cancel', '📁 Cancelled (part or all)', `<span class="fs-n">${C.length} POs</span><span class="fs-amt">${rm(C.reduce((a, d) => a + d.cx, 0))}</span>`, () => doneLeafHtml(C), true) : '');
    html += folderHtml('fold-month', `<b>Completed in ${monApos(m, true).toUpperCase()}</b>`, foldStats(D.length, 'POs', D.reduce((a, d) => a + d.recv, 0), 'done'), inner || '<div class="empty-state">None.</div>', false);
  });
  body.innerHTML = html || '<div class="empty-state">No completed POs for these filters.</div>';
  if (months.length === 1) { const d = body.querySelector('details.fold-month'); if (d) d.open = true; }
  updateKPIs(kpi);
  exportStore.poDoneTable = { summary: exp, detail: null };
}
function doneLeafHtml(L) {
  return `<table class="sub-item-table done-table"><thead><tr><th>PO No.</th><th>PO Date</th><th>Creditor</th><th>Completed on</th><th class="text-right">Days</th><th class="text-right">PO Value (RM)</th><th class="text-right">Received (RM)</th><th class="text-right">Cancelled (RM)</th></tr></thead><tbody>` +
    L.slice().sort((a, b) => a.done.localeCompare(b.done) || a.docNo.localeCompare(b.docNo)).map(d => `<tr><td>${poLink(d.docNo, d.loc)}${locTag(d.loc)}</td><td>${esc(d.docDate)}</td><td>${esc(d.cred)}</td>
      <td>${dateDMY(d.done)}</td><td class="text-right">${daysBetween(d.iso, d.done)}</td><td class="text-right">${rm(d.po)}</td><td class="text-right" style="color:var(--accent-green);">${rm(d.recv)}</td>
      <td class="text-right">${d.cx > 0.005 ? rm(d.cx) : '<span class="muted">-</span>'}</td></tr>`).join('') + '</tbody></table>';
}


// ====================================================
// UPLOAD: one drop area, auto-detects the file, review before saving
// ====================================================
const readRows = file => new Promise(res => readCSV(file, rows => res(rows)));
function fileKind(rows, hint) {
  const t = detectReportTitle(rows);
  if (/Cancelled Purchase Order/i.test(t)) return 'cancel';
  if (/Purchase Order Detail/i.test(t)) return 'po';
  if (/Goods Received Note/i.test(t)) return 'grn';
  if (/Cancelled Purchase Order/i.test(t)) return 'cancel';
  if (/Stock Location/i.test(t)) return 'loc';
  if (/Creditor Listing/i.test(t)) return 'cred';
  if (hint) return hint;
  if (parseAutoCountGRNCSV(rows).length) return 'grn';
  if (parseAutoCountPOCSV(rows).length) return 'po';
  return '';
}
const KIND_LBL = { po: 'PO Detail Listing', grn: 'GRN Detail Listing', loc: 'Stock Location Listing', cred: 'Creditor Listing', cancel: 'Cancelled PO Listing' };
let uploadBusy = false;
async function uploadFiles(list, hint) {
  const files = [...(list || [])];
  if (!files.length) return;
  if (uploadBusy) return alert('Please finish the current upload first.');
  uploadBusy = true;
  // PO before GRN so GRNs can match the new POs; lists first
  const order = { loc: 0, cred: 1, po: 2, grn: 3, cancel: 4, '': 5 };
  const jobs = [];
  try {
    for (const f of files) {
      const rows = await readRows(f);
      if (!rows || !rows.length) continue;
      jobs.push({ file: f, rows, kind: fileKind(rows, files.length === 1 ? hint : '') });
    }
    jobs.sort((a, b) => order[a.kind] - order[b.kind]);
    let changed = 0;
    for (const j of jobs) {
      if (!j.kind) { await upMessage(`❓ ${esc(j.file.name)}`, `<p>This file is not a PO / GRN / Stock Location / Creditor Listing from AutoCount, so it was skipped.</p>`); continue; }
      if (await reviewAndApply(j)) changed++;
    }
    if (changed) afterDataChange();
  } catch (err) { console.error(err); alert('Upload stopped: ' + err.message); }
  finally { uploadBusy = false; renderUploadPage(); }
}

// --- the review window (returns the button the user clicked) ---
function upDialog(title, html, buttons) {
  return new Promise(res => {
    document.getElementById('upReviewTitle').innerHTML = title;
    document.getElementById('upReviewBody').innerHTML = html;
    const act = document.getElementById('upReviewActions');
    act.innerHTML = buttons.map((b, i) => `<button class="btn ${b.cls || 'btn-print'}" data-i="${i}">${b.label}</button>`).join('');
    const m = document.getElementById('upReviewModal');
    m.classList.add('active');
    act.querySelectorAll('button').forEach(btn => btn.onclick = () => { m.classList.remove('active'); res(buttons[+btn.dataset.i].value); });
  });
}
const upMessage = (title, html) => upDialog(title, html, [{ label: 'OK', value: 'ok', cls: 'btn-excel' }]);

function diffLines(kind, saved, items) {
  const dk = kind === 'po' ? 'iso' : 'grnIso', docK = kind === 'po' ? 'docNo' : 'grnNo', amtK = kind === 'po' ? 'lineSubTotal' : 'subTotal';
  const dates = items.map(x => x[dk]).filter(Boolean).sort();
  const from = dates[0], to = dates[dates.length - 1];
  const old = (saved || []).filter(x => x[dk] && x[dk] >= from && x[dk] <= to);
  const sig = x => [up(x.itemCode), +(+x.qty || 0).toFixed(4), (+x[amtK] || 0).toFixed(2), up(x.loc), up(x.creditorCode), kind === 'grn' ? up(x.poNo) : ''].join('|');
  const group = L => { const g = {}; L.forEach(x => { const k = up(x[docK]); (g[k] = g[k] || []).push(x); }); return g; };
  const go = group(old), gn = group(items);
  const docInfo = L => ({ no: L[0][docK], date: kind === 'po' ? L[0].docDate : L[0].grnDate, cred: L[0].creditorName || L[0].creditorCode || '', po: kind === 'grn' ? L[0].poNo : '',
    amt: L.reduce((a, x) => a + (+x[amtK] || 0), 0), lines: L.length, locs: [...new Set(L.map(x => x.loc).filter(Boolean))].join(', ') });
  const added = [], removed = [], changed = [];
  Object.keys(gn).forEach(k => {
    if (!go[k]) { added.push(docInfo(gn[k])); return; }
    const a = go[k].map(sig).sort().join('\n'), b = gn[k].map(sig).sort().join('\n');
    if (a === b) return;
    const o = docInfo(go[k]), n = docInfo(gn[k]), what = [];
    if (o.lines !== n.lines) what.push(`lines ${o.lines} → ${n.lines}`);
    if (Math.abs(o.amt - n.amt) >= 0.005) what.push(`amount ${fmt(o.amt)} → ${fmt(n.amt)}`);
    const qo = go[k].reduce((a, x) => a + (+x.qty || 0), 0), qn = gn[k].reduce((a, x) => a + (+x.qty || 0), 0);
    if (Math.abs(qo - qn) > EPS) what.push(`qty ${qtyFmt(qo)} → ${qtyFmt(qn)}`);
    if (o.locs !== n.locs) what.push(`location ${o.locs || '-'} → ${n.locs || '-'}`);
    if (up(o.cred) !== up(n.cred)) what.push(`creditor ${o.cred || '-'} → ${n.cred || '-'}`);
    if (kind === 'grn' && up(o.po) !== up(n.po)) what.push(`PO ${o.po || '-'} → ${n.po || '-'}`);
    if (!what.length) what.push('item details changed');
    changed.push(Object.assign(n, { oldAmt: o.amt, what }));
  });
  Object.keys(go).forEach(k => { if (!gn[k]) removed.push(docInfo(go[k])); });
  const months = {};
  const mk = x => isoToYYMM(x[dk]);
  old.forEach(x => { const m = months[mk(x)] || (months[mk(x)] = { oL: 0, oA: 0, nL: 0, nA: 0 }); m.oL++; m.oA += +x[amtK] || 0; });
  items.forEach(x => { if (!x[dk]) return; const m = months[mk(x)] || (months[mk(x)] = { oL: 0, oA: 0, nL: 0, nA: 0 }); m.nL++; m.nA += +x[amtK] || 0; });
  // same document already saved in ANOTHER month (date changed in AutoCount) -> old copy is removed on Accept
  const newDocs = new Set(Object.keys(gn));
  const outside = (saved || []).filter(x => !(x[dk] && x[dk] >= from && x[dk] <= to) && newDocs.has(up(x[docK])));
  const movedMap = {};
  outside.forEach(x => { const k = up(x[docK]); (movedMap[k] = movedMap[k] || []).push(x); });
  const moved = Object.keys(movedMap).map(k => { const o = docInfo(movedMap[k]), n = docInfo(gn[k]);
    return Object.assign(n, { oldAmt: o.amt, what: [`saved as ${o.date || '-'} → now ${n.date || '-'} (date changed in AutoCount)`] }); });
  const movedKeys = new Set(Object.keys(movedMap));
  return { from, to, old, added: added.filter(d => !movedKeys.has(up(d.no))), removed, changed, moved, movedKeys, months,
    same: !added.length && !removed.length && !changed.length && !moved.length, keepN: (saved || []).length - old.length - outside.length };
}

async function reviewAndApply(j) {
  const { file, rows, kind } = j;
  const fileCo = detectCompany(rows);
  const target = fileCo || db.current || 'My Company';
  const coNow = db.current ? companyDisplay(db.current) : '';
  const coWarn = fileCo && db.current && fileCo !== db.current && Object.keys(db.companies).length
    ? `<div class="up-warn">⚠ This file is for <b>${esc(fileCo)}</b>${db.companies[fileCo] ? '' : ' <i>(new company — it will be added)</i>'}, but you are uploading for <b>${esc(coNow)}</b>. If you accept, it is saved under <b>${esc(fileCo)}</b> and the portal switches to that company.</div>` : '';
  const head = `${kind === 'po' ? '📁' : kind === 'grn' ? '🚚' : kind === 'loc' ? '📍' : kind === 'cancel' ? '✖' : '🏢'} ${KIND_LBL[kind]} <span class="muted">· ${esc(file.name)}</span>`;
  const coLine = `<div class="up-co-line">Company: <b>${esc(target)}</b></div>`;

  if (kind === 'cancel') return reviewCancelFile(j, head, coLine, coWarn, target);
  if (kind === 'loc' || kind === 'cred') {
    const list = kind === 'loc' ? parseStockLocationCSV(rows) : parseCreditorListing(rows);
    const n = Object.keys(list).length;
    if (!n) { await upMessage(head, `<p>No ${kind === 'loc' ? 'locations' : 'creditors'} found in this file.</p>`); return false; }
    const cur = ((db.companies[target] || {})[kind === 'loc' ? 'locMaster' : 'credMaster']) || {};
    const added = Object.keys(list).filter(k => !cur[k]), gone = Object.keys(cur).filter(k => !list[k]), ren = Object.keys(list).filter(k => cur[k] && cur[k] !== list[k]);
    const same = !added.length && !gone.length && !ren.length;
    const v = await upDialog(head, coLine + coWarn + (same ? `<div class="up-same">✓ Same as saved — ${n} ${kind === 'loc' ? 'locations' : 'creditors'}, nothing changed.</div>` :
      `<p>${n} ${kind === 'loc' ? 'locations' : 'creditors'} in the file.</p><ul class="up-list">${added.length ? `<li>➕ New: ${added.slice(0, 30).map(esc).join(', ')}${added.length > 30 ? ' …' : ''}</li>` : ''}${ren.length ? `<li>✏️ Name changed: ${ren.slice(0, 20).map(k => `${esc(k)} (${esc(cur[k])} → ${esc(list[k])})`).join(', ')}</li>` : ''}${gone.length ? `<li>➖ Not in this file: ${gone.slice(0, 30).map(esc).join(', ')}</li>` : ''}</ul>`),
      same ? [{ label: 'OK', value: 'skip', cls: 'btn-excel' }] : [{ label: '✓ Accept', value: 'ok', cls: 'btn-excel' }, { label: 'Keep saved data', value: 'skip' }]);
    if (v !== 'ok') return false;
    useCompanyFromFile(rows);
    if (kind === 'loc') { store.locMaster = list; store.meta.locFile = file.name; store.meta.locLoadedAt = new Date().toLocaleString('en-GB'); logAction(`Uploaded Stock Location Listing (${n} locations)`, null, 'loc'); }
    else { store.credMaster = list; store.meta.credFile = file.name; store.meta.credLoadedAt = new Date().toLocaleString('en-GB'); logAction(`Uploaded Creditor Listing (${n} creditors)`, null, 'credlist'); }
    return true;
  }

  const items = kind === 'po' ? parseAutoCountPOCSV(rows) : parseAutoCountGRNCSV(rows);
  if (!items.length) { await upMessage(head, `<p>No ${kind === 'po' ? 'PO' : 'GRN'} lines found. Please export "${KIND_LBL[kind]}" from AutoCount as CSV or Excel.</p>`); return false; }
  const saved = (db.companies[target] || {})[kind] || [];
  const D = diffLines(kind, saved, items);
  const word = kind === 'po' ? 'PO' : 'GRN';
  const ms = Object.keys(D.months).sort();
  const monthTbl = `<table class="audit-table up-mtable"><thead><tr><th>Month</th><th class="text-right">Saved lines</th><th class="text-right">Saved amount</th><th class="text-right">New file lines</th><th class="text-right">New file amount</th><th class="text-right">Difference</th></tr></thead><tbody>` +
    ms.map(m => { const x = D.months[m], d = x.nA - x.oA; return `<tr><td><b>${monApos(m, true)}</b></td><td class="text-right">${x.oL}</td><td class="text-right">${rm(x.oA)}</td><td class="text-right">${x.nL}</td><td class="text-right">${rm(x.nA)}</td>
      <td class="text-right ${Math.abs(d) >= 0.005 ? (d > 0 ? 'up-plus' : 'up-minus') : 'muted'}">${Math.abs(d) >= 0.005 ? (d > 0 ? '+' : '−') + rm(Math.abs(d)) : x.oL === x.nL ? 'same total' : 'same amount'}</td></tr>`; }).join('') + '</tbody></table>';
  const docRow = (d, sign) => `<tr><td>${sign}</td><td><b>${esc(d.no)}</b></td><td>${esc(d.date || '')}</td><td>${esc(d.cred)}</td>${kind === 'grn' ? `<td>${esc(d.po || 'No PO')}</td>` : ''}<td>${esc(d.locs)}</td>
    <td class="text-right">${d.oldAmt !== undefined && Math.abs(d.oldAmt - d.amt) >= 0.005 ? `<span class="muted">${fmt(d.oldAmt)} →</span> ` : ''}${rm(d.amt)}</td><td class="small-text">${d.what ? esc(d.what.join(' · ')) : ''}</td></tr>`;
  const listTbl = (L, sign, label, cls) => !L.length ? '' : `<div class="up-sec ${cls}">${label} (${L.length})</div><div class="up-scroll"><table class="audit-table up-dtable"><thead><tr><th></th><th>${word} No.</th><th>Date</th><th>Creditor</th>${kind === 'grn' ? '<th>PO No.</th>' : ''}<th>Location</th><th class="text-right">Amount</th><th>What changed</th></tr></thead><tbody>` +
    L.slice(0, 300).map(d => docRow(d, sign)).join('') + (L.length > 300 ? `<tr><td colspan="8" class="muted">… ${L.length - 300} more</td></tr>` : '') + '</tbody></table></div>';
  const first = !saved.length;
  const period = `${dateDMY(D.from)} – ${dateDMY(D.to)}`;
  let html = coLine + coWarn + `<div class="up-period">File period: <b>${period}</b> · ${items.length} lines · ${new Set(items.map(x => up(kind === 'po' ? x.docNo : x.grnNo))).size} ${word}s</div>`;
  if (first) html += `<div class="up-same">First ${word} upload for this company — everything is new.</div>`;
  else if (D.same) html += `<div class="up-same">✓ Same as saved — no ${word} was added, removed or changed for ${period}.</div>` + monthTbl;
  else html += monthTbl + listTbl(D.added, '➕', `➕ New ${word}s`, 'add') + listTbl(D.changed, '✏️', `✏️ Changed ${word}s`, 'chg') + listTbl(D.removed, '➖', `➖ Not in the new file (will be removed)`, 'del') +
    listTbl(D.moved, '⚠', `⚠ Already saved in another month — date changed in AutoCount (old copy will be removed, no double)`, 'chg') +
    `<div class="muted small-text" style="margin-top:8px;">Accept = update ${period} only. The other ${D.keepN} saved lines (other months) are kept.</div>`;
  const btns = D.same && !first ? [{ label: 'OK — nothing to change', value: 'skip', cls: 'btn-excel' }, { label: 'Replace ALL saved ' + word + ' data with this file…', value: 'all', cls: 'btn-ghost' }]
    : [{ label: first ? '✓ Accept' : `✓ Accept — update ${period}`, value: 'ok', cls: 'btn-excel' }, { label: 'Keep saved data', value: 'skip' }].concat(first ? [] : [{ label: 'Replace ALL saved ' + word + ' data…', value: 'all', cls: 'btn-ghost' }]);
  let v = await upDialog(head, html, btns);
  if (v === 'all' && !confirm(`Replace ALL saved ${word} data for ${target} (${saved.length} lines, every month) with only this file (${items.length} lines)?\nMonths not in this file will be removed.`)) v = 'skip';
  if (v !== 'ok' && v !== 'all') return false;
  useCompanyFromFile(rows);
  const dk = kind === 'po' ? 'iso' : 'grnIso';
  const docK = kind === 'po' ? 'docNo' : 'grnNo';
  const kept = v === 'all' ? [] : store[kind].filter(x => (!x[dk] || x[dk] < D.from || x[dk] > D.to) && !D.movedKeys.has(up(x[docK])));
  store[kind] = kept.concat(items);
  if (kind === 'po' && items.locNames) Object.keys(items.locNames).forEach(c => { if (!store.locMaster[c]) store.locMaster[c] = items.locNames[c]; });
  store.meta[kind + 'File'] = file.name;
  store.meta[kind + 'LoadedAt'] = new Date().toLocaleString('en-GB');
  const what = first ? 'first upload' : v === 'all' ? 'replaced all' : D.same ? 'no change' : `${period}: +${D.added.length} new, ${D.changed.length} changed, ${D.removed.length} removed${D.moved.length ? `, ${D.moved.length} date changed` : ''}`;
  logAction(`Uploaded ${word} file "${file.name}" (${items.length} lines, ${what})`, null, kind);
  return true;
}


async function reviewCancelFile(j, head, coLine, coWarn, target) {
  const { file, rows } = j;
  const items = parseCancelPOCSV(rows);
  if (!items.length) { await upMessage(head, '<p>No cancelled PO lines found in this file.</p>'); return false; }
  const co = db.companies[target] || emptyCompany();
  const dates = items.map(x => x.iso).filter(Boolean).sort();
  const from = dates[0], to = dates[dates.length - 1];
  const saved = (co.cxLines || []);
  const sig = x => [up(x.doc), up(x.poNo), up(x.itemCode), x.qty, (+x.amt).toFixed(2), x.iso].join('|');
  const oldIn = saved.filter(x => x.iso && x.iso >= from && x.iso <= to);
  const so = new Set(oldIn.map(sig)), sn = new Set(items.map(sig));
  const added = items.filter(x => !so.has(sig(x))), removed = oldIn.filter(x => !sn.has(sig(x)));
  // which POs are in the uploaded PO data of that company
  const poDocs = new Set((co.po || []).map(p => up(p.docNo)));
  const inData = items.filter(x => poDocs.has(up(x.poNo))), notIn = items.filter(x => !poDocs.has(up(x.poNo)));
  const sum = L => L.reduce((s, x) => s + (+x.amt || 0), 0);
  const months = {};
  items.forEach(x => { const m = isoToYYMM(x.iso || '0000-00'); const o = months[m] || (months[m] = { n: 0, a: 0 }); o.n++; o.a += x.amt; });
  const period = `${dateDMY(from)} – ${dateDMY(to)}`;
  const same = saved.length && !added.length && !removed.length;
  const rowsHtml = L => L.slice(0, 200).map(x => `<tr><td>${esc(x.date)}</td><td><b>${esc(x.doc)}</b></td><td>${esc(x.poNo)}</td><td>${esc(x.creditorName || x.creditorCode)}</td><td>${esc(x.itemCode)}</td><td>${esc(x.loc)}</td><td class="text-right">${qtyFmt(x.qty)}</td><td class="text-right">${fmt(x.amt)}</td></tr>`).join('') + (L.length > 200 ? `<tr><td colspan="8" class="muted">… ${L.length - 200} more</td></tr>` : '');
  const tbl = (L, title, cls) => !L.length ? '' : `<div class="up-sec ${cls}">${title} (${L.length})</div><div class="up-scroll"><table class="audit-table up-dtable"><thead><tr><th>Cancel date</th><th>Cancel doc</th><th>PO No.</th><th>Creditor</th><th>Item</th><th>Location</th><th class="text-right">Qty</th><th class="text-right">Amount</th></tr></thead><tbody>${rowsHtml(L)}</tbody></table></div>`;
  let html = coLine + coWarn + `<div class="up-period">File period: <b>${period}</b> · ${items.length} cancelled lines · ${new Set(items.map(x => up(x.poNo))).size} POs · ${rm(sum(items))}</div>`;
  html += `<table class="audit-table up-mtable"><thead><tr><th>Cancel month</th><th class="text-right">Lines</th><th class="text-right">Amount</th></tr></thead><tbody>${Object.keys(months).sort().map(m => `<tr><td>${m === '0000' ? '-' : monApos(m, true)}</td><td class="text-right">${months[m].n}</td><td class="text-right">${rm(months[m].a)}</td></tr>`).join('')}</tbody></table>`;
  html += `<div class="up-co-line" style="margin-top:8px;">✓ <b>${inData.length}</b> lines (${rm(sum(inData))}) belong to POs in your uploaded PO data — they will be marked <b>Cancelled</b>.`
    + (notIn.length ? `<br>ℹ ${notIn.length} lines (${rm(sum(notIn))}) are for older POs that are not uploaded (e.g. ${esc([...new Set(notIn.map(x => x.poNo))].slice(0, 4).join(', '))}) — kept, and used if you upload those POs later.` : '') + '</div>';
  if (same) html += `<div class="up-same">✓ Same as saved — nothing changed for ${period}.</div>`;
  else if (saved.length) html += tbl(added, '➕ New cancelled lines', 'add') + tbl(removed, '➖ Not in this file (will be removed)', 'del');
  const v = await upDialog(head, html, same ? [{ label: 'OK — nothing to change', value: 'skip', cls: 'btn-excel' }]
    : [{ label: `✓ Accept — update ${period}`, value: 'ok', cls: 'btn-excel' }, { label: 'Keep saved data', value: 'skip' }]);
  if (v !== 'ok') return false;
  useCompanyFromFile(rows);
  store.cxLines = (store.cxLines || []).filter(x => !x.iso || x.iso < from || x.iso > to).concat(items);
  store.meta.cxFile = file.name; store.meta.cxLoadedAt = new Date().toLocaleString('en-GB');
  logAction(`Uploaded Cancelled PO file "${file.name}" (${items.length} lines, ${rm(sum(items))}, ${period})`, null, 'cxfile');
  return true;
}

// --- upload page ---
function onUploadCompanyPick(sel) { if (sel.value && sel.value !== db.current) switchCompany(sel.value); renderUploadPage(); }
function uploadGridHtml() {
  const m = {};
  store.po.forEach(p => { const k = p.yymm; if (k && k !== '0000') { const x = m[k] || (m[k] = { po: 0, grn: 0, poA: 0, grnA: 0, docs: new Set() }); x.po++; x.poA += p.lineSubTotal || 0; x.docs.add(p.docNo); } });
  store.grn.forEach(g => { const k = g.grnYYMM; if (k && k !== '0000') { const x = m[k] || (m[k] = { po: 0, grn: 0, poA: 0, grnA: 0, docs: new Set() }); x.grn++; x.grnA += g.subTotal || 0; } });
  const ks = Object.keys(m).sort();
  if (!ks.length) return '<p class="muted">Nothing saved yet for this company. Drop the PO and GRN files above.</p>';
  const y0 = 2000 + +ks[0].slice(0, 2), y1 = Math.max(2000 + +ks[ks.length - 1].slice(0, 2), new Date().getFullYear());
  const nowM = isoToYYMM(todayISO()), firstM = ks[0];
  let html = '<table class="up-grid"><thead><tr><th></th>' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map(x => `<th>${x}</th>`).join('') + '</tr></thead><tbody>';
  for (let y = y1; y >= y0; y--) {
    html += `<tr><th>${y}</th>`;
    for (let mo = 1; mo <= 12; mo++) {
      const k = String(y).slice(2) + String(mo).padStart(2, '0'), x = m[k];
      if (k < firstM || k > nowM) { html += '<td class="ug-off"></td>'; continue; }
      const cls = x && x.po && x.grn ? 'ok' : x ? 'half' : (k === nowM ? 'cur' : 'miss');
      html += `<td class="ug ${cls}" title="${monApos(k, true)}${x ? `: ${x.docs.size} POs (${x.po} lines, ${rm(x.poA)}) · ${x.grn} GRN lines (${rm(x.grnA)})` : ': nothing saved'}">
        <span class="${x && x.po ? 'y' : 'n'}">PO</span><span class="${x && x.grn ? 'y' : 'n'}">GRN</span></td>`;
    }
    html += '</tr>';
  }
  return html + '</tbody></table><div class="ug-legend"><span class="ug ok"></span> PO + GRN saved <span class="ug half"></span> only one saved <span class="ug miss"></span> missing <span class="ug cur"></span> this month (still running)</div>';
}
function renderUploadPage() {
  const sel = document.getElementById('upCompany');
  if (!sel) return;
  const keys = Object.keys(db.companies).sort();
  sel.innerHTML = keys.length ? keys.map(k => `<option value="${esc(k)}">${esc(companyDisplay(k))}</option>`).join('') : '<option value="">(no company yet — upload a file)</option>';
  sel.value = db.current || '';
  const st = document.getElementById('upCoStats');
  if (st) {
    const poD = store.po.map(p => p.iso).filter(Boolean).sort(), grD = store.grn.map(g => g.grnIso).filter(Boolean).sort();
    st.innerHTML = !keys.length ? '' : `<div><span>PO</span><b>${store.po.length.toLocaleString()}</b> lines<small>${poD.length ? `${dateDMY(poD[0])} – ${dateDMY(poD[poD.length - 1])}` : '-'}</small></div>
      <div><span>GRN</span><b>${store.grn.length.toLocaleString()}</b> lines<small>${grD.length ? `${dateDMY(grD[0])} – ${dateDMY(grD[grD.length - 1])}` : '-'}</small></div>
      <div><span>Locations</span><b>${Object.keys(store.locMaster || {}).length}</b><small>${store.meta.locFile ? 'listing uploaded' : 'listing not uploaded'}</small></div>
      <div><span>Creditors</span><b>${Object.keys(store.credMaster || {}).length}</b><small>${store.meta.credFile ? 'listing uploaded' : 'listing not uploaded'}</small></div>`;
  }
  const g = document.getElementById('upGrid'); if (g) g.innerHTML = uploadGridHtml();
  renderDeleteCard();
  const rc = document.getElementById('upRecent');
  if (rc) {
    const isUp = e => /^Uploaded /.test(e.action || '') && (!e.company || e.company === db.current);
    const pend = visibleLog(pendingLog).filter(isUp).slice().reverse();
    const rows = activityLog.filter(isUp).slice().reverse().slice(0, 12);
    rc.innerHTML = !pend.length && !rows.length ? '<p class="muted">No uploads recorded yet for this company.</p>' :
      `<table class="audit-table loc-master-table"><thead><tr><th>When</th><th>By</th><th>What</th></tr></thead><tbody>` +
      pend.map(e => `<tr class="log-pending"><td><i>not saved yet</i></td><td>${esc(currentUser ? currentUser.name : '')}</td><td>${esc(e.action)}</td></tr>`).join('') +
      rows.map(e => `<tr><td>${esc(e.savedAt || e.at || '')}</td><td><b>${esc(e.byName || e.by || '')}</b></td><td>${esc(e.action)}</td></tr>`).join('') + '</tbody></table>';
  }
}


// ====================================================
// REPORT: Price Check — GRN amount vs PO price (same total as the "price difference" in Summary)
// ====================================================
function renderPriceCheck() {
  const body = document.getElementById('pcBody');
  if (!body) return;
  folderRender = {}; folderSeq = 0;
  updateKPIs(getScopedPOLines());
  if (!rawGRNList.length) { body.innerHTML = `<div class="empty-state">${noDataMsg()}</div>`; return; }
  const allMonths = [...new Set(rawGRNList.filter(g => locAllowed(g.loc)).map(g => g.grnYYMM).filter(m => m && m !== '0000'))].sort();
  monthPicks['pcPick:all'] = allMonths;
  const picked = new Set(renderMonthPicker('pcPick', allMonths, 'toggleMonthPick'));
  const grp = (document.getElementById('pcGroup') || {}).value || 'cred';
  const minAmt = Math.abs(parseFloat((document.getElementById('pcMin') || {}).value) || 0.01);
  const q = getSearchFilter();
  const EV = allocEvents();
  const rows = [];
  rawPOList.forEach(p => {
    (EV[p.id] || []).forEach(([iso, l, qq, amt, over, g]) => {
      if (!g || !picked.has(g.grnYYMM) || !locAllowed(l) || !grnMatchesSearch(g, q)) return;
      const poVal = over ? 0 : qq * p.unitCost;
      const diff = amt - poVal;
      if (Math.abs(diff) < 0.005) return;
      rows.push({ p, g, qty: qq, amt, poVal, diff, over, poPrice: p.unitCost, grnPrice: qq > EPS ? amt / qq : 0 });
    });
  });
  // same GRN + item lines that cancel each other out (e.g. PO line moved / transferred, net RM 0) → hide
  const net = {};
  rows.forEach(r => { const k = up(r.g.grnNo) + '|' + up(r.g.itemCode) + '|' + up(r.g.loc); net[k] = (net[k] || 0) + r.diff; });
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i], k = up(r.g.grnNo) + '|' + up(r.g.itemCode) + '|' + up(r.g.loc);
    if (Math.abs(net[k]) < 0.005 || Math.abs(r.diff) < minAmt) rows.splice(i, 1);
  }
  const tot = rows.reduce((a, r) => a + r.diff, 0), up_ = rows.filter(r => r.diff > 0).reduce((a, r) => a + r.diff, 0), dn = tot - up_;
  const mLbl = [...picked].sort().map(m => monApos(m)).join(', ');
  const sign = v => `<span class="${v > 0 ? 'pc-up' : 'pc-dn'}">${v > 0 ? '+' : '−'}${rm(Math.abs(v))}</span>`;
  let html = `<div class="pc-kpis">
      <div><span>Price difference (GRN − PO)</span><b>${sign(tot)}</b><small>${mLbl || '-'} · same as the "price difference" in Summary PO vs GRN</small></div>
      <div><span>GRN higher than PO</span><b class="pc-up">+${rm(up_)}</b><small>${rows.filter(r => r.diff > 0).length} lines — supplier charged more / extra qty</small></div>
      <div><span>GRN lower than PO</span><b class="pc-dn">−${rm(Math.abs(dn))}</b><small>${rows.filter(r => r.diff < 0).length} lines — cheaper than ordered</small></div>
    </div>
    <div class="pc-legend"><span class="xq">+12.5</span> orange qty = <b>extra qty</b> (received more than the PO qty, so it has no PO price) · <span class="pc-up">+RM</span> GRN cost more · <span class="pc-dn">−RM</span> GRN cost less</div>`;
  const exp = rows.map(r => withLoc({ 'GRN Month': monApos(r.g.grnYYMM, true), 'GRN No': r.g.grnNo, 'GRN Date': r.g.grnDate, 'PO No': r.p.docNo, 'PO Date': r.p.docDate,
    'Creditor Code': r.g.creditorCode, 'Creditor Name': r.g.creditorName, 'Item Code': r.g.itemCode, Description: r.g.description, Qty: r.qty,
    'PO Price': Math.round(r.poPrice * 10000) / 10000, 'GRN Price': Math.round(r.grnPrice * 10000) / 10000, 'Value at PO Price': Math.round(r.poVal * 100) / 100,
    'GRN Amount': Math.round(r.amt * 100) / 100, Difference: Math.round(r.diff * 100) / 100, Reason: r.over ? 'Extra qty (more than PO)' : 'Price' }, r.g.loc));
  exportStore.pcTable = { summary: exp, detail: null };
  if (!rows.length) { body.innerHTML = html + '<div class="empty-state">✓ No price differences for these months — every GRN matches its PO price.</div>'; return; }
  const keyOf = grp === 'item' ? r => up(r.g.itemCode) : grp === 'po' ? r => up(r.p.docNo) : r => r.g.creditorCode || up(r.g.creditorName);
  const groups = {};
  rows.forEach(r => { (groups[keyOf(r)] = groups[keyOf(r)] || []).push(r); });
  const keys = Object.keys(groups).sort((a, b) => Math.abs(groups[b].reduce((s, r) => s + r.diff, 0)) - Math.abs(groups[a].reduce((s, r) => s + r.diff, 0)));
  html += keys.map(k => {
    const G = groups[k], f = G[0], d = G.reduce((s, r) => s + r.diff, 0);
    const title = grp === 'item' ? `<b>${esc(f.g.itemCode)}</b> <span class="wrap">${esc(f.g.description)}</span>` : grp === 'po' ? `${poLink(f.p.docNo, f.p.loc)} · <span class="wrap">${esc(f.p.creditorName)}</span>`
      : `<b><span class="wrap">${esc(f.g.creditorName)}</span></b> <span class="muted">${esc(f.g.creditorCode || '')}</span>`;
    return folderHtml('fold-leaf', title, `<span class="fs-n">${G.length} line${G.length > 1 ? 's' : ''}</span><span class="fs-amt">${sign(d)}</span>`, () =>
      `<table class="sub-item-table"><thead><tr><th>GRN No.</th><th>GRN Date</th><th>PO No.</th>${grp === 'cred' ? '<th>Item</th>' : '<th>Creditor</th>'}<th class="text-right">Qty</th>
        <th class="text-right">PO Price</th><th class="text-right">GRN Price</th><th class="text-right">At PO Price</th><th class="text-right">GRN Amount</th><th class="text-right">Difference</th></tr></thead><tbody>` +
      G.slice().sort((a, b) => a.g.grnIso.localeCompare(b.g.grnIso)).map(r => `<tr><td><b>${esc(r.g.grnNo)}</b>${locTag(r.g.loc)}</td><td>${esc(r.g.grnDate)}</td><td>${poLink(r.p.docNo, r.p.loc)}</td>
        <td class="pc-item">${grp === 'cred' ? `<b>${esc(r.g.itemCode)}</b> ${esc(r.g.description)}` : esc(r.g.creditorName)}</td>
        <td class="text-right">${r.over ? `<span class="xq" title="Extra qty — received more than the PO quantity">+${qtyFmt(r.qty)}</span>` : qtyFmt(r.qty)}</td>
        <td class="text-right">${fmt4(r.poPrice)}</td><td class="text-right">${r.qty > EPS ? fmt4(r.grnPrice) : '-'}</td>
        <td class="text-right">${r.over ? '<span class="muted">—</span>' : fmt(r.poVal)}</td><td class="text-right">${fmt(r.amt)}</td><td class="text-right">${sign(r.diff)}</td></tr>`).join('') + '</tbody></table>', true);
  }).join('');
  body.innerHTML = html;
}
function fmt4(v) { return (Math.round(v * 10000) / 10000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }); }


// ====================================================
// DELETE DATA by months / years (one place, admin only)
// ====================================================
function delWhatSet(what) { return { po: what === 'both' || what === 'po', grn: what === 'both' || what === 'grn', cx: what === 'both' || what === 'cx' }; }
function delMonthsList() {
  const ms = new Set();
  store.po.forEach(p => { if (p.iso) ms.add(isoToYYMM(p.iso)); });
  store.grn.forEach(g => { if (g.grnIso) ms.add(isoToYYMM(g.grnIso)); });
  (store.cxLines || []).forEach(x => { if (x.iso) ms.add(isoToYYMM(x.iso)); });
  return [...ms].filter(m => m && m !== '0000').sort();
}
function delSelection() {
  const what = (document.getElementById('delWhat') || {}).value || 'both';
  let a = (document.getElementById('delFrom') || {}).value, b = (document.getElementById('delTo') || {}).value;
  if (a && b && a > b) [a, b] = [b, a];
  return { what, from: a, to: b };
}
function delPreview() {
  const box = document.getElementById('delPreview');
  if (!box) return null;
  const { what, from, to } = delSelection();
  if (!from || !to) { box.innerHTML = ''; return null; }
  const inR = iso => { const m = iso ? isoToYYMM(iso) : ''; return m && m >= from && m <= to; };
  const w = delWhatSet(what);
  const po = w.po ? store.po.filter(p => inR(p.iso)) : [];
  const grn = w.grn ? store.grn.filter(g => inR(g.grnIso)) : [];
  const cx = w.cx ? (store.cxLines || []).filter(x => inR(x.iso)) : [];
  const poDocs = new Set(po.map(p => up(p.docNo)));
  const orphan = w.po ? store.grn.filter(g => !inR(g.grnIso) && g.poNo && poDocs.has(up(g.poNo))).length : 0;
  const sum = (L, k) => L.reduce((s, x) => s + (+x[k] || 0), 0);
  box.innerHTML = `<div class="del-prev">Will delete for <b>${esc(companyDisplay(db.current))}</b>, ${monApos(from, true)} – ${monApos(to, true)}:
    <ul>${w.po ? `<li>PO: <b>${po.length.toLocaleString()}</b> lines (${poDocs.size} POs) · ${rm(sum(po, 'lineSubTotal'))}</li>` : ''}
    ${w.grn ? `<li>GRN: <b>${grn.length.toLocaleString()}</b> lines (${new Set(grn.map(g => up(g.grnNo))).size} GRNs) · ${rm(sum(grn, 'subTotal'))}</li>` : ''}
    ${w.cx ? `<li>Cancelled PO (AutoCount file, by cancel date): <b>${cx.length.toLocaleString()}</b> lines · ${rm(sum(cx, 'amt'))}</li>` : ''}</ul>
    ${orphan ? `<div class="note-warn">⚠ ${orphan} GRN lines in other months belong to these POs — after deleting they will show as "PO not uploaded" (in B/F).</div>` : ''}</div>`;
  return { what, from, to, po: po.length, grn: grn.length, cx: cx.length };
}
function delQuickYear(y) {
  const ms = delMonthsList().filter(m => m.slice(0, 2) === String(y).slice(2));
  if (!ms.length) return;
  document.getElementById('delFrom').value = ms[0];
  document.getElementById('delTo').value = ms[ms.length - 1];
  delPreview();
}
function renderDeleteCard() {
  const box = document.getElementById('delCard');
  if (!box) return;
  const ms = delMonthsList();
  const isAdmin = currentUser && currentUser.admin;
  if (!ms.length) { box.innerHTML = '<p class="muted">Nothing saved for this company.</p>'; return; }
  if (!isAdmin) { box.innerHTML = '<p class="muted">Only the admin can delete data.</p>'; return; }
  const years = [...new Set(ms.map(m => '20' + m.slice(0, 2)))].sort();
  const opt = ms.slice().reverse().map(m => `<option value="${m}">${monApos(m, true)}</option>`).join('');
  const prev = delSelection();
  box.innerHTML = `<div class="del-row">
      <label>Delete</label><select id="delWhat" onchange="delPreview()"><option value="both">PO + GRN + Cancelled PO</option><option value="po">PO only</option><option value="grn">GRN only</option><option value="cx">Cancelled PO only</option></select>
      <label>from</label><select id="delFrom" onchange="delPreview()">${opt}</select>
      <label>to</label><select id="delTo" onchange="delPreview()">${opt}</select>
      <span class="muted small-text">Whole year:</span> ${years.map(y => `<button class="btn-small" onclick="delQuickYear(${y})">${y}</button>`).join(' ')}
    </div>
    <div id="delPreview"></div>
    <button class="btn btn-danger btn-sm" onclick="deleteRange()">🗑 Delete these months</button>
    <span class="muted small-text">Other months, locations and creditor lists are kept. GitHub keeps the old version, so it can be restored.</span>`;
  if (prev.from && ms.includes(prev.from)) { document.getElementById('delWhat').value = prev.what; document.getElementById('delFrom').value = prev.from; document.getElementById('delTo').value = prev.to; }
  else { document.getElementById('delFrom').value = ms[0]; document.getElementById('delTo').value = ms[0]; }
  delPreview();
}
function deleteRange() {
  if (!currentUser || !currentUser.admin) return alert('Only the admin can delete data.');
  const p = delPreview();
  if (!p || (!p.po && !p.grn && !p.cx)) return alert('Nothing to delete for these months.');
  const label = `${({ both: 'PO + GRN + Cancelled PO', po: 'PO', grn: 'GRN', cx: 'Cancelled PO' })[p.what]} ${monApos(p.from, true)} – ${monApos(p.to, true)}`;
  const t = prompt(`Delete ${label} for ${companyDisplay(db.current)}?\n${p.po ? p.po + ' PO lines  ' : ''}${p.grn ? p.grn + ' GRN lines  ' : ''}${p.cx ? p.cx + ' cancelled lines' : ''}\n\nType DELETE to confirm:`);
  if (!t || t.trim().toUpperCase() !== 'DELETE') return;
  const inR = iso => { const m = iso ? isoToYYMM(iso) : ''; return m && m >= p.from && m <= p.to; };
  const w = delWhatSet(p.what);
  if (w.po) store.po = store.po.filter(x => !inR(x.iso));
  if (w.grn) store.grn = store.grn.filter(x => !inR(x.grnIso));
  if (w.cx) store.cxLines = (store.cxLines || []).filter(x => !inR(x.iso));
  logAction(`Deleted ${label} (${[p.po && p.po + ' PO lines', p.grn && p.grn + ' GRN lines', p.cx && p.cx + ' cancelled lines'].filter(Boolean).join(', ')})`, null, 'delrange');
  Object.assign(pendingLog[pendingLog.length - 1], { from: p.from, to: p.to, what: p.what });
  afterDataChange();
  renderUploadPage();
  showToast('Deleted. Click 💾 Save so everyone sees it.');
}

// ----------------------------------------------------
// Backup & Restore (admin) — a password-locked file on the user's own PC
// ----------------------------------------------------
const BK_FORMAT = 'AutoCount-PO-Portal-Backup', BK_LAST_KEY = 'acp_last_backup';
function bkCompanyOptions(withAll) {
  const keys = Object.keys(db.companies).sort();
  return (withAll ? `<option value="__ALL__">All companies (${keys.length})</option>` : '') +
    keys.map(k => `<option value="${esc(k)}"${!withAll && k === db.current ? ' selected' : ''}>${esc(companyDisplay(k))}</option>`).join('');
}
function bkMonths(co) {
  const ms = new Set();
  (co.po || []).forEach(p => p.iso && ms.add(isoToYYMM(p.iso)));
  (co.grn || []).forEach(g => g.grnIso && ms.add(isoToYYMM(g.grnIso)));
  (co.cxLines || []).forEach(x => x.iso && ms.add(isoToYYMM(x.iso)));
  return [...ms].sort();
}
function renderBackupCard() {
  const box = document.getElementById('backupCard');
  if (!box) return;
  if (!currentUser || !currentUser.admin) { box.innerHTML = '<p class="muted">Only the admin can back up or restore data.</p>'; return; }
  const has = Object.keys(db.companies).length > 0;
  let last = null; try { last = JSON.parse(localStorage.getItem(BK_LAST_KEY) || 'null'); } catch (e) {}
  const ms = has ? bkMonths(store) : [];
  box.innerHTML = `<div class="bk-grid">
    <div class="bk-box"><h4>⬇ Download backup</h4><p>One file with PO, GRN, Cancelled PO, locations and creditor lists.</p>
      <label>Company</label><select id="bkCo">${has ? bkCompanyOptions(true) : '<option>(no data yet)</option>'}</select>
      <label>Set a backup password</label><input type="password" id="bkPw" autocomplete="new-password" placeholder="at least 6 characters">
      <label>Type it again</label><input type="password" id="bkPw2" autocomplete="new-password">
      <button class="btn btn-print" onclick="downloadBackup()" ${has ? '' : 'disabled'}>⬇ Download backup</button></div>
    <div class="bk-box"><h4>⬆ Restore from backup</h4><p>Choose a backup file. You will see a review first — nothing changes until you Accept and 💾 Save to Cloud.</p>
      <label>Backup password</label><input type="password" id="bkPwOpen" autocomplete="off" placeholder="password of the backup file">
      <button class="btn bk-orange" onclick="if(!document.getElementById('bkPwOpen').value)return alert('Type the backup password first.');document.getElementById('bkFile').click()">⬆ Choose backup file…</button></div>
    <div class="bk-box"><h4>📊 Export data to Excel</h4><p>Raw PO, GRN and Cancelled PO lines of one company, for your own checking. Read-only — cannot be imported back.</p>
      <label>Company</label><select id="bkXCo" onchange="renderBackupMonths()">${has ? bkCompanyOptions(false) : '<option>(no data yet)</option>'}</select>
      <label>Months</label><select id="bkXMon"><option value="ALL">All months</option>${ms.slice().reverse().map(m => `<option value="${m}">${monApos(m, true)}</option>`).join('')}</select>
      <button class="btn btn-excel" onclick="exportRawExcel()" ${has ? '' : 'disabled'}>📊 Export Excel</button></div>
  </div>
  <div class="bk-last ${last ? '' : 'none'}">${last ? `✓ Last backup downloaded on this PC: <b>${esc(last.at)}</b> by <b>${esc(last.by)}</b> (${esc(last.scope)})` : 'No backup downloaded on this PC yet. Tip: download one every month after uploading.'}</div>`;
}
function renderBackupMonths() {
  const k = document.getElementById('bkXCo').value, co = db.companies[k]; if (!co) return;
  document.getElementById('bkXMon').innerHTML = '<option value="ALL">All months</option>' + bkMonths(co).reverse().map(m => `<option value="${m}">${monApos(m, true)}</option>`).join('');
}
async function downloadBackup() {
  if (!currentUser || !currentUser.admin) return alert('Only the admin can download a backup.');
  const pw = document.getElementById('bkPw').value, pw2 = document.getElementById('bkPw2').value;
  if (pw.length < 6) return alert('Choose a backup password of at least 6 characters.');
  if (pw !== pw2) return alert('The two passwords are not the same.');
  const sc = document.getElementById('bkCo').value;
  const keys = sc === '__ALL__' ? Object.keys(db.companies) : [sc];
  const companies = {}; keys.forEach(k => { companies[k] = db.companies[k]; });
  const made = new Date().toISOString();
  const payload = { format: BK_FORMAT, v: 1, made, madeText: nowText(), by: currentUser.name || currentUser.username, companies };
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveCloudKey(pw, salt);
  const zipped = await streamBytes(new TextEncoder().encode(JSON.stringify(payload)), new CompressionStream('gzip'));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, zipped));
  const file = JSON.stringify({ format: BK_FORMAT, v: 1, lock: 'AES-GCM, PBKDF2-SHA256 250000', made, salt: b64.enc(salt), iv: b64.enc(iv), data: b64.enc(ct) });
  const scopeName = sc === '__ALL__' ? 'All-companies' : companyDisplay(sc).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([file], { type: 'application/json' }));
  a.download = `PO-Portal-Backup_${scopeName}_${made.slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  try { localStorage.setItem(BK_LAST_KEY, JSON.stringify({ at: nowText(), by: currentUser.name || currentUser.username, scope: sc === '__ALL__' ? `All companies (${keys.length})` : companyDisplay(sc) })); } catch (e) {}
  document.getElementById('bkPw').value = ''; document.getElementById('bkPw2').value = '';
  renderBackupCard();
  showToast('Backup downloaded. Keep the file and its password safe — without the password it cannot be opened.');
}
async function openBackupFile(ev) {
  const f = ev.target.files && ev.target.files[0]; ev.target.value = '';
  if (!f) return;
  if (!currentUser || !currentUser.admin) return alert('Only the admin can restore a backup.');
  const pw = document.getElementById('bkPwOpen').value;
  let wrap, bk;
  try { wrap = JSON.parse(await f.text()); } catch (e) { return alert('This is not a portal backup file.'); }
  if (!wrap || wrap.format !== BK_FORMAT) return alert('This is not a portal backup file.');
  try {
    const key = await deriveCloudKey(pw, b64.dec(wrap.salt));
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(wrap.iv) }, key, b64.dec(wrap.data)));
    bk = JSON.parse(new TextDecoder().decode(await streamBytes(plain, new DecompressionStream('gzip'))));
  } catch (e) { return alert('Wrong backup password, or the file is damaged.'); }
  const keys = Object.keys(bk.companies || {}).sort();
  if (!keys.length) return alert('This backup has no company data.');
  const sumPO = c => (c.po || []).reduce((a, p) => a + (+p.lineSubTotal || 0), 0);
  const range = c => { const m = bkMonths(c); return m.length ? (m[0] === m[m.length - 1] ? monApos(m[0], true) : `${monApos(m[0], true)} – ${monApos(m[m.length - 1], true)}`) : '-'; };
  let lose = [];
  const rows = keys.map(k => {
    const b = bk.companies[k], n = db.companies[k];
    const np = n ? n.po.length : 0, ng = n ? n.grn.length : 0, d = sumPO(b) - (n ? sumPO(n) : 0);
    if (n && (np > b.po.length || ng > (b.grn || []).length)) lose.push(companyDisplay(k));
    return `<tr><td>${esc(companyDisplay(k))}${n ? '' : ' <span class="gk gk-new">new</span>'}</td><td>${range(b)}</td>
      <td>${np.toLocaleString()} → <b>${b.po.length.toLocaleString()}</b></td><td>${ng.toLocaleString()} → <b>${(b.grn || []).length.toLocaleString()}</b></td>
      <td>${Math.abs(d) < 0.005 ? 'same' : (d < 0 ? '−' : '+') + rm(Math.abs(d))}</td></tr>`;
  }).join('');
  const others = Object.keys(db.companies).filter(k => !bk.companies[k]);
  const html = `<div><b>File:</b> ${esc(f.name)} · made <b>${esc(bk.madeText || dateDMY((bk.made || '').slice(0, 10)))}</b> by ${esc(bk.by || '-')} · ${keys.length} compan${keys.length === 1 ? 'y' : 'ies'}</div>
    <table class="bk-table"><thead><tr><th>Company</th><th>Months in backup</th><th>PO lines now → backup</th><th>GRN lines now → backup</th><th>PO amount vs now</th></tr></thead><tbody>${rows}</tbody></table>
    <label class="bk-opt"><input type="radio" name="bkScope" value="__ALL__" checked> <b>Restore everything</b> in this backup (${keys.length} compan${keys.length === 1 ? 'y' : 'ies'})</label>
    ${keys.length > 1 ? `<label class="bk-opt"><input type="radio" name="bkScope" value="__ONE__"> Restore one company only: <select id="bkOne">${keys.map(k => `<option value="${esc(k)}">${esc(companyDisplay(k))}</option>`).join('')}</select></label>` : ''}
    ${lose.length ? `<div class="bk-warn">⚠ The saved data now has <b>more lines</b> than this backup for ${esc(lose.join(', '))}. Restoring removes those newer lines (e.g. uploads made after the backup).</div>` : ''}
    ${others.length ? `<div class="muted small-text" style="margin-top:6px">Not in this backup, so kept as they are: ${esc(others.map(companyDisplay).join(', '))}.</div>` : ''}
    <div class="muted small-text" style="margin-top:6px">After Accept, click 💾 Save to Cloud. GitHub still keeps the current version, so it can be undone.</div>`;
  const v = await upDialog('⬆ Restore backup — review', html, [{ label: 'Cancel', value: 'no', cls: 'btn-print' }, { label: '✓ Accept restore', value: 'yes', cls: 'bk-orange' }]);
  if (v !== 'yes') return;
  const sel = document.querySelector('input[name=bkScope]:checked');
  const pick = sel && sel.value === '__ONE__' ? [document.getElementById('bkOne').value] : keys;
  pick.forEach(k => {
    db.companies[k] = Object.assign(emptyCompany(), bk.companies[k]);
    logAction(`Restored ${companyDisplay(k)} from backup made ${bk.madeText || (bk.made || '').slice(0, 10)}`, k, 'all');
  });
  if (!db.current || !db.companies[db.current]) db.current = pick[0];
  store = db.companies[db.current];
  dirty = true;
  afterDataChange();
  renderCompanyUI(); renderSyncBar(); renderActivityLog(); renderBackupCard();
  document.getElementById('bkPwOpen').value = '';
  showToast(`Restored ${pick.length} compan${pick.length === 1 ? 'y' : 'ies'}. Click 💾 Save to Cloud so everyone sees it.`);
}
function exportRawExcel() {
  if (typeof XLSX === 'undefined') return alert('Excel library did not load. Check your internet connection and refresh the page.');
  const k = document.getElementById('bkXCo').value, co = db.companies[k], mon = document.getElementById('bkXMon').value;
  if (!co) return;
  const inM = iso => mon === 'ALL' || (iso && isoToYYMM(iso) === mon);
  const r2 = n => Math.round((+n || 0) * 100) / 100;
  const po = co.po.filter(p => inM(p.iso)).map(p => ({ 'PO No': p.docNo, 'PO Date': p.docDate, 'Creditor Code': p.creditorCode, 'Creditor Name': p.creditorName, 'Item Code': p.itemCode, 'Description': p.description, 'Location': p.loc, 'Qty': +p.qty || 0, 'Unit Price': +p.unitPrice || 0, 'Discount': p.disc || '', 'Sub Total (RM)': r2(p.lineSubTotal) }));
  const grn = co.grn.filter(g => inM(g.grnIso)).map(g => ({ 'GRN No': g.grnNo, 'GRN Date': g.grnDate, 'PO No': g.poNo || '', 'PO Date': g.poDate || '', 'Creditor Code': g.creditorCode, 'Creditor Name': g.creditorName, 'Item Code': g.itemCode, 'Description': g.description, 'Location': g.loc, 'Qty': +g.qty || 0, 'Unit Price': +g.unitPrice || 0, 'Sub Total (RM)': r2(g.subTotal) }));
  const cx = (co.cxLines || []).filter(x => inM(x.iso)).map(x => ({ 'Cancel Doc': x.doc, 'Cancel Date': x.date, 'PO No': x.poNo, 'Creditor Code': x.creditorCode, 'Creditor Name': x.creditorName, 'Item Code': x.itemCode, 'Description': x.description, 'Location': x.loc, 'Qty': +x.qty || 0, 'Unit Price': +x.unitPrice || 0, 'Amount (RM)': r2(x.amt) }));
  if (!po.length && !grn.length && !cx.length) return alert('No lines for this month.');
  const wb = XLSX.utils.book_new();
  [['PO lines', po], ['GRN lines', grn], ['Cancelled PO', cx]].forEach(([n, rows]) => {
    if (!rows.length) return;
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = Object.keys(rows[0]).map(c => ({ wch: Math.min(50, Math.max(c.length, ...rows.slice(0, 300).map(r => String(r[c] == null ? '' : r[c]).length)) + 2) }));
    XLSX.utils.book_append_sheet(wb, ws, n);
  });
  XLSX.writeFile(wb, `PO-Portal-Data_${companyDisplay(k).replace(/[^A-Za-z0-9]+/g, '_').slice(0, 30)}_${mon === 'ALL' ? 'all-months' : monApos(mon, true).replace(/[^A-Za-z0-9]+/g, '')}.xlsx`);
}

// ----------------------------------------------------
// Start up
// ----------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  if (cloudMode) document.body.classList.add('cloud-mode'); else await detectServer();
  await loadAllData();
  if (!serverMode && !cloudMode) { try { folderHandle = (await idbGet(HANDLE_KEY)) || null; } catch (e) {} }
  rebuildCombined();
  restoreLocSel();

  if (db.current) setCompanyName(companyDisplay(db.current));
  else { try { const n = localStorage.getItem(COMPANY_KEY); if (n) setCompanyName(n); } catch (e) {} }

  refreshLocationUI();
  if (rawPOList.length || rawGRNList.length) {
    setDefaultDateRange();
    recalculateTransfers();
    refreshLocationUI();
    updateUploadSummary();
    switchNavTab('tab-po-grn-summary');
  } else {
    updateUploadSummary();
    switchNavTab('tab-upload');
  }
  const vEl = document.getElementById('appVersion');
  if (vEl) vEl.innerText = APP_VERSION;
  renderSyncBar();
  if (!usersDb.users.length) { if (cloudMode && !ghToken() && (window.__cloudEmpty || window.__cloudError)) showCloudStartScreen(); else showAuth('setup'); }
  else if (!restoreSession()) showAuth('login');
  renderUserBox();
  renderActivityLog();
});

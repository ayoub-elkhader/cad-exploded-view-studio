/* CAD Studio - user interface (catalogue, verified computation, bill of materials, checks, explosion, sharing). */
'use strict';
const $ = id => document.getElementById(id);
const fmt = (n, d = 1) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
const fmtMass = g => g == null ? '—' : g < 1 ? fmt(g * 1000, 0) + ' mg' : g < 1000 ? fmt(g, 1) + ' g' : fmt(g / 1000, 2) + ' kg';
const S = { entry: null, scene: null, items: [], offset: 0, names: {}, epoch: 0, loaded: false };
let studio = null;

async function api(url, body) {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const d = await r.json(); if (!r.ok) throw Error(d.error || 'Service unavailable'); return d;
}
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

// ------------------------------------------------------------------ catalogue
let catEpoch = 0;
async function catalog(append = false) {
  const ep = ++catEpoch; if (!append) { S.offset = 0; S.items = []; }
  try {
    const d = await api('/api/catalog?' + new URLSearchParams({ source: $('source').value, q: $('search').value, offset: S.offset }));
    if (ep !== catEpoch) return; S.names = d.sources;
    if ($('source').options.length === 1) for (const [k, n] of Object.entries(d.sources)) { const o = el('option', '', `${n} · ${fmt(d.counts[k], 0)}`); o.value = k; $('source').append(o); }
    S.items.push(...d.items); S.offset = S.items.length; $('count').textContent = fmt(d.total, 0) + ' assemblies'; $('more').hidden = S.offset >= d.total; renderCatalog();
  } catch (e) { $('count').textContent = e.message; }
}
function renderCatalog() {
  const f = document.createDocumentFragment();
  for (const it of S.items) { const b = el('button', 'item' + (S.entry?.id === it.id ? ' on' : '')); b.append(el('strong', '', it.case), el('small', '', S.names[it.source] + ' · ' + it.kind)); b.onclick = () => open(it); f.append(b); }
  if (!S.items.length) f.append(el('p', 'muted small', 'No matching assembly.'));
  $('catalog').replaceChildren(f);
}

// ------------------------------------------------------------------ computation
async function open(entry) {
  const ep = ++S.epoch; S.entry = entry; S.loaded = false; S.scene = null; renderCatalog();
  $('model-name').textContent = entry.case; $('src-name').textContent = S.names[entry.source] || entry.source;
  $('empty').hidden = true; $('job').hidden = false; $('job-text').textContent = 'Preparing the model…'; $('progress').value = 0; $('cancel').hidden = false;
  $('bom').replaceChildren(); $('sel').hidden = true; $('dims').textContent = ''; setControls();
  history.replaceState(null, '', '?' + new URLSearchParams({ source: entry.source, case: entry.case }));
  try { await api('/api/open', { id: entry.id }); poll(ep); } catch (e) { $('job-text').textContent = e.message; }
}
async function poll(ep) {
  if (ep !== S.epoch) return;
  try {
    const s = await api('/api/status/' + S.entry.id); if (ep !== S.epoch) return;
    $('job-text').textContent = s.message; $('progress').value = s.progress || 0;
    $('job-time').textContent = s.started ? `Local computation · ${fmt((Date.now() / 1000 - s.started) / 60, 1)} min` : 'Large assemblies can take several minutes.';
    $('cancel').hidden = !['running', 'queued'].includes(s.state);
    if (s.scene_ready && (!S.loaded || s.state === 'done')) {
      const sc = await api('/api/scene/' + S.entry.id); if (ep !== S.epoch) return;
      if (!S.loaded) { S.scene = sc; studio.load(sc); S.loaded = true; renderBOM(); applyInitialView(); }
      else { S.scene = sc; refreshVectors(sc); }
      renderChecks(); setControls(); renderDims();
    }
    if (['done', 'error', 'timeout', 'cancelled'].includes(s.state)) { if (s.state === 'done') $('job').hidden = true; else $('cancel').hidden = true; return; }
  } catch (e) { $('job-text').textContent = 'Connection lost · retrying…'; }
  setTimeout(() => poll(ep), 1300);
}
function refreshVectors(sc) { // the final plan (after any repair) replaces the provisional one
  const cam = studio.cameraState(), frac = studio.fraction, sel = studio.selected; studio.load(sc); studio.setCamera(cam, false); studio.setFraction(frac); if (sel) studio.select(sel); renderBOM();
}
function applyInitialView() {
  const q = new URLSearchParams(location.search);
  if (q.get('view')) studio.view(q.get('view'), false);
}

// ------------------------------------------------------------------ bill of materials and checks
function renderBOM() {
  const f = document.createDocumentFragment(), sc = S.scene;
  for (const p of sc.parts) {
    const tr = el('tr'); tr.dataset.id = p.id;
    const c0 = el('td'); const r = el('span', 'ref', p.ref); r.style.borderColor = new THREE.Color().setHSL((p.ref * .618034) % 1, .55, .5).getStyle(); c0.append(r);
    const c1 = el('td'); c1.append(el('strong', '', p.name), el('small', '', p.material));
    const c2 = el('td', '', p.dims.map(x => fmt(x)).join(' × ')); const c3 = el('td', '', fmtMass(p.mass_g));
    tr.append(c0, c1, c2, c3); tr.onclick = () => studio.select(p.id); f.append(tr);
  }
  $('bom').replaceChildren(f); $('bom-count').textContent = sc.parts.length + ' part' + (sc.parts.length > 1 ? 's' : '');
  const masses = sc.parts.map(p => p.mass_g).filter(x => x != null);
  if (masses.length) $('bom-count').textContent += ` · estimated mass ${fmtMass(masses.reduce((a, b) => a + b, 0))} (${masses.length} part${masses.length > 1 ? 's' : ''} with a declared material)`;
  $('csv').disabled = false;
}
const LABEL = { pass: ['Checked ✓', 'ok'], blocked: ['Interference', 'bad'], not_found: ['No order found', 'warn'], unknown: ['Inconclusive', 'warn'],
  display_conflict: ['Displayed path in conflict', 'warn'], not_applicable: ['Not applicable', ''], pending: ['Running…', ''] };
function renderChecks() {
  const v = S.scene?.validation || {}; const set = (id, s, extra) => { const [t, c] = LABEL[s] || [s || '—', '']; $(id).textContent = t + (extra || ''); $(id).className = c; };
  set('c-final', v.final);
  set('c-sim', v.simultaneous, v.sim_free_from != null ? ` · from ${Math.round(v.sim_free_from * 100)} %` : '');
  set('c-order', v.sequential === 'display_conflict' ? 'pass' : v.sequential, S.scene?.order?.length ? ` · ${S.scene.order.length} parts` : '');
  set('c-seq', v.sequential);
  $('c-origin').textContent = (S.scene?.plan_origin || '') + (v.oracle_version ? ` · oracle ${v.oracle_version}` : '');
  $('c-scope').textContent = S.scene?.scope || '';
  // checked zone on the slider
  const f0 = v.sim_free_from; $('zone').style.background = (v.final === 'pass' && f0 != null)
    ? `linear-gradient(90deg,#eef1f4 0,#eef1f4 1%,var(--zone-bad) 1%,var(--zone-bad) ${f0 * 100}%,var(--zone-ok) ${f0 * 100}%)` : '#eef1f4';
}
function renderDims() {
  if (!S.scene) return; const d = studio.dims, e = studio.exploded();
  $('dims').innerHTML = `Assembly: ${d.map(x => fmt(x, 0)).join(' × ')} mm` + (studio.fraction > 0 || studio.mode === 'seq' ? `<br>Displayed view: ${e.map(x => fmt(x, 0)).join(' × ')} mm` : '');
}
// sampled fraction k/STEPS on the checked side (every fraction >= sim_free_from is checked), with a margin
function compactFraction() {
  const N = 24, k0 = Math.round(S.scene.validation.sim_free_from * N);
  return Math.min(N, Math.max(k0 + 2, Math.ceil(k0 * 1.5))) / N;
}
function seqAllowed() { return S.scene?.validation?.sequential === 'pass' && (S.scene.order || []).length > 0; }
function stateText() {
  const v = S.scene?.validation || {}; const st = $('state');
  if (!S.scene) { st.textContent = '—'; st.className = 'state'; return; }
  if (studio.mode === 'seq') { const n = S.scene.order.length, k = Math.min(n, Math.floor(studio.seq + 1e-4)); st.textContent = `${k} / ${n} parts removed`; st.className = 'state ok';
    $('seq-label').textContent = k === 0 ? 'Assembled' : `Step ${k}: ${S.scene.parts.find(p => String(p.id) === S.scene.order[k - 1])?.name || ''}`; return; }
  const f = studio.fraction, pct = Math.round(f * 100);
  if (f === 0) { st.textContent = 'Assembled'; st.className = 'state'; }
  else if (v.final !== 'pass') { st.textContent = `${pct} % · not verified`; st.className = 'state warn'; }
  else if (v.sim_free_from != null && f >= v.sim_free_from - 1e-9) { st.textContent = `${pct} % · conflict-free view ✓`; st.className = 'state ok'; }
  else { st.textContent = `${pct} % · state not checked`; st.className = 'state warn'; }
}
function setControls() {
  const has = !!S.scene && S.scene.parts.length > 1, ok = has && S.scene.validation?.final === 'pass';
  $('slider').disabled = !has; $('b-exploded').disabled = !ok; $('b-compact').disabled = !(ok && S.scene.validation?.sim_free_from != null); $('b-play').disabled = !ok; $('b-assembled').disabled = !has;
  $('mode-seq').disabled = !seqAllowed(); $('png').disabled = !S.scene; $('share').disabled = !S.scene || S.scene.validation?.final === 'pending';
  $('mode-seq').title = seqAllowed() ? '' : (S.scene?.validation?.sequential === 'display_conflict' ? 'Animation not played: a moving part passes too close to a part already removed.' : 'No disassembly order available.');
  $('seq-row').hidden = studio.mode !== 'seq'; stateText();
}

// ------------------------------------------------------------------ events
function bind() {
  studio = StudioCore.create($('canvas'), $('overlay'));
  studio.on('select', id => {
    for (const tr of $('bom').rows) tr.classList.toggle('on', tr.dataset.id === String(id));
    const p = id ? studio.partInfo(id) : null; $('sel').hidden = !p; if (!p) return;
    $('sel-name').textContent = `${p.ref} · ${p.name}`; $('sel-mat').textContent = p.material + (p.material_known ? ' (declared)' : '');
    $('sel-dims').textContent = p.dims.map(x => fmt(x)).join(' × ') + ' mm'; $('sel-vol').textContent = fmt(p.volume_mm3) + ' mm³';
    $('sel-mass').textContent = p.mass_g != null ? fmtMass(p.mass_g) + ` (ρ ${p.density_g_cm3} g/cm³)` : 'material not declared';
    const k = (S.scene.order || []).indexOf(String(id)); $('sel-order').textContent = k >= 0 ? `${k + 1} / ${S.scene.order.length}` : '—';
    const row = [...$('bom').rows].find(r => r.dataset.id === String(id)); if (row) row.scrollIntoView({ block: 'nearest' });
  });
  studio.on('progress', () => { syncSlider(); stateText(); renderDims(); });
  for (const b of document.querySelectorAll('[data-view]')) b.onclick = () => studio.view(b.dataset.view);
  $('fit').onclick = () => studio.fit(studio.fraction > 0 || studio.mode === 'seq');
  $('slider').oninput = () => { const v = $('slider').value / 1000; if (studio.mode === 'seq') studio.setSeq(v * S.scene.order.length); else studio.setFraction(v); stateText(); renderDims(); };
  $('b-assembled').onclick = () => { if (studio.mode === 'seq') studio.animateSeq(0, .8); else studio.animateFraction(0, 1.2); };
  $('b-exploded').onclick = () => { setMode('sim'); studio.animateFraction(1, 1.6, () => studio.fit(true)); };
  $('b-compact').onclick = () => { setMode('sim'); studio.animateFraction(compactFraction(), 1.4, () => studio.fit(false)); };
  $('up').onchange = () => { studio.setUpAxis($('up').value); renderDims(); };
  $('b-play').onclick = () => {
    if (studio.mode === 'seq') { const n = S.scene.order.length; studio.setSeq(0); studio.fit(true); studio.animateSeq(n, Math.max(2, n * .9)); }
    else { studio.setFraction(0); studio.animateFraction(1, 2.4); }
  };
  $('mode-sim').onclick = () => setMode('sim'); $('mode-seq').onclick = () => setMode('seq');
  $('prev').onclick = () => { const k = Math.ceil(studio.seq - 1e-4) - 1; studio.animateSeq(Math.max(0, k), .7, () => studio.fit(false)); };
  $('next').onclick = () => { const k = Math.floor(studio.seq + 1e-4) + 1; studio.animateSeq(Math.min(S.scene.order.length, k), .7, () => studio.fit(false)); };
  $('cancel').onclick = async () => { if (S.entry) await api('/api/cancel', { id: S.entry.id }); };
  $('source').onchange = () => catalog(); let deb; $('search').oninput = () => { clearTimeout(deb); deb = setTimeout(() => catalog(), 220); }; $('more').onclick = () => catalog(true);
  for (const t of document.querySelectorAll('[data-tab]')) t.onclick = () => { for (const x of document.querySelectorAll('[data-tab]')) x.classList.toggle('on', x === t); for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== t.dataset.tab; };
  $('color').onchange = () => studio.setColorMode($('color').value);
  for (const c of document.querySelectorAll('[data-opt]')) c.onchange = () => studio.setOption(c.dataset.opt, c.checked);
  $('isolate').onclick = () => { const on = $('isolate').textContent === 'Isolate'; studio.setIsolate(on); $('isolate').textContent = on ? 'Show all' : 'Isolate'; studio.fit(studio.fraction > 0); };
  $('unsel').onclick = () => { studio.setIsolate(false); $('isolate').textContent = 'Isolate'; studio.select(null); };
  $('goto').onclick = () => { const k = (S.scene.order || []).indexOf(String(studio.selected)); if (k >= 0 && seqAllowed()) { setMode('seq'); studio.animateSeq(k + 1, .9); } };
  $('csv').onclick = exportCSV; $('png').onclick = exportPNG; $('share').onclick = exportShare;
}
function setMode(m) {
  if (m === 'seq' && !seqAllowed()) return;
  $('mode-sim').classList.toggle('on', m === 'sim'); $('mode-seq').classList.toggle('on', m === 'seq');
  if (m === 'seq') studio.setSeq(0); else studio.setFraction(studio.mode === 'seq' ? 0 : studio.fraction);
  syncSlider(); setControls();
}
function syncSlider() { const v = studio.mode === 'seq' ? studio.seq / Math.max(1, S.scene?.order?.length || 1) : studio.fraction; $('slider').value = Math.round(v * 1000); }

// ------------------------------------------------------------------ exports
function caption() {
  const v = S.scene.validation || {}; const parts = [`${S.scene.parts.length} parts`, S.names[S.entry.source] || S.entry.source];
  if (v.final === 'pass') parts.push('exploded view verified (oracle ' + (v.oracle_version || 'v2') + ')');
  return parts.join(' · ');
}
async function exportPNG() {
  try {
    const url = studio.snapshot({ scale: 3, title: S.entry.case, subtitle: caption() });
    const name = (studio.mode === 'seq' ? 'step_' + Math.round(studio.seq) : 'explosion_' + Math.round(studio.fraction * 100));
    const r = await api('/api/snapshot', { id: S.entry.id, name, png: url });
    $('share-msg').innerHTML = `Image saved · <a href="${r.url}" target="_blank">open</a> · <a href="${r.url}?download=1">download</a>`;
  } catch (e) { $('share-msg').textContent = 'Export failed: ' + e.message; }
}
async function exportShare() {
  try {
    $('share-msg').textContent = 'Preparing the standalone page…';
    const settings = { fraction: studio.fraction, mode: studio.mode, seq: studio.seq, camera: studio.cameraState(), color: studio.colorMode, options: studio.options(), up: studio.upAxis };
    const r = await api('/api/share', { id: S.entry.id, settings });
    $('share-msg').innerHTML = `Standalone page ready (${fmt(r.size_mb, 1)} MB) · <a href="${r.url}" target="_blank">open</a> · <a href="${r.url}?download=1">download</a>`;
  } catch (e) { $('share-msg').textContent = 'Sharing failed: ' + e.message; }
}
function exportCSV() {
  const esc = s => '"' + String(s ?? '').replaceAll('"', '""') + '"';
  const rows = [['Item', 'Id', 'Name', 'Material', 'Size (mm)', 'Volume (mm³)', 'Estimated mass (g)', 'Disassembly order'],
    ...S.scene.parts.map(p => [p.ref, p.id, p.name, p.material, p.dims.join(' x '), p.volume_mm3, p.mass_g ?? '', (S.scene.order || []).indexOf(String(p.id)) + 1 || ''])];
  const blob = new Blob(['﻿' + rows.map(r => r.map(esc).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = el('a'); a.href = URL.createObjectURL(blob); a.download = 'bom_' + S.entry.case.replace(/[^\w-]/g, '_') + '.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ------------------------------------------------------------------ start-up
try {
  bind(); setControls();
  catalog().then(async () => {
    const q = new URLSearchParams(location.search);
    if (q.get('case')) { const d = await api('/api/catalog?' + new URLSearchParams({ source: q.get('source') || '', q: q.get('case') })); const hit = d.items.find(x => x.case === q.get('case')); if (hit) open(hit); }
  });
  fetch('/api/health').then(r => r.json()).then(h => $('health').textContent = `${fmt(h.catalog, 0)} assemblies available · local computation`).catch(() => {});
} catch (e) { $('empty').innerHTML = '<p>' + e.message + '</p>'; }

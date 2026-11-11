/* Shared page: offline viewing of an exploded view exported by CAD Studio. */
'use strict';
(function () {
  const $ = id => document.getElementById(id);
  const fmt = (n, d = 1) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
  const v = DATA.validation || {}, s = DATA.settings || {};
  const studio = StudioCore.create($('canvas'), $('overlay'));
  if (s.up) studio.setUpAxis(s.up);
  studio.load(DATA);
  $('title').textContent = DATA.name;
  $('sub').textContent = `${DATA.parts.length} parts · ${DATA.source} · exported ${DATA.exported}`;
  const badge = (txt, ok) => { const b = document.createElement('span'); b.className = 'badge' + (ok ? ' ok' : ' warn'); b.textContent = txt; $('badges').append(b); };
  badge(v.final === 'pass' ? 'Exploded view verified (oracle ' + (v.oracle_version || 'v2') + ')' : 'Exploded view not verified', v.final === 'pass');
  if (v.sim_free_from != null) badge(`Conflict-free from ${Math.round(v.sim_free_from * 100)} % of the displacement`, true);
  if ((DATA.order || []).length) badge(`Disassembly order: ${DATA.order.length} parts`, true);
  $('scope').textContent = DATA.scope || '';
  // bill of materials
  for (const p of DATA.parts) {
    const tr = document.createElement('tr'); tr.dataset.id = p.id;
    tr.innerHTML = `<td><b>${p.ref}</b></td><td>${String(p.name).replace(/</g, '&lt;')}<small>${String(p.material).replace(/</g, '&lt;')}</small></td><td>${p.dims.map(x => fmt(x)).join(' × ')}</td>`;
    tr.onclick = () => studio.select(p.id); $('bom').append(tr);
  }
  studio.on('select', id => { for (const tr of $('bom').rows) tr.classList.toggle('on', tr.dataset.id === String(id)); });
  // initial state = exported view
  if (s.color) { studio.setColorMode(s.color); $('color').value = s.color; }
  if (s.options) for (const [k, val] of Object.entries(s.options)) studio.setOption(k, val);
  $('o-balloons').checked = studio.option('balloons'); $('o-traces').checked = studio.option('traces');
  studio.setFraction(s.mode === 'seq' ? 1 : (s.fraction != null ? s.fraction : 1));
  if (s.camera) studio.setCamera(s.camera, false); else studio.fit(true, false);
  function state() {
    const f = studio.fraction, pct = Math.round(f * 100); $('slider').value = Math.round(f * 1000);
    $('state').textContent = f === 0 ? 'Assembled' : (v.final === 'pass' && v.sim_free_from != null && f >= v.sim_free_from - 1e-9) ? `${pct} % · conflict-free view` : `${pct} % · intermediate state, not checked`;
  }
  state();
  studio.on('progress', state);
  $('slider').oninput = () => { studio.setFraction($('slider').value / 1000); state(); };
  $('asm').onclick = () => studio.animateFraction(0, 1.2);
  $('exp').onclick = () => studio.animateFraction(1, 1.4, () => studio.fit(true));
  for (const b of document.querySelectorAll('[data-view]')) b.onclick = () => studio.view(b.dataset.view);
  $('fit').onclick = () => studio.fit(studio.fraction > 0);
  $('o-balloons').onchange = () => studio.setOption('balloons', $('o-balloons').checked);
  $('o-traces').onchange = () => studio.setOption('traces', $('o-traces').checked);
  $('color').onchange = () => studio.setColorMode($('color').value);
})();

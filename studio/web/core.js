/* CAD Studio - rendering engine shared by the studio and the exported page. Three.js r128.
   Free trackball camera (no lock at the poles), environment lighting, shadows,
   simultaneous or part-by-part explosion, trajectory lines, numbered balloons,
   scale bar, composed PNG export (balloons, scale, title). */
'use strict';
const StudioCore = (function () {
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
  function gridStep(s) { const raw = s / 10, p = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / p; return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p; }
  function ease(k) { return k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; }
  function niceScale(ppm) { // bar length (mm) that spans 70 to 180 px
    const series = []; for (let e = -3; e <= 7; e++) for (const m of [1, 2, 5]) series.push(m * Math.pow(10, e));
    let best = series[0]; for (const s of series) { const px = s * ppm; if (px >= 70 && px <= 180) { best = s; break; } if (px < 70) best = s; }
    return best;
  }
  function fmtLen(mm) { return mm >= 1000 ? (mm / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' m' : mm >= 10 ? (mm / 10).toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' cm' : mm.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' mm'; }

  function create(canvas, overlay, opts) {
    opts = Object.assign({ interactive: true }, opts || {});
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    // colours given in sRGB then linearised (partColor); neutral tone mapping keeps saturation
    renderer.toneMapping = THREE.LinearToneMapping; renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0xffffff);
    // environment: studio gradient
    (function env() {
      const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
      const grd = g.createLinearGradient(0, 0, 0, 256); grd.addColorStop(0, '#ffffff'); grd.addColorStop(.45, '#d8dee5'); grd.addColorStop(1, '#7d858f');
      g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
      const t = new THREE.CanvasTexture(c); t.mapping = THREE.EquirectangularReflectionMapping;
      const pm = new THREE.PMREMGenerator(renderer); scene.environment = pm.fromEquirectangular(t).texture; t.dispose(); pm.dispose();
    })();
    const hemi = new THREE.HemisphereLight(0xffffff, 0x8a96a3, .35); scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.0); key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0004; scene.add(key); scene.add(key.target);
    const fill = new THREE.DirectionalLight(0xe6f0ff, .32); scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, .28); scene.add(rim);
    const camera = new THREE.PerspectiveCamera(32, 1, .1, 1e7); camera.up.set(0, 0, 1);
    const root = new THREE.Group(); scene.add(root);
    const traces = new THREE.Group(); scene.add(traces);
    let ground = null, grid = null;
    const target = V3(0, 0, 0);
    const st = { parts: [], byId: {}, order: [], mode: 'sim', fraction: 0, seq: 0, color: 'part', dirty: true,
      opt: { edges: true, traces: true, balloons: true, shadows: true, grid: false, ghost: true },
      selected: null, hovered: null, isolate: false, up: 'z', data: null, span: 100, dims: [0, 0, 0], center: V3(0, 0, 0), tweens: {}, cb: {} };

    // ------------------------------------------------------------------ loading
    function clear() {
      for (const p of st.parts) { root.remove(p.mesh); p.mesh.geometry.dispose(); p.mesh.material.dispose(); p.edges.geometry.dispose(); p.edges.material.dispose(); traces.remove(p.trace); p.trace.geometry.dispose(); }
      st.parts = []; st.byId = {}; if (ground) { scene.remove(ground); ground = null; } if (grid) { scene.remove(grid); grid = null; }
      if (overlay) overlay.querySelectorAll('.sc-balloon').forEach(e => e.remove());
    }
    // vertical axis of the file: 'z' (default) or 'y' (+90 deg rotation about X: y -> z)
    function upright(data) {
      if (st.up !== 'y') return data;
      const rot = a => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i += 3) { o[i] = a[i]; o[i + 1] = -a[i + 2]; o[i + 2] = a[i + 1]; } return o; };
      return Object.assign({}, data, { parts: data.parts.map(p => Object.assign({}, p, { verts: rot(p.verts), vec: p.vec ? [p.vec[0], -p.vec[2], p.vec[1]] : p.vec })) });
    }
    function load(raw) {
      clear(); st.data = raw; const data = upright(raw); st.order = data.order || [];
      const box = new THREE.Box3();
      for (const p of data.parts) for (let i = 0; i < p.verts.length; i += 3) box.expandByPoint(V3(p.verts[i], p.verts[i + 1], p.verts[i + 2]));
      if (box.isEmpty()) throw Error('No displayable mesh.');
      box.getCenter(st.center); const size = box.getSize(V3()); st.dims = [size.x, size.y, size.z]; st.span = Math.max(size.length(), 1);
      let minZ = box.min.z - st.center.z;
      const dash = st.span / 70;
      data.parts.forEach(p => {
        const geo = new THREE.BufferGeometry(); const n = p.verts.length; const arr = new Float32Array(n);
        for (let i = 0; i < n; i += 3) { arr[i] = p.verts[i] - st.center.x; arr[i + 1] = p.verts[i + 1] - st.center.y; arr[i + 2] = p.verts[i + 2] - st.center.z; }
        geo.setAttribute('position', new THREE.BufferAttribute(arr, 3)); geo.setIndex(p.idx); geo.computeVertexNormals(); geo.computeBoundingBox();
        const mat = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: .1, roughness: .5, envMapIntensity: .55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
        const mesh = new THREE.Mesh(geo, mat); mesh.castShadow = true; mesh.receiveShadow = true;
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 28), new THREE.LineBasicMaterial({ color: 0x23303a, transparent: true, opacity: .32 }));
        mesh.add(edges); root.add(mesh);
        const center = geo.boundingBox.getCenter(V3()); const vec = V3(p.vec[0], p.vec[1], p.vec[2]);
        minZ = Math.min(minZ, geo.boundingBox.min.z + Math.min(0, vec.z));
        const tg = new THREE.BufferGeometry().setFromPoints([center.clone(), center.clone()]);
        const trace = new THREE.Line(tg, new THREE.LineDashedMaterial({ color: 0x5b6b7a, dashSize: dash, gapSize: dash * .7, transparent: true, opacity: .75 }));
        traces.add(trace);
        const part = { data: p, id: p.id, ref: p.ref, mesh, edges, center, vec, trace, offset: V3(), visible: true };
        mesh.userData.part = part; st.parts.push(part); st.byId[p.id] = part;
        if (overlay) { const b = document.createElement('div'); b.className = 'sc-balloon'; b.textContent = p.ref; b.dataset.id = p.id; b.onclick = () => select(p.id); overlay.appendChild(b); part.balloon = b; }
      });
      // shadow ground and grid below the lowest position (exploded view included)
      const gs = st.span * 8;
      ground = new THREE.Mesh(new THREE.PlaneGeometry(gs, gs), new THREE.ShadowMaterial({ opacity: .16 })); ground.position.z = minZ - st.span * .02; ground.receiveShadow = true; scene.add(ground);
      const step = gridStep(st.span); grid = new THREE.GridHelper(Math.ceil(st.span * 3 / step) * step, Math.ceil(st.span * 3 / step), 0xc9d1d8, 0xe4e8ec); grid.rotation.x = Math.PI / 2; grid.position.z = ground.position.z + st.span * .001; grid.visible = st.opt.grid; scene.add(grid);
      st.gridStep = step;
      placeLights(); applyColors(); st.dirty = true; view('iso', false); fit(false, false);
    }
    function placeLights() {
      const s = st.span; key.position.set(s * 1.2, -s * 1.6, s * 2.4); key.target.position.set(0, 0, 0);
      const c = key.shadow.camera; c.left = -s * 2.5; c.right = s * 2.5; c.top = s * 2.5; c.bottom = -s * 2.5; c.near = s * .1; c.far = s * 8; c.updateProjectionMatrix();
      fill.position.set(-s * 2, s * .8, s * .6); rim.position.set(-s * .5, s * 2, -s * .8);
    }
    // ------------------------------------------------------------------ appearance
    function partColor(p) {
      let c;
      if (st.color === 'material') c = new THREE.Color(p.data.color || '#a5afbd');
      else if (st.color === 'mono') c = new THREE.Color(0xd5dbe1);
      else c = new THREE.Color().setHSL((p.ref * .618034) % 1, .62, .52);
      return c.convertSRGBToLinear();
    }
    function applyColors() {
      for (const p of st.parts) {
        const m = p.mesh.material; m.color.copy(partColor(p));
        m.metalness = st.color === 'material' ? (p.data.metalness || .1) : .08;
        const ghost = st.opt.ghost && st.selected && st.selected !== p.id;
        m.transparent = !!ghost; m.opacity = ghost ? .14 : 1; m.depthWrite = !ghost;
        m.emissive.set(st.selected === p.id ? 0x163f60 : st.hovered === p.id ? 0x0d2433 : 0x000000); m.emissiveIntensity = .35;
        p.edges.visible = st.opt.edges; p.edges.material.opacity = st.color === 'mono' ? .55 : .32;
        p.mesh.visible = !st.isolate || st.selected === p.id;
        p.mesh.castShadow = st.opt.shadows;
      }
      if (ground) ground.visible = st.opt.shadows; if (grid) grid.visible = st.opt.grid;
      key.castShadow = st.opt.shadows; st.dirty = true;
    }
    // ------------------------------------------------------------------ explosion
    function offsetOf(p) {
      if (st.mode === 'seq' && st.order.length) { const k = st.order.indexOf(String(p.id)); const t = k < 0 ? 0 : Math.max(0, Math.min(1, st.seq - k)); return t; }
      return st.fraction;
    }
    function applyPositions() {
      for (const p of st.parts) {
        const t = offsetOf(p); p.offset.copy(p.vec).multiplyScalar(t); p.mesh.position.copy(p.offset);
        const pos = p.trace.geometry.attributes.position; pos.setXYZ(0, p.center.x, p.center.y, p.center.z);
        pos.setXYZ(1, p.center.x + p.offset.x, p.center.y + p.offset.y, p.center.z + p.offset.z); pos.needsUpdate = true;
        p.trace.computeLineDistances(); p.trace.visible = st.opt.traces && t > 0.002 && p.mesh.visible && p.vec.lengthSq() > 0;
      }
    }
    // ------------------------------------------------------------------ camera trackball
    function lookFrom(dir, up, radius) { camera.up.copy(up).normalize(); camera.position.copy(target).addScaledVector(dir.clone().normalize(), radius); camera.lookAt(target); }
    function radius() { return camera.position.distanceTo(target); }
    function orthonormalize() { const eye = camera.position.clone().sub(target).normalize(); const up = camera.up.clone(); up.addScaledVector(eye, -up.dot(eye)).normalize(); camera.up.copy(up); }
    function rotate(dx, dy) {
      const k = .0075; const offset = camera.position.clone().sub(target); const eye = offset.clone().normalize();
      const right = new THREE.Vector3().crossVectors(camera.up, eye).normalize();
      const q = new THREE.Quaternion().setFromAxisAngle(camera.up.clone().normalize(), -dx * k).multiply(new THREE.Quaternion().setFromAxisAngle(right, -dy * k));
      offset.applyQuaternion(q); camera.up.applyQuaternion(q); camera.position.copy(target).add(offset); orthonormalize(); camera.lookAt(target); st.dirty = true;
    }
    function roll(angle) { const eye = camera.position.clone().sub(target).normalize(); camera.up.applyQuaternion(new THREE.Quaternion().setFromAxisAngle(eye, angle)); camera.lookAt(target); st.dirty = true; }
    function pixelsPerUnit() { return canvas.clientHeight / (2 * radius() * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)); }
    function pan(dx, dy) {
      camera.updateMatrixWorld(); const right = V3().setFromMatrixColumn(camera.matrixWorld, 0), up = V3().setFromMatrixColumn(camera.matrixWorld, 1);
      const f = 1 / pixelsPerUnit(); const d = right.multiplyScalar(-dx * f).add(up.multiplyScalar(dy * f)); target.add(d); camera.position.add(d); st.dirty = true;
    }
    function zoom(factor, cx, cy) {
      const r = radius(); const nr = Math.max(st.span * .01, Math.min(st.span * 80, r * factor));
      if (cx !== undefined) { // zoom to cursor: move the target towards the pointed location
        const rect = canvas.getBoundingClientRect(); const ndc = new THREE.Vector2((cx - rect.left) / rect.width * 2 - 1, -(cy - rect.top) / rect.height * 2 + 1);
        const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, camera);
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(V3()), target); const hit = V3();
        if (ray.ray.intersectPlane(plane, hit)) { const s = 1 - nr / r; target.addScaledVector(hit.sub(target), s); }
      }
      const eye = camera.position.clone().sub(target).normalize(); camera.position.copy(target).addScaledVector(eye, nr); st.dirty = true;
    }
    const PRESETS = { iso: [V3(1.15, -1.35, .95), V3(0, 0, 1)], front: [V3(0, -1, 0), V3(0, 0, 1)], back: [V3(0, 1, 0), V3(0, 0, 1)],
      right: [V3(1, 0, 0), V3(0, 0, 1)], left: [V3(-1, 0, 0), V3(0, 0, 1)], top: [V3(0, 0, 1), V3(0, 1, 0)], bottom: [V3(0, 0, -1), V3(0, -1, 0)] };
    function cameraState() { return { pos: camera.position.toArray(), target: target.toArray(), up: camera.up.toArray() }; }
    function tweenCamera(to, dur) {
      const tmp = camera.clone(); tmp.up.fromArray(to.up); tmp.position.fromArray(to.pos); tmp.lookAt(V3().fromArray(to.target));
      st.tweens.cam = { t: 0, dur: dur || .8, qa: camera.quaternion.clone(), qb: tmp.quaternion.clone(), ta: target.clone(), tb: V3().fromArray(to.target),
        ra: radius(), rb: V3().fromArray(to.pos).distanceTo(V3().fromArray(to.target)) };
    }
    function setCamera(s, animate) { if (animate) return tweenCamera(s); target.fromArray(s.target); camera.up.fromArray(s.up); camera.position.fromArray(s.pos); camera.lookAt(target); st.dirty = true; }
    function view(name, animate = true) {
      const [dir, up] = PRESETS[name] || PRESETS.iso; const r = radius() > 0 ? radius() : st.span * 2;
      const to = { target: target.toArray(), up: up.toArray(), pos: target.clone().addScaledVector(dir.clone().normalize(), r).toArray() };
      setCamera(to, animate);
    }
    function visibleBox(full) {
      const box = new THREE.Box3();
      for (const p of st.parts) { if (!p.mesh.visible) continue; const b = p.mesh.geometry.boundingBox.clone(); b.translate(full ? p.vec : p.offset); if (full) b.union(p.mesh.geometry.boundingBox); box.union(b); }
      return box;
    }
    function fit(full, animate = true) {
      const box = visibleBox(full); if (box.isEmpty()) return; const c = box.getCenter(V3()), s = box.getSize(V3()).length() / 2;
      const fov = THREE.MathUtils.degToRad(camera.fov), aspect = Math.max(camera.aspect, .3);
      const r = s / Math.sin(Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * aspect)) / 2) * 1.05;
      const eye = camera.position.clone().sub(target).normalize(); if (!isFinite(eye.x) || eye.lengthSq() === 0) eye.set(1, -1, 1).normalize();
      setCamera({ target: c.toArray(), up: camera.up.toArray(), pos: c.clone().addScaledVector(eye, r).toArray() }, animate);
    }
    // ------------------------------------------------------------------ selection
    const raycaster = new THREE.Raycaster();
    function pick(cx, cy) {
      const rect = canvas.getBoundingClientRect(); const ndc = new THREE.Vector2((cx - rect.left) / rect.width * 2 - 1, -(cy - rect.top) / rect.height * 2 + 1);
      raycaster.setFromCamera(ndc, camera); const hits = raycaster.intersectObjects(st.parts.filter(p => p.mesh.visible && !(p.mesh.material.transparent)).map(p => p.mesh), false);
      return hits.length ? hits[0].object.userData.part.id : null;
    }
    function select(id) { st.selected = id; applyColors(); if (st.cb.select) st.cb.select(id); }
    function hover(id) { if (id !== st.hovered) { st.hovered = id; applyColors(); if (st.cb.hover) st.cb.hover(id); } }
    // ------------------------------------------------------------------ mouse / touch / keyboard input
    if (opts.interactive) {
      let drag = null, inertia = { x: 0, y: 0 }; const touches = new Map();
      canvas.addEventListener('contextmenu', e => e.preventDefault());
      canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, b: e.button, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, moved: false, t: performance.now() }; inertia = { x: 0, y: 0 }; st.tweens.cam = null; });
      canvas.addEventListener('pointermove', e => {
        if (!drag) { if (e.pointerType === 'mouse') hover(pick(e.clientX, e.clientY)); return; }
        if (touches.size === 2) { // pinch: zoom + pan
          const prev = [...touches.values()]; touches.set(e.pointerId, { x: e.clientX, y: e.clientY }); const cur = [...touches.values()];
          const d0 = Math.hypot(prev[0].x - prev[1].x, prev[0].y - prev[1].y), d1 = Math.hypot(cur[0].x - cur[1].x, cur[0].y - cur[1].y);
          if (d0 > 0 && d1 > 0) zoom(d0 / d1); pan((cur[0].x + cur[1].x - prev[0].x - prev[1].x) / 2, (cur[0].y + cur[1].y - prev[0].y - prev[1].y) / 2); return;
        }
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.moved ||= Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4;
        if (drag.b === 2 || drag.b === 1 || (drag.b === 0 && drag.shift)) pan(dx, dy);
        else if (drag.b === 0 && drag.ctrl) roll(dx * .006);
        else { rotate(dx, dy); inertia = { x: dx, y: dy }; }
        drag.x = e.clientX; drag.y = e.clientY;
      });
      const up = e => { touches.delete(e.pointerId); if (drag && !drag.moved && drag.b === 0) select(pick(e.clientX, e.clientY)); if (drag && performance.now() - drag.t > 80 && drag.moved) st.inertia = inertia; drag = null; };
      canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
      canvas.addEventListener('pointerleave', () => hover(null));
      canvas.addEventListener('wheel', e => { e.preventDefault(); st.tweens.cam = null; zoom(Math.pow(1.0015, e.deltaY), e.clientX, e.clientY); }, { passive: false });
      canvas.addEventListener('dblclick', e => { const id = pick(e.clientX, e.clientY); if (id) { select(id); const p = st.byId[id]; const c = p.center.clone().add(p.offset); setCamera({ target: c.toArray(), up: camera.up.toArray(), pos: c.clone().addScaledVector(camera.position.clone().sub(target).normalize(), radius() * .55).toArray() }, true); } });
      canvas.tabIndex = 0;
      canvas.addEventListener('keydown', e => {
        const s = 22; const map = { ArrowLeft: () => rotate(-s, 0), ArrowRight: () => rotate(s, 0), ArrowUp: () => rotate(0, -s), ArrowDown: () => rotate(0, s),
          '+': () => zoom(1 / 1.2), '=': () => zoom(1 / 1.2), '-': () => zoom(1.2), q: () => roll(-.08), e: () => roll(.08), f: () => fit(st.fraction > 0), r: () => { view('iso'); fit(st.fraction > 0); } };
        if (map[e.key]) { map[e.key](); e.preventDefault(); }
      });
    }
    // ------------------------------------------------------------------ overlays (balloons, scale)
    let svg = null, scaleEl = null;
    if (overlay) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'sc-leaders'); overlay.appendChild(svg);
      scaleEl = document.createElement('div'); scaleEl.className = 'sc-scale'; scaleEl.innerHTML = '<div class="sc-scale-bar"><i></i><i></i></div><span></span>'; overlay.appendChild(scaleEl);
    }
    function balloonLayout() {
      const w = canvas.clientWidth, h = canvas.clientHeight, out = [];
      const cx = w / 2, cy = h / 2; const many = st.parts.length > 70;
      for (const p of st.parts) {
        const show = st.opt.balloons && p.mesh.visible && (!many || p.id === st.selected) && !(st.opt.ghost && st.selected && st.selected !== p.id && p.mesh.material.transparent);
        if (!show) { out.push(null); continue; }
        const v = p.center.clone().add(p.offset).project(camera); if (v.z > 1 || v.z < -1) { out.push(null); continue; }
        const ax = (v.x + 1) / 2 * w, ay = (1 - v.y) / 2 * h; let dx = ax - cx, dy = ay - cy; const n = Math.hypot(dx, dy) || 1; dx /= n; dy /= n;
        const L = 34 + Math.min(40, n * .08); out.push({ p, ax, ay, bx: ax + dx * L, by: ay + dy * L });
      }
      return out;
    }
    function updateOverlay() {
      if (!overlay) return; const lay = balloonLayout(); let lines = '';
      lay.forEach((b, i) => { const p = st.parts[i]; if (!p.balloon) return; if (!b) { p.balloon.style.display = 'none'; return; }
        p.balloon.style.display = ''; p.balloon.style.left = b.bx + 'px'; p.balloon.style.top = b.by + 'px'; p.balloon.classList.toggle('active', p.id === st.selected);
        lines += `<line x1="${b.ax.toFixed(1)}" y1="${b.ay.toFixed(1)}" x2="${b.bx.toFixed(1)}" y2="${b.by.toFixed(1)}"/><circle cx="${b.ax.toFixed(1)}" cy="${b.ay.toFixed(1)}" r="2.2"/>`; });
      svg.innerHTML = lines;
      scaleEl.hidden = !st.parts.length; if (!st.parts.length) return;
      const ppm = pixelsPerUnit(), len = niceScale(ppm); scaleEl.querySelector('.sc-scale-bar').style.width = (len * ppm).toFixed(1) + 'px'; scaleEl.querySelector('span').textContent = fmtLen(len);
    }
    // ------------------------------------------------------------------ render loop
    let last = 0;
    function frame(t) {
      const dt = Math.min((t - last) / 1000, .06); last = t;
      const tc = st.tweens.cam; if (tc) { tc.t += dt / tc.dur; const k = ease(Math.min(1, tc.t)); const q = tc.qa.clone().slerp(tc.qb, k);
        target.copy(tc.ta).lerp(tc.tb, k); const r = tc.ra + (tc.rb - tc.ra) * k; const fwd = V3(0, 0, -1).applyQuaternion(q);
        camera.position.copy(target).addScaledVector(fwd, -r); camera.quaternion.copy(q); camera.up.copy(V3(0, 1, 0).applyQuaternion(q)); if (tc.t >= 1) st.tweens.cam = null; st.dirty = true; }
      const tf = st.tweens.frac; if (tf) { tf.t += dt / tf.dur; const k = ease(Math.min(1, tf.t)); const val = tf.a + (tf.b - tf.a) * k;
        if (tf.kind === 'seq') st.seq = val; else st.fraction = val; if (tf.t >= 1) { st.tweens.frac = null; if (tf.done) tf.done(); } st.dirty = true; if (st.cb.progress) st.cb.progress(); }
      if (st.inertia && (Math.abs(st.inertia.x) + Math.abs(st.inertia.y) > .05)) { rotate(st.inertia.x, st.inertia.y); st.inertia.x *= .9; st.inertia.y *= .9; } else st.inertia = null;
      applyPositions(); updateOverlay(); renderer.render(scene, camera); requestAnimationFrame(frame);
    }
    function resize() { const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); st.dirty = true; }
    new ResizeObserver(resize).observe(canvas); resize(); requestAnimationFrame(frame);

    // ------------------------------------------------------------------ composed PNG export
    function snapshot(o) {
      o = Object.assign({ scale: 2, title: '', subtitle: '', balloons: st.opt.balloons, scaleBar: true }, o || {});
      // o.scale = exported pixels per CSS pixel of the canvas (2 = twice the resolution)
      const pr = renderer.getPixelRatio(); renderer.setPixelRatio(o.scale);
      resize(); applyPositions(); renderer.render(scene, camera);
      const W = renderer.domElement.width, H = renderer.domElement.height, s = W / canvas.clientWidth;
      const c2 = document.createElement('canvas'); c2.width = W; c2.height = H; const g = c2.getContext('2d'); g.drawImage(renderer.domElement, 0, 0);
      if (o.balloons) { g.lineWidth = 1.2 * s; g.strokeStyle = '#3b4b58'; g.fillStyle = '#3b4b58';
        for (const b of balloonLayout()) { if (!b) continue; g.beginPath(); g.moveTo(b.ax * s, b.ay * s); g.lineTo(b.bx * s, b.by * s); g.stroke(); g.beginPath(); g.arc(b.ax * s, b.ay * s, 2.2 * s, 0, 7); g.fill();
          g.save(); g.fillStyle = '#ffffff'; g.beginPath(); g.arc(b.bx * s, b.by * s, 11 * s, 0, 7); g.fill(); g.stroke(); g.fillStyle = '#18242d'; g.font = `600 ${11 * s}px Segoe UI, Arial`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(b.p.ref), b.bx * s, b.by * s + .5 * s); g.restore(); } }
      if (o.scaleBar) { const ppm = pixelsPerUnit(), len = niceScale(ppm), px = len * ppm * s, x = 22 * s, y = H - 26 * s;
        g.fillStyle = '#18242d'; g.fillRect(x, y, px, 3 * s); g.fillRect(x, y - 5 * s, 2 * s, 13 * s); g.fillRect(x + px - 2 * s, y - 5 * s, 2 * s, 13 * s);
        g.font = `500 ${12 * s}px Segoe UI, Arial`; g.textBaseline = 'bottom'; g.fillText(fmtLen(len), x, y - 8 * s); }
      if (o.title) { g.fillStyle = '#18242d'; g.font = `600 ${16 * s}px Segoe UI, Arial`; g.textBaseline = 'top'; g.fillText(o.title, 22 * s, 18 * s);
        if (o.subtitle) { g.fillStyle = '#56636e'; g.font = `400 ${12 * s}px Segoe UI, Arial`; g.fillText(o.subtitle, 22 * s, 42 * s); } }
      const url = c2.toDataURL('image/png'); renderer.setPixelRatio(pr); resize(); return url;
    }

    // ------------------------------------------------------------------ API
    return {
      load, fit, view, select, snapshot, cameraState, setCamera,
      setFraction(f) { st.mode = 'sim'; st.fraction = Math.max(0, Math.min(1, f)); st.tweens.frac = null; st.dirty = true; },
      animateFraction(b, dur, done) { st.mode = 'sim'; st.tweens.frac = { kind: 'sim', t: 0, dur: dur || 1.6, a: st.fraction, b, done }; },
      setSeq(s) { st.mode = 'seq'; st.seq = Math.max(0, Math.min(st.order.length, s)); st.tweens.frac = null; st.dirty = true; },
      animateSeq(b, dur, done) { st.mode = 'seq'; st.tweens.frac = { kind: 'seq', t: 0, dur: dur || 1, a: st.seq, b, done }; },
      stop() { st.tweens.frac = null; },
      get fraction() { return st.fraction; }, get seq() { return st.seq; }, get mode() { return st.mode; }, get order() { return st.order; },
      get selected() { return st.selected; }, get span() { return st.span; }, get dims() { return st.dims; },
      setColorMode(m) { st.color = m; applyColors(); }, get colorMode() { return st.color; },
      setUpAxis(a) { a = a === 'y' ? 'y' : 'z'; if (a === st.up) return; st.up = a; if (!st.data) return;
        const f = st.fraction, m = st.mode, q = st.seq, sel = st.selected; load(st.data); st.mode = m; st.fraction = f; st.seq = q; if (sel) select(sel); fit(f > 0 || m === 'seq', false); },
      get upAxis() { return st.up; },
      setOption(k, v) { st.opt[k] = v; applyColors(); }, option(k) { return st.opt[k]; }, options() { return Object.assign({}, st.opt); },
      setIsolate(v) { st.isolate = v; applyColors(); },
      exploded() { const b = visibleBox(false); return b.isEmpty() ? [0, 0, 0] : b.getSize(V3()).toArray(); },
      on(evt, fn) { st.cb[evt] = fn; }, focus() { canvas.focus(); },
      partInfo(id) { return st.byId[id] ? st.byId[id].data : null; }
    };
  }
  return { create, gridStep, fmtLen };
})();

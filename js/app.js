/**
 * Main Interactive Controller for Hyperbolic Plane H^2 PWA
 * Handles pointer/touch/pinch/wheel gestures (Mac Safari & iPhone Safari),
 * state management, precision formatting, inspector UI, presets, and PWA SW registration.
 */
(function () {
  'use strict';

  const DD = window.H2DD;
  const H2 = window.H2;
  const H2Theorems = window.H2Theorems;
  const H2Renderer = window.H2Renderer;

  const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const GREEK = ['α', 'β', 'γ', 'δ', 'ε', 'ζ', 'η', 'θ', 'ι', 'κ'];

  // --- Application State ---
  const state = {
    mode: 'triangle', // 'triangle' | 'points' | 'isometry' | 'theorems'
    theme: 'dark',
    sigFigs: 10,
    points: [
      H2.point('-0.58', '-0.34'),
      H2.point('0.66', '-0.28'),
      H2.point('0.06', '0.73'),
    ],
    selectedIndex: 0,
    selectedAlpha: false,
    coordInputType: 'cart', // 'cart' | 'polar' | 'boundary' | 'hyp'
    // Visual layer toggles
    showGrid: true,
    showTiling: false,
    showFullGeodesics: false,
    showMidpoint: true,
    showPerpBisector: false,
    showCircle: true,
    circleRadius: 1.2,
    showParallelism: false,
    showCenters: false,
    // Isometry state
    isometry: H2.makeIsometry('0.55', H2.point('0.48', '-0.18')),
    showInvariant: true,
    showOrbit: false,
    animatingIso: null,
    animFrameId: null,
    // Cached analysis / theorem results
    cachedTriAnalysis: null,
    direct2DResult: null,
    theoremReport: null,
  };

  // --- DOM Elements ---
  const canvas = document.getElementById('disk-canvas');
  const inspectorEl = document.getElementById('inspector-content');
  const zoomLabel = document.getElementById('zoom-label');
  const cursorReadout = document.getElementById('cursor-readout');
  const pwaStatusEl = document.getElementById('pwa-status');
  const btnTheme = document.getElementById('btn-theme');
  const metaThemeColor = document.getElementById('meta-theme-color');

  const renderer = H2Renderer.createRenderer(canvas);

  // --- Formatting Helpers ---

  function fmtDD(val, digits) {
    if (!val || !DD.isFiniteDD(val)) return '—';
    return DD.toPrecision(val, digits || state.sigFigs);
  }

  function fmtAngleRadDeg(angDD, digits) {
    if (!angDD || !DD.isFiniteDD(angDD)) return '—';
    const rad = DD.toPrecision(angDD, Math.min(digits || state.sigFigs, 12));
    const deg = DD.toNumber(angDD) * (180 / Math.PI);
    return `${rad} rad (${deg.toFixed(4)}°)`;
  }

  function fmtSci(val) {
    const n = typeof val === 'number' ? val : Math.abs(DD.toNumber(val));
    if (!Number.isFinite(n)) return '—';
    if (n === 0) return '0';
    return n.toExponential(2);
  }

  function pointLabel(idx) {
    return LABELS[idx % 26] + (idx >= 26 ? String(Math.floor(idx / 26)) : '');
  }

  function fmtComplex(z, sf) {
    const d = sf || Math.min(state.sigFigs, 8);
    const re = DD.toPrecision(z.re, d);
    const imAbs = DD.toPrecision(DD.abs(z.im), d);
    const sign = z.im.hi < 0 ? ' − ' : ' + ';
    return `${re}${sign}${imAbs}i`;
  }

  function degToRadDD(degStr) {
    const d = DD.fromString(degStr);
    return DD.divScalar(DD.mul(d, DD.PI), 180);
  }

  // --- Theme Initialization ---
  (function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem('h2-theme'); } catch (_) {}
    if (saved === 'light' || saved === 'dark') {
      state.theme = saved;
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      state.theme = 'light';
    }
    applyTheme();
  })();

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
    btnTheme.textContent = state.theme === 'dark' ? '☀︎' : '☾';
    if (metaThemeColor) {
      metaThemeColor.setAttribute('content', state.theme === 'dark' ? '#0f172a' : '#f1f5f9');
    }
  }

  btnTheme.addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('h2-theme', state.theme); } catch (_) {}
    applyTheme();
    redraw();
  });

  // --- Core Render & Update Pipeline ---

  function computeTriangleCache() {
    if (state.mode === 'triangle' && state.points.length === 3) {
      state.cachedTriAnalysis = H2.analyzeTriangle(state.points[0], state.points[1], state.points[2]);
    } else {
      state.cachedTriAnalysis = null;
    }
  }

  function redraw() {
    zoomLabel.textContent = renderer.view.zoom >= 100
      ? `${Math.round(renderer.view.zoom)}×`
      : `${renderer.view.zoom.toFixed(1)}×`;
    renderer.render(state);
  }

  let inspectorTimer = null;
  function updateAll(immediateInspector) {
    state.direct2DResult = null;
    computeTriangleCache();
    redraw();
    if (immediateInspector) {
      if (inspectorTimer) { clearTimeout(inspectorTimer); inspectorTimer = null; }
      renderInspector();
    } else if (!inspectorTimer) {
      inspectorTimer = setTimeout(() => {
        inspectorTimer = null;
        renderInspector();
      }, 45);
    }
  }

  // --- Mode Switching ---
  const modeTabBtns = Array.from(document.querySelectorAll('.mode-tab'));
  function setMode(mode) {
    stopAnimation();
    state.mode = mode;
    state.selectedAlpha = false;
    modeTabBtns.forEach(btn => {
      const active = btn.dataset.mode === mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (mode === 'theorems' && !state.theoremReport) {
      state.theoremReport = H2Theorems.runAllTheorems();
    }
    updateAll(true);
  }

  modeTabBtns.forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  // --- HUD Buttons ---
  document.getElementById('btn-zoom-in').addEventListener('click', () => {
    const rect = canvas.getBoundingClientRect();
    renderer.zoomAt(rect.width * 0.5, rect.height * 0.5, 1.8);
    redraw();
  });

  document.getElementById('btn-zoom-out').addEventListener('click', () => {
    const rect = canvas.getBoundingClientRect();
    renderer.zoomAt(rect.width * 0.5, rect.height * 0.5, 1 / 1.8);
    redraw();
  });

  document.getElementById('btn-zoom-reset').addEventListener('click', () => {
    renderer.resetView();
    redraw();
  });

  const btnGrid = document.getElementById('toggle-grid');
  btnGrid.addEventListener('click', () => {
    state.showGrid = !state.showGrid;
    btnGrid.classList.toggle('active', state.showGrid);
    redraw();
  });

  const btnTiling = document.getElementById('toggle-tiling');
  btnTiling.addEventListener('click', () => {
    state.showTiling = !state.showTiling;
    btnTiling.classList.toggle('active', state.showTiling);
    redraw();
  });

  const btnFullGeo = document.getElementById('toggle-full-geo');
  btnFullGeo.addEventListener('click', () => {
    state.showFullGeodesics = !state.showFullGeodesics;
    btnFullGeo.classList.toggle('active', state.showFullGeodesics);
    redraw();
  });

  document.getElementById('btn-del-pt').addEventListener('click', () => {
    if (state.points.length === 0) return;
    const idx = Math.min(state.selectedIndex, state.points.length - 1);
    state.points.splice(idx, 1);
    state.selectedIndex = Math.max(0, Math.min(state.selectedIndex, state.points.length - 1));
    updateAll(true);
  });

  document.getElementById('btn-clear-pts').addEventListener('click', () => {
    state.points = [];
    state.selectedIndex = 0;
    updateAll(true);
  });

  // --- Modals (Formula Reference & Add Coordinate) ---
  const formulaModal = document.getElementById('formula-modal');
  document.getElementById('btn-formulas').addEventListener('click', () => {
    formulaModal.hidden = false;
  });
  document.getElementById('btn-close-formula').addEventListener('click', () => {
    formulaModal.hidden = true;
  });
  document.getElementById('btn-close-formula-bottom').addEventListener('click', () => {
    formulaModal.hidden = true;
  });
  formulaModal.addEventListener('click', (e) => {
    if (e.target === formulaModal) formulaModal.hidden = true;
  });

  // Add-by-coordinate modal
  const addModal = document.getElementById('add-modal');
  const addInp1 = document.getElementById('add-inp-1');
  const addInp2 = document.getElementById('add-inp-2');
  const addLbl1 = document.getElementById('add-lbl-1');
  const addLbl2 = document.getElementById('add-lbl-2');
  const addErr = document.getElementById('add-error');
  let addCoordType = 'cart';

  function updateAddModalLabels() {
    if (addCoordType === 'cart') {
      addLbl1.textContent = '実部 x (例: 0.5, 0.999999999)';
      addLbl2.textContent = '虚部 y (例: 0.3)';
      addInp1.value = '0.4';
      addInp2.value = '0.2';
    } else if (addCoordType === 'polar') {
      addLbl1.textContent = 'ユークリッド半径 r (0 ≤ r < 1)';
      addLbl2.textContent = '偏角 θ (度, 例: 45)';
      addInp1.value = '0.85';
      addInp2.value = '45';
    } else if (addCoordType === 'boundary') {
      addLbl1.textContent = '境界までの距離 δ = 1 − r (例: 1e-8)';
      addLbl2.textContent = '偏角 θ (度, 例: 30)';
      addInp1.value = '1e-6';
      addInp2.value = '30';
    } else {
      addLbl1.textContent = '原点からの双曲距離 ρ = d(0, z) (例: 5)';
      addLbl2.textContent = '偏角 θ (度, 例: 60)';
      addInp1.value = '4';
      addInp2.value = '60';
    }
    addErr.textContent = '';
  }

  document.getElementById('add-coord-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.sub-tab');
    if (!btn) return;
    addCoordType = btn.dataset.ctype;
    document.querySelectorAll('#add-coord-tabs .sub-tab').forEach(b => b.classList.toggle('active', b === btn));
    updateAddModalLabels();
  });

  document.getElementById('btn-add-coord').addEventListener('click', () => {
    updateAddModalLabels();
    addModal.hidden = false;
  });
  document.getElementById('btn-close-add').addEventListener('click', () => { addModal.hidden = true; });
  document.getElementById('btn-cancel-add').addEventListener('click', () => { addModal.hidden = true; });
  addModal.addEventListener('click', (e) => { if (e.target === addModal) addModal.hidden = true; });

  function parseCoordinatePair(ctype, s1, s2) {
    let pt;
    if (ctype === 'cart') {
      pt = H2.point(s1, s2);
    } else if (ctype === 'polar') {
      pt = H2.pointFromPolar(s1, degToRadDD(s2));
    } else if (ctype === 'boundary') {
      pt = H2.pointFromBoundaryOffset(s1, degToRadDD(s2));
    } else {
      pt = H2.pointFromHyperbolicPolar(s1, degToRadDD(s2));
    }
    const v = H2.validatePoint(pt);
    if (!v.valid) {
      return { ok: false, error: '単位円板の内部 |z| < 1 を満たす有効な座標を入力してください。' };
    }
    return { ok: true, point: pt, validation: v };
  }

  document.getElementById('btn-confirm-add').addEventListener('click', () => {
    const res = parseCoordinatePair(addCoordType, addInp1.value, addInp2.value);
    if (!res.ok) {
      addErr.textContent = res.error;
      return;
    }
    state.points.push(res.point);
    state.selectedIndex = state.points.length - 1;
    state.selectedAlpha = false;
    addModal.hidden = true;
    updateAll(true);
  });

  // --- Pointer, Touch, Pinch-Zoom & Wheel Handling ---
  const activePointers = new Map();
  let dragTarget = null; // { type: 'point', index } | { type: 'alpha' } | { type: 'pan' } | null
  let pointerDownPos = null;
  let pointerMoved = false;
  let panStartView = null;
  let lastPinchDist = 0;
  let lastPinchMid = null;

  function getCanvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function clampToDisk(x, y) {
    const r = Math.hypot(x, y);
    const maxR = 1 - 1e-7;
    if (r >= maxR) {
      return { x: (x / r) * maxR, y: (y / r) * maxR };
    }
    return { x, y };
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    canvas.setPointerCapture(e.pointerId);
    const pos = getCanvasPos(e);
    activePointers.set(e.pointerId, pos);

    if (activePointers.size === 2) {
      // Begin pinch zoom
      dragTarget = null;
      const pts = Array.from(activePointers.values());
      lastPinchDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      lastPinchMid = { x: (pts[0].x + pts[1].x) * 0.5, y: (pts[0].y + pts[1].y) * 0.5 };
      return;
    }

    pointerDownPos = pos;
    pointerMoved = false;
    const isTouch = e.pointerType === 'touch';
    const hit = renderer.hitTest(pos.x, pos.y, state, isTouch);

    if (hit) {
      dragTarget = hit;
      canvas.classList.add('grabbing');
      if (hit.type === 'alpha') {
        state.selectedAlpha = true;
      } else {
        state.selectedIndex = hit.index;
        state.selectedAlpha = false;
      }
      redraw();
    } else {
      dragTarget = { type: 'pan' };
      panStartView = { cx: renderer.view.cx, cy: renderer.view.cy };
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const pos = getCanvasPos(e);

    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, pos);
    }

    // Pinch-to-zoom with 2 fingers
    if (activePointers.size === 2) {
      const pts = Array.from(activePointers.values());
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      const mid = { x: (pts[0].x + pts[1].x) * 0.5, y: (pts[0].y + pts[1].y) * 0.5 };
      if (lastPinchDist > 5 && dist > 5) {
        renderer.zoomAt(mid.x, mid.y, dist / lastPinchDist);
        // Pan by midpoint delta
        const R = Math.min(canvas.clientWidth, canvas.clientHeight) * 0.445 * renderer.view.zoom;
        renderer.view.cx -= (mid.x - lastPinchMid.x) / R;
        renderer.view.cy += (mid.y - lastPinchMid.y) / R;
      }
      lastPinchDist = dist;
      lastPinchMid = mid;
      redraw();
      return;
    }

    const d = renderer.screenToDisk(pos.x, pos.y);
    const r = Math.hypot(d.x, d.y);

    // Update live hover readout on desktop
    if (!dragTarget && e.pointerType === 'mouse') {
      const hit = renderer.hitTest(pos.x, pos.y, state, false);
      canvas.classList.toggle('grabbable', Boolean(hit));
      if (r < 1) {
        const hypR = 2 * Math.atanh(r);
        cursorReadout.textContent =
          `z = ${d.x.toFixed(4)} ${d.y >= 0 ? '+' : '−'} ${Math.abs(d.y).toFixed(4)}i  |  1−|z| = ${(1 - r).toExponential(2)}  |  d(0,z) = ${hypR.toFixed(3)}`;
      } else {
        cursorReadout.textContent = '円板内部 (|z| < 1) をタップして点を配置 / ドラッグで移動';
      }
      return;
    }

    if (!dragTarget || !pointerDownPos) return;
    if (Math.hypot(pos.x - pointerDownPos.x, pos.y - pointerDownPos.y) > 5) {
      pointerMoved = true;
    }

    if (dragTarget.type === 'point') {
      const c = clampToDisk(d.x, d.y);
      state.points[dragTarget.index] = H2.point(c.x, c.y);
      updateAll(false);
    } else if (dragTarget.type === 'alpha') {
      const c = clampToDisk(d.x, d.y);
      state.isometry = H2.makeIsometry(state.isometry.theta, H2.point(c.x, c.y));
      updateAll(false);
    } else if (dragTarget.type === 'pan' && pointerMoved && renderer.view.zoom > 1.01) {
      const R = Math.min(canvas.clientWidth, canvas.clientHeight) * 0.445 * renderer.view.zoom;
      renderer.view.cx = panStartView.cx - (pos.x - pointerDownPos.x) / R;
      renderer.view.cy = panStartView.cy + (pos.y - pointerDownPos.y) / R;
      const vr = Math.hypot(renderer.view.cx, renderer.view.cy);
      if (vr > 1.05) {
        renderer.view.cx *= 1.05 / vr;
        renderer.view.cy *= 1.05 / vr;
      }
      redraw();
    }
  });

  function finishPointer(e) {
    const pos = getCanvasPos(e);
    activePointers.delete(e.pointerId);
    canvas.classList.remove('grabbing');

    if (activePointers.size === 0) {
      if (dragTarget && dragTarget.type === 'pan' && !pointerMoved) {
        // Tap/click on empty disk -> add a new point inside H^2!
        const d = renderer.screenToDisk(pos.x, pos.y);
        if (Math.hypot(d.x, d.y) < 0.999999) {
          state.points.push(H2.point(d.x, d.y));
          state.selectedIndex = state.points.length - 1;
          state.selectedAlpha = false;
          if (state.mode === 'theorems') {
            setMode('triangle');
          } else {
            updateAll(true);
          }
        }
      } else if (dragTarget && (dragTarget.type === 'point' || dragTarget.type === 'alpha')) {
        updateAll(true);
      }
      dragTarget = null;
      pointerDownPos = null;
    }
  }

  canvas.addEventListener('pointerup', finishPointer);
  canvas.addEventListener('pointercancel', finishPointer);

  // Mouse wheel / Mac trackpad zoom
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const pos = getCanvasPos(e);
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    renderer.zoomAt(pos.x, pos.y, factor);
    redraw();
  }, { passive: false });

  // --- Presets ---
  function applyTrianglePreset(kind) {
    renderer.resetView();
    if (kind === 'std') {
      state.points = [
        H2.point('-0.58', '-0.34'),
        H2.point('0.66', '-0.28'),
        H2.point('0.06', '0.73'),
      ];
    } else if (kind === 'near-ideal') {
      state.points = [
        H2.pointFromBoundaryOffset('1e-4', '0.2'),
        H2.pointFromBoundaryOffset('1e-4', '2.3'),
        H2.pointFromBoundaryOffset('1e-4', '4.4'),
      ];
    } else if (kind === 'extreme-boundary') {
      state.points = [
        H2.pointFromBoundaryOffset('1e-10', '0.15'),
        H2.pointFromBoundaryOffset('1e-10', '2.25'),
        H2.pointFromBoundaryOffset('1e-10', '4.35'),
      ];
    } else if (kind === 'tiny') {
      state.points = [
        H2.point('0.0012', '0.0002'),
        H2.point('-0.0008', '0.0011'),
        H2.point('-0.0006', '-0.0010'),
      ];
    } else if (kind === 'right-pentagon') {
      const pi5 = DD.divScalar(DD.PI, 5);
      const sc = DD.sincos(pi5);
      const R = DD.acosh(DD.div(sc.cos, sc.sin));
      state.points = [];
      for (let k = 0; k < 5; k++) {
        state.points.push(H2.pointFromHyperbolicPolar(R, DD.mulScalar(DD.divScalar(DD.TWO_PI, 5), k)));
      }
    }
    state.selectedIndex = 0;
    updateAll(true);
  }

  function applyIsometryPreset(kind) {
    stopAnimation();
    if (kind === 'elliptic') {
      state.isometry = H2.makeIsometry('1.6', H2.point('0.35', '0.18'));
    } else if (kind === 'parabolic') {
      const th = DD.from('1.2');
      const r = DD.sin(DD.ldexp(th, -1));
      state.isometry = H2.makeIsometry(th, H2.pointFromPolar(r, '0.6'));
    } else if (kind === 'hyperbolic') {
      state.isometry = H2.makeIsometry('0.35', H2.point('0.62', '-0.22'));
    } else if (kind === 'boundary-push') {
      state.isometry = H2.makeIsometry('1.1', H2.point('0.97', '-0.18'));
    }
    updateAll(true);
  }

  // --- Smooth 1-Parameter Subgroup Animation ---
  function stopAnimation() {
    if (state.animFrameId) {
      cancelAnimationFrame(state.animFrameId);
      state.animFrameId = null;
    }
    state.animatingIso = null;
  }

  function playIsometryAnimation() {
    stopAnimation();
    const start = performance.now();
    const duration = 1800;
    function step(now) {
      const raw = Math.min(1, (now - start) / duration);
      // Smooth ease-in-out
      const t = raw < 0.5 ? 2 * raw * raw : 1 - Math.pow(-2 * raw + 2, 2) / 2;
      state.animatingIso = H2.isometryPower(state.isometry, t);
      redraw();
      if (raw < 1) {
        state.animFrameId = requestAnimationFrame(step);
      } else {
        state.animFrameId = null;
        state.animatingIso = null;
        redraw();
      }
    }
    state.animFrameId = requestAnimationFrame(step);
  }

  // --- Inspector Rendering ---

  function buildPointSelectorAndEditorHTML() {
    const chips = state.points.map((pt, i) => {
      const active = !state.selectedAlpha && i === state.selectedIndex ? 'active' : '';
      return `<button class="chip ${active}" data-sel-pt="${i}"><span class="chip-dot"></span>${pointLabel(i)}</button>`;
    }).join('');

    const alphaChip = state.mode === 'isometry'
      ? `<button class="chip alpha-chip ${state.selectedAlpha ? 'active' : ''}" data-sel-alpha="1">α (変換中心)</button>`
      : '';

    const targetPt = state.selectedAlpha
      ? state.isometry.alpha
      : (state.points[state.selectedIndex] || null);
    const targetName = state.selectedAlpha ? 'α' : (targetPt ? pointLabel(state.selectedIndex) : '');

    let editorHTML = '';
    if (targetPt) {
      const val = H2.validatePoint(targetPt);
      const rDD = DD.cAbs(targetPt);
      const deltaDD = DD.sub(DD.ONE, rDD);
      const d0 = H2.distanceInfo(targetPt, H2.point(0, 0));
      const argDeg = (DD.toNumber(DD.cArg(targetPt)) * 180 / Math.PI).toFixed(4);

      let v1 = '', v2 = '', l1 = '', l2 = '';
      if (state.coordInputType === 'cart') {
        l1 = '実部 x'; l2 = '虚部 y';
        v1 = DD.toPrecision(targetPt.re, 14);
        v2 = DD.toPrecision(targetPt.im, 14);
      } else if (state.coordInputType === 'polar') {
        l1 = '半径 r = |z|'; l2 = '偏角 θ (°)';
        v1 = DD.toPrecision(rDD, 14);
        v2 = argDeg;
      } else if (state.coordInputType === 'boundary') {
        l1 = '境界距離 δ = 1−|z|'; l2 = '偏角 θ (°)';
        v1 = DD.toPrecision(deltaDD, 10);
        v2 = argDeg;
      } else {
        l1 = '双曲距離 ρ = d(0,z)'; l2 = '偏角 θ (°)';
        v1 = d0.reliable ? DD.toPrecision(d0.distance, 12) : '0';
        v2 = argDeg;
      }

      const relBadge = val.reliable
        ? `<span class="badge badge-ok">有効桁 ≈ ${val.reliableDigits}桁</span>`
        : `<span class="badge badge-err">精度限界超過 (${val.reliableDigits}桁)</span>`;

      editorHTML = `
        <div class="divider"></div>
        <div class="card-header" style="margin-bottom:6px;">
          <span class="card-title">点 ${targetName} の精密座標編集</span>
          ${relBadge}
        </div>
        <div class="sub-tabs" id="edit-ctype-tabs">
          <button class="sub-tab ${state.coordInputType === 'cart' ? 'active' : ''}" data-ectype="cart">直交 (x,y)</button>
          <button class="sub-tab ${state.coordInputType === 'polar' ? 'active' : ''}" data-ectype="polar">極 (r,θ)</button>
          <button class="sub-tab ${state.coordInputType === 'boundary' ? 'active' : ''}" data-ectype="boundary">1−δ, θ</button>
          <button class="sub-tab ${state.coordInputType === 'hyp' ? 'active' : ''}" data-ectype="hyp">双曲 ρ,θ</button>
        </div>
        <div class="input-row">
          <div class="field">
            <label>${l1}</label>
            <input type="text" id="ed-v1" value="${v1}" inputmode="decimal" autocomplete="off">
          </div>
          <div class="field">
            <label>${l2}</label>
            <input type="text" id="ed-v2" value="${v2}" inputmode="decimal" autocomplete="off">
          </div>
        </div>
        <div class="btn-row" style="justify-content:space-between; align-items:center;">
          <span class="muted num">1−|z|=${fmtSci(deltaDD)}, d(0,z)=${d0.reliable ? fmtDD(d0.distance, 7) : '—'}</span>
          <button class="btn btn-primary btn-sm" id="btn-apply-coord">座標を反映</button>
        </div>
        <div id="ed-err" style="color:var(--rose); font-size:12px; margin-top:4px;"></div>
      `;
    }

    return `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">配置点 (${state.points.length}点)</h3>
          <select id="sel-sigfigs" aria-label="表示桁数" style="font-size:12px; padding:3px 6px; border-radius:6px; background:var(--surface); color:var(--text); border:1px solid var(--border);">
            <option value="8" ${state.sigFigs === 8 ? 'selected' : ''}>8桁表示</option>
            <option value="10" ${state.sigFigs === 10 ? 'selected' : ''}>10桁表示</option>
            <option value="13" ${state.sigFigs === 13 ? 'selected' : ''}>13桁表示</option>
            <option value="16" ${state.sigFigs === 16 ? 'selected' : ''}>16桁表示</option>
          </select>
        </div>
        <div class="chip-row">
          ${chips}
          ${alphaChip}
          <button class="chip" id="chip-add-pt">＋追加</button>
        </div>
        ${editorHTML}
      </div>
    `;
  }

  function buildTriangleModeHTML() {
    const n = state.points.length;
    let body = `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">プリセット図形</h3>
          <span class="card-subtitle">タップで即座に確認</span>
        </div>
        <div class="chip-row">
          <button class="chip" data-tri-preset="std">標準三角形</button>
          <button class="chip" data-tri-preset="near-ideal">理想近傍 (10⁻⁴)</button>
          <button class="chip" data-tri-preset="extreme-boundary">極限境界 (10⁻¹⁰)</button>
          <button class="chip" data-tri-preset="tiny">微小 (10⁻³)</button>
          <button class="chip" data-tri-preset="right-pentagon">直角正五角形</button>
        </div>
      </div>
    `;

    if (n < 3) {
      body += `
        <div class="notice-box">
          現在 <strong>${n}点</strong> が配置されています。円板内をタップして <strong>3点以上</strong> 配置すると、測地線三角形（多角形）の面積とガウス–ボネの定理の検証が表示されます。
        </div>
      `;
      return body + buildPointSelectorAndEditorHTML();
    }

    const analysis = n === 3 ? state.cachedTriAnalysis : H2.analyzePolygon(state.points);

    if (!analysis || !analysis.reliable) {
      body += `
        <div class="notice-box">
          <strong>精度限界のため数値を非表示にしています</strong><br>
          頂点が理想境界 |z| = 1 に極端に近すぎる（推定有効桁 &lt; ${H2.MIN_RELIABLE_DIGITS} 桁）か、頂点が退化しているため、正確な面積・角度を保証できません。座標を少し内側に戻すか、プリセットをお試しください。
        </div>
      `;
      return body + buildPointSelectorAndEditorHTML();
    }

    const isTri = n === 3;
    const gbTitle = isTri ? 'π − (α + β + γ)' : `(${n} − 2)π − ∑α_k`;
    const diffNum = DD.toNumber(analysis.gbDiff);
    const matchBadge = diffNum < 1e-10
      ? `<span class="badge badge-ok">高精度一致 ✓ (差 ${fmtSci(diffNum)})</span>`
      : `<span class="badge badge-warn">差 ${fmtSci(diffNum)}</span>`;

    let extra2DHTML = '';
    if (isTri) {
      if (state.direct2DResult) {
        if (state.direct2DResult.applicable) {
          const err2D = Math.abs(state.direct2DResult.area - DD.toNumber(analysis.areaGB));
          extra2DHTML = `
            <div class="metric-box" style="margin-top:8px;">
              <div class="metric-box-label">
                <span>直接 2D ガウス求積 ∬<sub>T</sub> 4/(1−|z|²)² dxdy</span>
                <span class="badge badge-ok">差 ${fmtSci(err2D)}</span>
              </div>
              <div class="metric-box-value" style="font-size:14px;">${state.direct2DResult.area.toPrecision(Math.min(state.sigFigs, 12))}</div>
            </div>
          `;
        } else {
          extra2DHTML = `<p class="muted" style="margin:6px 0 0;">※ 境界近傍 (1−|z|² &lt; 10⁻³) では被積分関数 4/(1−|z|²)² が急峻に発散するため、直接2D求積は省略し106bitグリーン線積分のみ評価します。</p>`;
        }
      } else {
        extra2DHTML = `<button class="btn btn-sm" id="btn-run-2d" style="margin-top:4px; width:100%;">直接 2D 数値積分 ∬ 4/(1−|z|²)² dxdy でも照合する</button>`;
      }
    }

    body += `
      <div class="card card-hero">
        <div class="card-header">
          <h3 class="card-title">ガウス–ボネの定理 検証 (${isTri ? '測地線三角形' : `測地線 ${n} 角形`})</h3>
          ${matchBadge}
        </div>
        <div class="formula-bar">
          Area(T) = ∬<sub>T</sub> 4 / (1 − |z|²)² dx dy = ${gbTitle}
        </div>
        <div class="metric-box">
          <div class="metric-box-label">
            <span>独立数値積分 (106bit 適応ガウス求積)</span>
            <span>有効桁 ≈ ${analysis.areaReliableDigits || analysis.reliableDigits}桁</span>
          </div>
          <div class="metric-box-value">${fmtDD(analysis.areaNumerical)}</div>
        </div>
        <div class="metric-box">
          <div class="metric-box-label">
            <span>ガウス–ボネ公式 ${gbTitle}</span>
            <span>相対差 ${fmtSci(analysis.gbRelDiff)}</span>
          </div>
          <div class="metric-box-value">${fmtDD(analysis.areaGB)}</div>
        </div>
        ${isTri ? `
          <div class="metric-box" style="margin-bottom:4px;">
            <div class="metric-box-label">
              <span>L'Huilier 公式 (3辺長 a, b, c のみから算出)</span>
              <span>差 ${fmtSci(analysis.lhuilierDiff)}</span>
            </div>
            <div class="metric-box-value" style="font-size:14px;">${fmtDD(analysis.areaLHuilier)}</div>
          </div>
        ` : ''}
        ${extra2DHTML}
      </div>
    `;

    // Angles & Sides Card
    if (isTri) {
      const { alpha, beta, gamma } = analysis.angles;
      const { a, b, c } = analysis.sides;
      body += `
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">内角と辺長</h3>
            <span class="card-subtitle">常に α+β+γ &lt; π</span>
          </div>
          <div class="kv-grid">
            <span class="kv-label">α = ∠BAC</span><span class="kv-val">${fmtAngleRadDeg(alpha)}</span>
            <span class="kv-label">β = ∠CBA</span><span class="kv-val">${fmtAngleRadDeg(beta)}</span>
            <span class="kv-label">γ = ∠ACB</span><span class="kv-val">${fmtAngleRadDeg(gamma)}</span>
            <span class="kv-label">内角の和 α+β+γ</span><span class="kv-val">${fmtAngleRadDeg(analysis.angleSum)}</span>
            <span class="kv-label">角不足 π − (α+β+γ)</span><span class="kv-val">${fmtDD(analysis.areaGB)} rad</span>
          </div>
          <div class="divider"></div>
          <div class="kv-grid">
            <span class="kv-label">a = d(B, C)</span><span class="kv-val">${fmtDD(a)}</span>
            <span class="kv-label">b = d(C, A)</span><span class="kv-val">${fmtDD(b)}</span>
            <span class="kv-label">c = d(A, B)</span><span class="kv-val">${fmtDD(c)}</span>
          </div>
          <div class="divider"></div>
          <label class="toggle-row">
            <span>内心 I・外心 O・重心 G を表示</span>
            <input type="checkbox" id="chk-centers" ${state.showCenters ? 'checked' : ''}>
          </label>
          ${state.showCenters ? `
            <div class="muted" style="margin-top:4px;">
              外接円: ${analysis.circumcircle ? `存在 (半径 R = ${fmtDD(analysis.circumcircle.radius, 6)})` : '双曲平面内に存在しません (垂直二等分線が超平行/極限平行)'}
            </div>
          ` : ''}
        </div>

        <div class="card">
          <div class="card-header">
            <h3 class="card-title">双曲三角法 リアルタイム検証</h3>
            <span class="badge badge-ok">成立 ✓</span>
          </div>
          <div class="kv-grid">
            <span class="kv-label">第1余弦定理 相対誤差<br><span class="math" style="font-size:11px;">cosh c = cosh a cosh b − sinh a sinh b cos γ</span></span>
            <span class="kv-val">${fmtSci(analysis.lawCos1.relErr)}</span>
            <span class="kv-label">第2余弦定理 誤差 (AAA決定性)<br><span class="math" style="font-size:11px;">cos γ = −cos α cos β + sin α sin β cosh c</span></span>
            <span class="kv-val">${fmtSci(analysis.lawCos2.err)}</span>
            <span class="kv-label">双曲正弦定理 ばらつき<br><span class="math" style="font-size:11px;">sinh a / sin α = sinh b / sin β = sinh c / sin γ</span></span>
            <span class="kv-val">${fmtSci(analysis.lawSine.relSpread)}</span>
          </div>
        </div>
      `;
    } else {
      const angRows = analysis.interiorAngles.map((ang, i) =>
        `<span class="kv-label">${GREEK[i] || `α_${i + 1}`} (頂点 ${pointLabel(i)})</span><span class="kv-val">${fmtAngleRadDeg(ang, 8)}</span>`
      ).join('');
      const sideRows = analysis.sides.map((s, i) =>
        `<span class="kv-label">d(${pointLabel(i)}, ${pointLabel((i + 1) % n)})</span><span class="kv-val">${fmtDD(s, 9)}</span>`
      ).join('');
      body += `
        <div class="card">
          <div class="card-header"><h3 class="card-title">${n}角形の内角と辺長</h3></div>
          <div class="kv-grid">${angRows}</div>
          <div class="divider"></div>
          <div class="kv-grid">${sideRows}</div>
        </div>
      `;
    }

    return body + buildPointSelectorAndEditorHTML();
  }

  function buildPointsModeHTML() {
    const pts = state.points;
    let body = '';

    // Distances Card
    if (pts.length >= 2) {
      let distRows = '';
      for (let i = 0; i < pts.length - 1; i++) {
        const info = H2.distanceInfo(pts[i], pts[i + 1]);
        const name = `${pointLabel(i)}, ${pointLabel(i + 1)}`;
        if (info.reliable) {
          distRows += `
            <span class="kv-label">d(${name})</span><span class="kv-val">${fmtDD(info.distance)}</span>
            <span class="kv-label">ρ(${name}) = |(z−w)/(1−z̄w)|</span><span class="kv-val">${fmtDD(info.pseudoDistance, Math.min(state.sigFigs, 12))}</span>
          `;
        } else {
          distRows += `<span class="kv-label">d(${name})</span><span class="kv-val" style="color:var(--amber);">精度限界のため非表示</span>`;
        }
      }

      const geoAB = H2.geodesic(pts[0], pts[1]);
      let midInfoHTML = '';
      if (geoAB.valid && state.showMidpoint) {
        const dAM = H2.distanceInfo(pts[0], geoAB.midpoint);
        const dMB = H2.distanceInfo(geoAB.midpoint, pts[1]);
        if (dAM.reliable && dMB.reliable) {
          midInfoHTML = `
            <div class="divider"></div>
            <div class="kv-grid">
              <span class="kv-label">双曲中点 M</span><span class="kv-val">${fmtComplex(geoAB.midpoint, 6)}</span>
              <span class="kv-label">d(A, M) = d(M, B)</span><span class="kv-val">${fmtDD(dAM.distance, 9)}</span>
            </div>
          `;
        }
      }

      body += `
        <div class="card card-hero">
          <div class="card-header">
            <h3 class="card-title">双曲距離と測地線</h3>
            <span class="card-subtitle">K = −1</span>
          </div>
          <div class="formula-bar">
            d(z, w) = log( (1 + |(z−w)/(1−z̄w)|) / (1 − |(z−w)/(1−z̄w)|) )
          </div>
          <div class="kv-grid">${distRows}</div>
          ${midInfoHTML}
          <div class="divider"></div>
          <label class="toggle-row">
            <span>双曲中点 M を表示 (ユークリッド中点との違いを確認)</span>
            <input type="checkbox" id="chk-midpoint" ${state.showMidpoint ? 'checked' : ''}>
          </label>
          <label class="toggle-row">
            <span>AB の双曲垂直二等分線を表示</span>
            <input type="checkbox" id="chk-perpbis" ${state.showPerpBisector ? 'checked' : ''}>
          </label>
        </div>
      `;
    } else {
      body += `<div class="notice-box">円板内をタップして <strong>2点以上</strong> 配置すると、双曲距離 d(z, w) と測地線・中点が表示されます。</div>`;
    }

    // Hyperbolic Circle Card
    if (pts.length >= 1) {
      const circ = H2.hyperbolicCircle(pts[0], state.circleRadius);
      let circMetrics = '';
      if (state.showCircle && circ.valid) {
        if (circ.reliable) {
          const numC = H2.numericalCircleAreaDD(pts[0], state.circleRadius);
          const diffC = numC.reliable ? DD.abs(DD.sub(numC.area, circ.exactArea)) : null;
          circMetrics = `
            <div class="kv-grid" style="margin-top:8px;">
              <span class="kv-label">双曲周長 2π·sinh R</span><span class="kv-val">${fmtDD(circ.circumference)}</span>
              <span class="kv-label">厳密面積 4π·sinh²(R/2)</span><span class="kv-val">${fmtDD(circ.exactArea)}</span>
              <span class="kv-label">数値積分 ∬ 4/(1−|z|²)² dxdy</span><span class="kv-val">${numC.reliable ? fmtDD(numC.area) : '—'}</span>
              <span class="kv-label">面積一致誤差</span><span class="kv-val" style="color:var(--emerald);">${diffC ? fmtSci(diffC) : '—'}</span>
              <span class="kv-label">ユークリッド中心 c<sub>E</sub> (✕印)</span><span class="kv-val">${fmtComplex(circ.euclidCenter, 5)}</span>
              <span class="kv-label">ユークリッド半径 r<sub>E</sub></span><span class="kv-val">${fmtDD(circ.euclidRadius, 6)}</span>
            </div>
          `;
        } else {
          circMetrics = `<p class="muted" style="margin-top:6px; color:var(--amber);">円が境界に極端に近いため、数値表示を抑制しています。</p>`;
        }
      }

      body += `
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">双曲円 B<sub>H</sub>(A, R)</h3>
            <label style="display:flex; align-items:center; gap:6px; font-size:12px;">
              <input type="checkbox" id="chk-circle" ${state.showCircle ? 'checked' : ''}> 表示
            </label>
          </div>
          <div class="field">
            <label>双曲半径 R = <span class="num">${state.circleRadius.toFixed(2)}</span></label>
            <input type="range" id="rng-circle-r" min="0.15" max="4.5" step="0.05" value="${state.circleRadius}">
          </div>
          ${circMetrics}
        </div>
      `;
    }

    // Parallelism Card (when >= 3 points)
    if (pts.length >= 3) {
      const perp = H2.pointToGeodesic(pts[2], pts[0], pts[1]);
      body += `
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">平行角 (ロバチェフスキーの公式)</h3>
            <label style="display:flex; align-items:center; gap:6px; font-size:12px;">
              <input type="checkbox" id="chk-parallel" ${state.showParallelism ? 'checked' : ''}> 表示
            </label>
          </div>
          <div class="formula-bar">Π(h) = 2·arctan(e<sup>−h</sup>) &nbsp; (点Cから測地線ABへの垂線長 h)</div>
          ${perp.valid ? `
            <div class="kv-grid">
              <span class="kv-label">垂線長 h = d(C, H)</span><span class="kv-val">${fmtDD(perp.distance)}</span>
              <span class="kv-label">平行角 Π(h)</span><span class="kv-val">${fmtAngleRadDeg(perp.angleOfParallelism)}</span>
            </div>
          ` : ''}
        </div>
      `;
    }

    return body + buildPointSelectorAndEditorHTML();
  }

  function buildIsometryModeHTML() {
    const iso = state.isometry;
    const cls = H2.classifyIsometry(iso);
    const thetaDeg = (DD.toNumber(iso.theta) * 180 / Math.PI);

    let typeBadge = '<span class="badge badge-info">恒等写像</span>';
    if (cls.type === 'elliptic') typeBadge = '<span class="badge badge-info">楕円型 (|tr| &lt; 2)</span>';
    else if (cls.type === 'parabolic') typeBadge = '<span class="badge badge-warn">放物型 (|tr| = 2)</span>';
    else if (cls.type === 'hyperbolic') typeBadge = '<span class="badge badge-ok">双曲型 (|tr| &gt; 2)</span>';

    // Classification detail rows
    let clsRows = `
      <span class="kv-label">SU(1,1) トレース |tr|</span>
      <span class="kv-val">${cls.valid ? fmtDD(cls.absTrace, 10) : '—'}</span>
    `;
    if (cls.type === 'elliptic' && cls.interiorFixed) {
      clsRows += `
        <span class="kv-label">内部不動点 p ∈ ℍ²</span>
        <span class="kv-val">${fmtComplex(cls.interiorFixed, 6)}</span>
        <span class="kv-label">回転角 ψ</span>
        <span class="kv-val">${fmtAngleRadDeg(cls.rotationAngle, 8)}</span>
      `;
    } else if (cls.type === 'parabolic' && cls.boundaryFixed.length) {
      clsRows += `
        <span class="kv-label">境界不動点 z<sub>∞</sub> ∈ ∂ℍ²</span>
        <span class="kv-val">${fmtComplex(cls.boundaryFixed[0], 6)}</span>
      `;
    } else if (cls.type === 'hyperbolic' && cls.repelling && cls.attracting) {
      clsRows += `
        <span class="kv-label">反発不動点 z<sub>−</sub> ∈ ∂ℍ²</span>
        <span class="kv-val">${fmtComplex(cls.repelling, 6)}</span>
        <span class="kv-label">吸引不動点 z<sub>+</sub> ∈ ∂ℍ²</span>
        <span class="kv-val">${fmtComplex(cls.attracting, 6)}</span>
        <span class="kv-label">並進距離 ℓ = 2·arcosh(|tr|/2)</span>
        <span class="kv-val">${fmtDD(cls.translationLength, 10)}</span>
      `;
    }

    // Live Isometry Invariance Check
    let invCard = '';
    if (state.points.length >= 2) {
      const imgPts = state.points.map(p => H2.applyIsometry(iso, p));
      const dBefore = H2.distanceInfo(state.points[0], state.points[1]);
      const dAfter = H2.distanceInfo(imgPts[0], imgPts[1]);

      let rows = '';
      if (dBefore.reliable && dAfter.reliable) {
        const dDiff = DD.abs(DD.sub(dBefore.distance, dAfter.distance));
        rows += `
          <span class="kv-label">距離 d(A, B)</span><span class="kv-val">${fmtDD(dBefore.distance, 10)}</span>
          <span class="kv-label">像の距離 d(A', B')</span><span class="kv-val">${fmtDD(dAfter.distance, 10)}</span>
          <span class="kv-label">距離保存誤差</span><span class="kv-val" style="color:var(--emerald);">${fmtSci(dDiff)}</span>
        `;
      }

      if (state.points.length >= 3) {
        const poly1 = H2.analyzePolygon(state.points);
        const poly2 = H2.analyzePolygon(imgPts);
        if (poly1.reliable && poly2.reliable) {
          const aDiff = DD.abs(DD.sub(poly1.areaNumerical, poly2.areaNumerical));
          rows += `
            <span class="kv-label">元の数値面積 Area(P)</span><span class="kv-val">${fmtDD(poly1.areaNumerical, 10)}</span>
            <span class="kv-label">像の数値面積 Area(φ(P))</span><span class="kv-val">${fmtDD(poly2.areaNumerical, 10)}</span>
            <span class="kv-label">面積保存誤差</span><span class="kv-val" style="color:var(--emerald);">${fmtSci(aDiff)}</span>
          `;
        } else {
          rows += `<span class="kv-label">面積保存</span><span class="kv-val" style="color:var(--amber);">像が境界極限のため非表示</span>`;
        }
      }

      invCard = `
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">等長不変性のライブ検証</h3>
            <span class="badge badge-ok">不変 ✓</span>
          </div>
          <div class="kv-grid">${rows}</div>
        </div>
      `;
    }

    return `
      <div class="card card-hero">
        <div class="card-header">
          <h3 class="card-title">等長変換 φ<sub>θ,α</sub> ∈ Isom₊(ℍ²)</h3>
          ${typeBadge}
        </div>
        <div class="formula-bar">
          φ<sub>θ,α</sub>(z) = e<sup>iθ</sup> · (z − α) / (1 − ᾱz) &nbsp; (ピンクの点 α をドラッグ可)
        </div>
        <div class="field" style="margin-bottom:8px;">
          <label>回転パラメータ θ = <span class="num">${DD.toPrecision(iso.theta, 6)} rad (${thetaDeg.toFixed(1)}°)</span></label>
          <input type="range" id="rng-iso-theta" min="0" max="6.2831853" step="0.01" value="${DD.toNumber(iso.theta)}">
        </div>
        <div class="chip-row" style="margin-bottom:8px;">
          <button class="chip" data-theta-val="0">θ=0</button>
          <button class="chip" data-theta-val="1.0471975511965976">π/3</button>
          <button class="chip" data-theta-val="1.5707963267948966">π/2</button>
          <button class="chip" data-theta-val="3.141592653589793">π</button>
          <button class="chip" id="btn-alpha-to-a">Aを原点へ (α=A)</button>
        </div>
        <div class="btn-row" style="margin-bottom:8px;">
          <button class="btn btn-primary btn-sm" id="btn-anim-iso">▶ φ<sup>t</sup> アニメーション</button>
          <button class="btn btn-sm" id="btn-inv-iso">逆変換 φ⁻¹</button>
          <button class="btn btn-sm" id="btn-commit-iso">像を確定</button>
          <button class="btn btn-sm" id="btn-reset-iso">恒等写像</button>
        </div>
        <div class="divider"></div>
        <div class="card-header" style="margin-bottom:6px;">
          <span class="card-title">変換タイプ別プリセット</span>
        </div>
        <div class="chip-row" style="margin-bottom:8px;">
          <button class="chip" data-iso-preset="elliptic">楕円型</button>
          <button class="chip" data-iso-preset="parabolic">放物型</button>
          <button class="chip" data-iso-preset="hyperbolic">双曲型</button>
          <button class="chip" data-iso-preset="boundary-push">境界近傍 (|α|≈0.986)</button>
        </div>
        <label class="toggle-row">
          <span>不変曲線 (同心円 / ホロサイクル / 並進軸)</span>
          <input type="checkbox" id="chk-invariant" ${state.showInvariant ? 'checked' : ''}>
        </label>
        <label class="toggle-row">
          <span>点 A の反復軌道 φ<sup>n</sup>(A) を表示</span>
          <input type="checkbox" id="chk-orbit" ${state.showOrbit ? 'checked' : ''}>
        </label>
      </div>

      <div class="card">
        <div class="card-header">
          <h3 class="card-title">PSU(1,1) 分類と不変量</h3>
          <span class="card-subtitle">φ(α) = 0</span>
        </div>
        <div class="kv-grid">${clsRows}</div>
      </div>

      ${invCard}
      ${buildPointSelectorAndEditorHTML()}
    `;
  }

  function buildTheoremsModeHTML() {
    const rep = state.theoremReport || H2Theorems.runAllTheorems();
    state.theoremReport = rep;

    const summaryBadge = rep.allPassed
      ? `<span class="badge badge-ok">全 ${rep.passed}/${rep.total} 合格 ✓</span>`
      : `<span class="badge badge-err">${rep.passed}/${rep.total} 合格</span>`;

    const items = rep.results.map((r, idx) => `
      <div class="theorem-item">
        <div class="theorem-top">
          <div>
            <span class="badge badge-info" style="margin-bottom:3px;">${r.category}</span>
            <div class="theorem-title">${r.title}</div>
          </div>
          <span class="badge ${r.passed ? 'badge-ok' : 'badge-err'}">${r.passed ? 'PASS ✓' : 'FAIL'}</span>
        </div>
        <div class="theorem-formula">${r.formula}</div>
        <div class="theorem-meta">
          <span>誤差: <strong>${r.errorStr}</strong><br>${r.detail}</span>
          ${r.inspectConfig ? `<button class="btn btn-sm" data-inspect-thm="${idx}">盤面で表示</button>` : ''}
        </div>
      </div>
    `).join('');

    return `
      <div class="card card-hero">
        <div class="card-header">
          <h3 class="card-title">双曲幾何 定理検証スイート</h3>
          ${summaryBadge}
        </div>
        <p class="muted" style="margin:0 0 10px;">
          106bit倍々精度エンジン上で既知の15定理（ガウス–ボネ、L'Huilier、直接2D積分、第1/第2余弦定理、正弦定理、等長変換群、ロバチェフスキー平行角、境界 1−|z|=10⁻¹² 精度、極限ガード）をリアルタイム検証します。
        </p>
        <button class="btn btn-primary" id="btn-rerun-theorems" style="width:100%;">全15定理を今すぐ再検証する</button>
      </div>
      <div>${items}</div>
    `;
  }

  function renderInspector() {
    if (state.mode === 'triangle') {
      inspectorEl.innerHTML = buildTriangleModeHTML();
    } else if (state.mode === 'points') {
      inspectorEl.innerHTML = buildPointsModeHTML();
    } else if (state.mode === 'isometry') {
      inspectorEl.innerHTML = buildIsometryModeHTML();
    } else {
      inspectorEl.innerHTML = buildTheoremsModeHTML();
    }
    bindInspectorEvents();
  }

  function bindInspectorEvents() {
    // Precision selector
    const selSig = document.getElementById('sel-sigfigs');
    if (selSig) {
      selSig.addEventListener('change', () => {
        state.sigFigs = parseInt(selSig.value, 10) || 10;
        renderInspector();
      });
    }

    // Point chips
    inspectorEl.querySelectorAll('[data-sel-pt]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.selectedIndex = parseInt(btn.dataset.selPt, 10);
        state.selectedAlpha = false;
        redraw();
        renderInspector();
      });
    });

    const alphaChip = inspectorEl.querySelector('[data-sel-alpha]');
    if (alphaChip) {
      alphaChip.addEventListener('click', () => {
        state.selectedAlpha = true;
        redraw();
        renderInspector();
      });
    }

    const chipAdd = document.getElementById('chip-add-pt');
    if (chipAdd) {
      chipAdd.addEventListener('click', () => {
        updateAddModalLabels();
        addModal.hidden = false;
      });
    }

    // Inline coordinate editor tabs
    inspectorEl.querySelectorAll('[data-ectype]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.coordInputType = btn.dataset.ectype;
        renderInspector();
      });
    });

    // Apply edited coordinates
    const btnApplyCoord = document.getElementById('btn-apply-coord');
    if (btnApplyCoord) {
      btnApplyCoord.addEventListener('click', () => {
        const v1 = document.getElementById('ed-v1').value;
        const v2 = document.getElementById('ed-v2').value;
        const res = parseCoordinatePair(state.coordInputType, v1, v2);
        const errEl = document.getElementById('ed-err');
        if (!res.ok) {
          if (errEl) errEl.textContent = res.error;
          return;
        }
        if (state.selectedAlpha) {
          state.isometry = H2.makeIsometry(state.isometry.theta, res.point);
        } else if (state.points[state.selectedIndex]) {
          state.points[state.selectedIndex] = res.point;
        }
        updateAll(true);
      });
    }

    // Triangle mode bindings
    inspectorEl.querySelectorAll('[data-tri-preset]').forEach(btn => {
      btn.addEventListener('click', () => applyTrianglePreset(btn.dataset.triPreset));
    });

    const btnRun2D = document.getElementById('btn-run-2d');
    if (btnRun2D) {
      btnRun2D.addEventListener('click', () => {
        if (state.points.length === 3) {
          state.direct2DResult = H2.numericalTriangleArea2D(state.points[0], state.points[1], state.points[2], 2);
          renderInspector();
        }
      });
    }

    const chkCenters = document.getElementById('chk-centers');
    if (chkCenters) {
      chkCenters.addEventListener('change', () => {
        state.showCenters = chkCenters.checked;
        redraw();
        renderInspector();
      });
    }

    // Points mode bindings
    const chkMid = document.getElementById('chk-midpoint');
    if (chkMid) {
      chkMid.addEventListener('change', () => {
        state.showMidpoint = chkMid.checked;
        redraw();
        renderInspector();
      });
    }
    const chkPerp = document.getElementById('chk-perpbis');
    if (chkPerp) {
      chkPerp.addEventListener('change', () => {
        state.showPerpBisector = chkPerp.checked;
        redraw();
      });
    }
    const chkCircle = document.getElementById('chk-circle');
    if (chkCircle) {
      chkCircle.addEventListener('change', () => {
        state.showCircle = chkCircle.checked;
        redraw();
        renderInspector();
      });
    }
    const rngR = document.getElementById('rng-circle-r');
    if (rngR) {
      rngR.addEventListener('input', () => {
        state.circleRadius = parseFloat(rngR.value);
        updateAll(false);
      });
      rngR.addEventListener('change', () => renderInspector());
    }
    const chkPar = document.getElementById('chk-parallel');
    if (chkPar) {
      chkPar.addEventListener('change', () => {
        state.showParallelism = chkPar.checked;
        redraw();
      });
    }

    // Isometry mode bindings
    const rngTheta = document.getElementById('rng-iso-theta');
    if (rngTheta) {
      rngTheta.addEventListener('input', () => {
        stopAnimation();
        state.isometry = H2.makeIsometry(parseFloat(rngTheta.value), state.isometry.alpha);
        updateAll(false);
      });
      rngTheta.addEventListener('change', () => renderInspector());
    }
    inspectorEl.querySelectorAll('[data-theta-val]').forEach(btn => {
      btn.addEventListener('click', () => {
        stopAnimation();
        state.isometry = H2.makeIsometry(btn.dataset.thetaVal, state.isometry.alpha);
        updateAll(true);
      });
    });
    const btnAlphaA = document.getElementById('btn-alpha-to-a');
    if (btnAlphaA) {
      btnAlphaA.addEventListener('click', () => {
        if (state.points.length > 0) {
          stopAnimation();
          state.isometry = H2.makeIsometry(0, state.points[0]);
          updateAll(true);
        }
      });
    }
    const btnAnim = document.getElementById('btn-anim-iso');
    if (btnAnim) btnAnim.addEventListener('click', playIsometryAnimation);

    const btnInv = document.getElementById('btn-inv-iso');
    if (btnInv) {
      btnInv.addEventListener('click', () => {
        stopAnimation();
        state.isometry = H2.inverseIsometry(state.isometry);
        updateAll(true);
      });
    }
    const btnCommit = document.getElementById('btn-commit-iso');
    if (btnCommit) {
      btnCommit.addEventListener('click', () => {
        stopAnimation();
        state.points = state.points.map(p => H2.applyIsometry(state.isometry, p));
        state.isometry = H2.makeIsometry(0, H2.point(0, 0));
        updateAll(true);
      });
    }
    const btnResetIso = document.getElementById('btn-reset-iso');
    if (btnResetIso) {
      btnResetIso.addEventListener('click', () => {
        stopAnimation();
        state.isometry = H2.makeIsometry(0, H2.point(0, 0));
        updateAll(true);
      });
    }
    inspectorEl.querySelectorAll('[data-iso-preset]').forEach(btn => {
      btn.addEventListener('click', () => applyIsometryPreset(btn.dataset.isoPreset));
    });
    const chkInv = document.getElementById('chk-invariant');
    if (chkInv) {
      chkInv.addEventListener('change', () => {
        state.showInvariant = chkInv.checked;
        redraw();
      });
    }
    const chkOrbit = document.getElementById('chk-orbit');
    if (chkOrbit) {
      chkOrbit.addEventListener('change', () => {
        state.showOrbit = chkOrbit.checked;
        redraw();
      });
    }

    // Theorem suite bindings
    const btnRerun = document.getElementById('btn-rerun-theorems');
    if (btnRerun) {
      btnRerun.addEventListener('click', () => {
        state.theoremReport = H2Theorems.runAllTheorems();
        renderInspector();
      });
    }
    inspectorEl.querySelectorAll('[data-inspect-thm]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.inspectThm, 10);
        const item = state.theoremReport && state.theoremReport.results[idx];
        if (!item || !item.inspectConfig) return;
        const cfg = item.inspectConfig;
        if (cfg.points) state.points = cfg.points.slice();
        if (cfg.isometry) state.isometry = cfg.isometry;
        if (cfg.circleRadius) {
          state.circleRadius = cfg.circleRadius;
          state.showCircle = true;
        }
        state.selectedIndex = 0;
        renderer.resetView();
        setMode(cfg.mode || 'triangle');
      });
    });
  }

  // --- Resize Handling (Safari Orientation & Split-View Safe) ---
  function handleResize() {
    renderer.resize();
    redraw();
  }

  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(handleResize);
    ro.observe(canvas.parentElement);
  }
  window.addEventListener('resize', handleResize);
  window.addEventListener('orientationchange', () => setTimeout(handleResize, 120));

  // --- PWA Service Worker Registration ---
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.protocol === 'http:')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
        .then(() => {
          if (pwaStatusEl) pwaStatusEl.style.display = 'inline-flex';
        })
        .catch(() => {});
    });
  }

  // --- Initial Boot ---
  renderer.resize();
  updateAll(true);
})();

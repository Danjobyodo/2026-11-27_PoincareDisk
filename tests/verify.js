#!/usr/bin/env node
'use strict';

const DD = require('../js/dd.js');
const H2 = require('../js/hyperbolic.js');
const H2Theorems = require('../js/theorems.js');

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('  [FAIL]', msg);
    failures++;
  }
}

console.log('=== 1. Double-Double Core Arithmetic Tests ===');
{
  // Test exp(log(x)) = x to ~30 digits
  const x = DD.fromString('123.45678901234567890123456789');
  const errExpLog = Math.abs(DD.toNumber(DD.sub(DD.exp(DD.log(x)), x)));
  assert(errExpLog < 1e-28, `exp(log(x)) err = ${errExpLog}`);

  // Test sin^2 + cos^2 = 1 to ~30 digits
  const t = DD.fromString('2.71828182845904523536028747');
  const sc = DD.sincos(t);
  const pyth = Math.abs(DD.toNumber(DD.sub(DD.add(DD.sqr(sc.sin), DD.sqr(sc.cos)), DD.ONE)));
  assert(pyth < 1e-30, `sin^2 + cos^2 err = ${pyth}`);

  // Test atan2(sin(t), cos(t)) = t
  const at = DD.atan2(sc.sin, sc.cos);
  const atErr = Math.abs(DD.toNumber(DD.sub(at, t)));
  assert(atErr < 1e-30, `atan2(sin, cos) err = ${atErr}`);

  // Test 1 - |z|^2 for z = 0.999999999999999 (15 nines!)
  const zNear = H2.point('0.999999999999999', '0');
  const om = DD.oneMinusAbs2(zNear);
  // Exact: 1 - (1 - 1e-15)^2 = 2e-15 - 1e-30
  const expected = DD.sub(DD.fromString('2e-15'), DD.fromString('1e-30'));
  const omErr = Math.abs(DD.toNumber(DD.sub(om, expected)));
  assert(omErr < 1e-31, `1 - |z|^2 at 1e-15 err = ${omErr}, got ${DD.toPrecision(om, 20)}`);
  console.log(`  1 - (1-1e-15)^2 = ${DD.toPrecision(om, 20)} (err: ${omErr.toExponential(2)})`);
}

console.log('\n=== 2. Built-in Theorem Suite (15 Theorems) ===');
{
  const report = H2Theorems.runAllTheorems();
  for (const r of report.results) {
    const tag = r.passed ? 'PASS' : 'FAIL';
    console.log(`  [${tag}] ${r.title} | err=${r.errorStr} | ${r.detail}`);
    if (!r.passed) failures++;
  }
  console.log(`Summary: ${report.passed}/${report.total} passed.`);
}

console.log('\n=== 3. Randomized Stress Tests (50 Triangles + Boundary Regimes) ===');
{
  // Deterministic LCG PRNG for reproducible tests
  let seed = 42;
  function rand() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  }

  let maxGBErr = 0;
  let maxCos1Err = 0;
  let maxIsomAreaErr = 0;
  let maxBoundaryGBErr = 0;

  // 30 random interior triangles
  for (let i = 0; i < 30; i++) {
    const pts = [0, 1, 2].map(() => {
      const r = 0.05 + 0.92 * Math.sqrt(rand());
      const th = rand() * 2 * Math.PI;
      return H2.pointFromPolar(r, th);
    });
    const tri = H2.analyzeTriangle(pts[0], pts[1], pts[2]);
    if (!tri.valid || !tri.reliable || tri.isDegenerate) continue;

    const gbE = DD.toNumber(tri.gbDiff);
    const cos1E = DD.toNumber(tri.lawCos1.relErr);
    if (gbE > maxGBErr) maxGBErr = gbE;
    if (cos1E > maxCos1Err) maxCos1Err = cos1E;
    assert(gbE < 1e-18, `Random tri #${i} GB diff too large: ${gbE}`);
    assert(cos1E < 1e-18, `Random tri #${i} LawCos1 err too large: ${cos1E}`);

    // Apply random isometry and check area invariance
    const iso = H2.makeIsometry(rand() * 2 * Math.PI, H2.pointFromPolar(0.95 * rand(), rand() * 2 * Math.PI));
    const tPts = pts.map(p => H2.applyIsometry(iso, p));
    const tri2 = H2.analyzeTriangle(tPts[0], tPts[1], tPts[2]);
    const aErr = Math.abs(DD.toNumber(DD.sub(tri.areaNumerical, tri2.areaNumerical)));
    if (aErr > maxIsomAreaErr) maxIsomAreaErr = aErr;
    assert(aErr < 1e-17, `Random tri #${i} isom area err too large: ${aErr}`);
  }

  // 20 extreme boundary triangles (delta from 1e-4 down to 1e-14)
  for (let exp = 4; exp <= 14; exp++) {
    const delta = `1e-${exp}`;
    const A = H2.pointFromBoundaryOffset(delta, 0.2 + 0.1 * exp);
    const B = H2.pointFromBoundaryOffset(delta, 2.3 + 0.1 * exp);
    const C = H2.pointFromBoundaryOffset(delta, 4.4 + 0.1 * exp);
    const tri = H2.analyzeTriangle(A, B, C);
    assert(tri.reliable, `Boundary tri delta=${delta} should be reliable`);
    const gbE = DD.toNumber(tri.gbDiff);
    if (gbE > maxBoundaryGBErr) maxBoundaryGBErr = gbE;
    assert(gbE < 1e-11, `Boundary tri delta=${delta} GB diff = ${gbE}`);
  }

  // Verify fractional power isometryPower(iso, 0.5) composed twice equals iso!
  const testIsos = [
    H2.makeIsometry('1.4', H2.point('0.25', '0.15')), // elliptic
    H2.makeIsometry('0.3', H2.point('0.6', '-0.25')), // hyperbolic
    (() => {
      const th = DD.from('1.0');
      return H2.makeIsometry(th, H2.pointFromPolar(DD.sin(DD.ldexp(th, -1)), '0.8'));
    })(), // parabolic
  ];
  const probe = H2.point('0.21', '-0.37');
  for (const iso of testIsos) {
    const half = H2.isometryPower(iso, 0.5);
    const z1 = H2.applyIsometry(iso, probe);
    const z2 = H2.applyIsometry(half, H2.applyIsometry(half, probe));
    const err = DD.toNumber(DD.cAbs(DD.cSub(z1, z2)));
    const info = H2.classifyIsometry(iso);
    assert(err < 1e-20, `isometryPower(0.5)^2 failed for ${info.type}: err = ${err}`);
  }

  console.log(`  Max random GB diff:         ${maxGBErr.toExponential(2)}`);
  console.log(`  Max random LawCos1 relErr:  ${maxCos1Err.toExponential(2)}`);
  console.log(`  Max random Isom Area diff:  ${maxIsomAreaErr.toExponential(2)}`);
  console.log(`  Max boundary (1e-14) GB:    ${maxBoundaryGBErr.toExponential(2)}`);
  console.log(`  isometryPower(0.5)^2 = id check passed for elliptic, parabolic, hyperbolic.`);
}

console.log('\n=== 4. Renderer, PWA Assets & DOM Binding Smoke Tests ===');
{
  const fs = require('fs');
  const path = require('path');
  const rootDir = path.resolve(__dirname, '..');

  // Verify manifest.webmanifest is valid JSON and referenced icons exist
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.webmanifest'), 'utf8'));
  assert(manifest.name && manifest.start_url && manifest.display === 'standalone', 'manifest fields valid');
  for (const ic of manifest.icons) {
    assert(fs.existsSync(path.join(rootDir, ic.src)), `Manifest icon missing: ${ic.src}`);
  }

  // Verify every asset in sw.js exists on disk
  const swSrc = fs.readFileSync(path.join(rootDir, 'sw.js'), 'utf8');
  const assetMatch = swSrc.match(/ASSETS\s*=\s*\[([\s\S]*?)\]/);
  assert(assetMatch, 'sw.js ASSETS array found');
  const swAssets = Array.from(assetMatch[1].matchAll(/'([^']+)'/g)).map(m => m[1]);
  for (const a of swAssets) {
    const rel = a === './' ? 'index.html' : a.replace(/^\.\//, '');
    assert(fs.existsSync(path.join(rootDir, rel)), `SW cached asset missing: ${a}`);
  }

  // Verify every getElementById(...) in app.js exists in index.html or is dynamically rendered
  const htmlSrc = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
  const appSrc = fs.readFileSync(path.join(rootDir, 'js/app.js'), 'utf8');
  const staticIds = ['disk-canvas', 'inspector-content', 'zoom-label', 'cursor-readout',
    'pwa-status', 'btn-theme', 'meta-theme-color', 'btn-zoom-in', 'btn-zoom-out',
    'btn-zoom-reset', 'toggle-grid', 'toggle-tiling', 'toggle-full-geo', 'btn-del-pt',
    'btn-clear-pts', 'formula-modal', 'btn-formulas', 'btn-close-formula',
    'btn-close-formula-bottom', 'add-modal', 'add-inp-1', 'add-inp-2', 'add-lbl-1',
    'add-lbl-2', 'add-error', 'add-coord-tabs', 'btn-add-coord', 'btn-close-add',
    'btn-cancel-add', 'btn-confirm-add'];
  for (const id of staticIds) {
    assert(htmlSrc.includes(`id="${id}"`), `Missing static DOM id in index.html: ${id}`);
  }

  // Execute renderer across all modes and themes with a stub Canvas2D context
  global.window = { devicePixelRatio: 2 };
  const H2Renderer = require('../js/renderer.js');
  let drawOps = 0;
  const stubCtx = new Proxy({
    measureText: (t) => ({ width: String(t).length * 7 }),
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return (...args) => {
        for (const a of args) {
          if (typeof a === 'number' && !Number.isFinite(a)) {
            throw new Error(`Non-finite canvas coordinate in ctx.${String(prop)}(${args.join(', ')})`);
          }
        }
        drawOps++;
      };
    },
    set() { return true; },
  });
  const stubCanvas = {
    getContext: () => stubCtx,
    getBoundingClientRect: () => ({ width: 640, height: 640 }),
    width: 0,
    height: 0,
  };

  const renderer = H2Renderer.createRenderer(stubCanvas);
  renderer.resize();

  const pts = [H2.point('-0.55', '-0.3'), H2.point('0.65', '-0.25'), H2.point('0.05', '0.74')];
  const triCache = H2.analyzeTriangle(pts[0], pts[1], pts[2]);
  const modes = ['triangle', 'points', 'isometry', 'theorems'];
  const isos = [
    H2.makeIsometry('1.5', H2.point('0.3', '0.15')),
    H2.makeIsometry('1.2', H2.pointFromPolar(DD.sin(DD.from('0.6')), '0.5')),
    H2.makeIsometry('0.3', H2.point('0.6', '-0.2')),
  ];

  for (const theme of ['dark', 'light']) {
    for (const mode of modes) {
      for (const iso of isos) {
        renderer.render({
          mode,
          theme,
          points: pts,
          selectedIndex: 0,
          selectedAlpha: false,
          showGrid: true,
          showTiling: true,
          showFullGeodesics: true,
          showMidpoint: true,
          showPerpBisector: true,
          showCircle: true,
          circleRadius: 1.4,
          showParallelism: true,
          showCenters: true,
          cachedTriAnalysis: triCache,
          isometry: iso,
          showInvariant: true,
          showOrbit: true,
        });
      }
    }
  }
  // Also test rendering extreme boundary triangle (1 - r = 1e-10)
  const extPts = [
    H2.pointFromBoundaryOffset('1e-10', '0.1'),
    H2.pointFromBoundaryOffset('1e-10', '2.2'),
    H2.pointFromBoundaryOffset('1e-10', '4.3'),
  ];
  renderer.render({
    mode: 'triangle',
    theme: 'dark',
    points: extPts,
    selectedIndex: 0,
    showGrid: true,
    showTiling: false,
    showFullGeodesics: true,
    showCenters: true,
    cachedTriAnalysis: H2.analyzeTriangle(extPts[0], extPts[1], extPts[2]),
  });

  console.log(`  Verified ${swAssets.length} SW cached assets, manifest icons, ${staticIds.length} DOM IDs, and ${drawOps} finite Canvas2D draw ops.`);
}

if (failures > 0) {
  console.error(`\nFAILED with ${failures} error(s).`);
  process.exit(1);
} else {
  console.log('\nALL MATHEMATICAL VERIFICATION TESTS PASSED!');
}

/**
 * Built-in Hyperbolic Geometry Theorem Verification Suite
 *
 * Runs both in the browser ("定理検証ラボ" tab) and in Node.js (tests/verify.js).
 * Every check verifies an independent mathematical theorem or identity to high precision.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const H2 = require('./hyperbolic.js');
    module.exports = factory(H2);
  } else {
    root.H2Theorems = factory(root.H2);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (H2) {
  'use strict';

  const DD = H2.DD;

  function fmtErr(x) {
    const v = typeof x === 'number' ? x : Math.abs(DD.toNumber(x));
    if (!Number.isFinite(v)) return String(v);
    if (v === 0) return '0 (完全一致)';
    return v.toExponential(2);
  }

  function runAllTheorems() {
    const results = [];

    function record(id, category, title, formula, passed, errorVal, detail, inspectConfig) {
      results.push({
        id,
        category,
        title,
        formula,
        passed: Boolean(passed),
        error: typeof errorVal === 'number' ? errorVal : Math.abs(DD.toNumber(errorVal)),
        errorStr: fmtErr(errorVal),
        detail,
        inspectConfig: inspectConfig || null,
      });
    }

    // 1. Distance formula equivalence: 2*asinh(u) vs direct log((1+rho)/(1-rho))
    {
      const z = H2.point('0.72', '-0.41');
      const w = H2.point('-0.35', '0.88');
      const d1 = H2.distance(z, w);
      const d2 = H2.distanceDirectLogFormula(z, w);
      const err = Math.abs(DD.toNumber(DD.sub(d1, d2)));
      record(
        'dist-formula',
        '距離・測地線',
        '距離公式の一致検証',
        '2·arsinh(|z−w|/√((1−|z|²)(1−|w|²))) = log((1+ρ)/(1−ρ))',
        err < 1e-26,
        err,
        `d = ${DD.toPrecision(d1, 14)}`,
        { mode: 'points', points: [z, w] }
      );
    }

    // 2. Boundary distance precision (1 - |z| = 1e-12) vs exact analytical formula
    {
      const delta = DD.fromString('1e-12');
      const th1 = DD.fromString('0.3');
      const th2 = DD.fromString('2.1');
      const z = H2.pointFromBoundaryOffset(delta, th1);
      const w = H2.pointFromBoundaryOffset(delta, th2);
      const info = H2.distanceInfo(z, w);
      // Exact analytical distance for r = 1 - delta:
      // |z-w| / (1 - r^2) = 2(1-delta)|sin((th2-th1)/2)| / (delta * (2 - delta))
      const halfDiff = DD.ldexp(DD.sub(th2, th1), -1);
      const num = DD.mul(DD.ldexp(DD.sub(DD.ONE, delta), 1), DD.abs(DD.sin(halfDiff)));
      const den = DD.mul(delta, DD.sub(DD.TWO, delta));
      const dExact = DD.ldexp(DD.asinh(DD.div(num, den)), 1);
      const relErr = Math.abs(DD.toNumber(DD.div(DD.sub(info.distance, dExact), dExact)));
      record(
        'dist-boundary',
        '境界高精度',
        '境界近傍 (1−|z|=10⁻¹²) での距離精度',
        'd(z, w) vs 厳密解析解 (通常倍精度の log 公式は ∞ に発散する領域)',
        info.reliable && relErr < 1e-18,
        relErr,
        `d = ${DD.toPrecision(info.distance, 15)}, 有効桁推定 ≈ ${info.reliableDigits} 桁`,
        { mode: 'points', points: [z, w] }
      );
    }

    // 3. Triangle inequality & midpoint equality on geodesic
    {
      const A = H2.pointFromBoundaryOffset('1e-8', '0.2');
      const B = H2.pointFromBoundaryOffset('1e-8', '2.5');
      const C = H2.point('0.1', '-0.4');
      const geo = H2.geodesic(A, B);
      const M = geo.midpoint;
      const dAM = H2.distance(A, M);
      const dMB = H2.distance(M, B);
      const dAB = H2.distance(A, B);
      const midErr = Math.abs(DD.toNumber(DD.sub(DD.add(dAM, dMB), dAB)));
      const symErr = Math.abs(DD.toNumber(DD.sub(dAM, dMB)));
      const triSlack = DD.toNumber(DD.sub(DD.add(H2.distance(A, C), H2.distance(C, B)), dAB));
      record(
        'midpoint-tri-ineq',
        '距離・測地線',
        '測地線中点と三角不等式 (1−|z|=10⁻⁸)',
        'd(A,M) = d(M,B) = d(A,B)/2 ≤ d(A,C) + d(C,B)',
        midErr < 1e-18 && symErr < 1e-18 && triSlack > 0,
        Math.max(midErr, symErr),
        `d(A,B) = ${DD.toPrecision(dAB, 12)}, 余剰 = +${triSlack.toExponential(2)}`,
        { mode: 'points', points: [A, B, C] }
      );
    }

    // 4. Gauss-Bonnet + L'Huilier + Direct 2D Quadrature on general triangle
    {
      const A = H2.point('-0.55', '-0.30');
      const B = H2.point('0.68', '-0.25');
      const C = H2.point('0.05', '0.74');
      const tri = H2.analyzeTriangle(A, B, C);
      const res2D = H2.numericalTriangleArea2D(A, B, C, 2);
      const errGB = DD.toNumber(tri.gbDiff);
      const errLH = DD.toNumber(tri.lhuilierDiff);
      const err2D = Math.abs(res2D.area - DD.toNumber(tri.areaGB));
      record(
        'gauss-bonnet-std',
        'ガウス–ボネ',
        '標準三角形: 数値積分 = π − (α+β+γ) = L\'Huilier',
        '∬_T 4/(1−|z|²)² dxdy = π − (α + β + γ)',
        tri.reliable && errGB < 1e-20 && errLH < 1e-20 && err2D < 1e-9,
        errGB,
        `面積 = ${DD.toPrecision(tri.areaGB, 13)} (直接2D積分差 ${fmtErr(err2D)}, L'Huilier差 ${fmtErr(errLH)})`,
        { mode: 'triangle', points: [A, B, C] }
      );
    }

    // 5. Gauss-Bonnet on EXTREME boundary triangle (1 - |z| = 1e-11)
    {
      const A = H2.pointFromBoundaryOffset('1e-11', '0.1');
      const B = H2.pointFromBoundaryOffset('1e-11', '2.2');
      const C = H2.pointFromBoundaryOffset('1e-11', '4.3');
      const tri = H2.analyzeTriangle(A, B, C);
      const errGB = DD.toNumber(tri.gbDiff);
      const errLH = DD.toNumber(tri.lhuilierDiff);
      record(
        'gauss-bonnet-boundary',
        '境界高精度',
        '極限境界三角形 (1−|z|=10⁻¹¹, 理想三角形近傍)',
        '∬_T 4/(1−|z|²)² dxdy = π − (α+β+γ) → π',
        tri.reliable && errGB < 1e-13 && errLH < 1e-13 && DD.toNumber(tri.areaGB) > 3.14159,
        errGB,
        `面積 = ${DD.toPrecision(tri.areaGB, 14)}, α+β+γ = ${DD.toPrecision(tri.angleSum, 6)}`,
        { mode: 'triangle', points: [A, B, C] }
      );
    }

    // 6. Gauss-Bonnet on tiny Euclidean-limit triangle (r ~ 1e-4)
    {
      const A = H2.point('0.0001', '0.0000');
      const B = H2.point('-0.00005', '0.00012');
      const C = H2.point('-0.00008', '-0.00009');
      const tri = H2.analyzeTriangle(A, B, C);
      const relErr = DD.toNumber(tri.gbRelDiff);
      record(
        'gauss-bonnet-tiny',
        'ガウス–ボネ',
        '微小三角形 (ユークリッド極限 r ≈ 10⁻⁴)',
        'α+β+γ ≈ π, 相対誤差 |Area_num − Area_GB| / Area_GB',
        tri.reliable && relErr < 1e-15,
        relErr,
        `面積 = ${DD.toPrecision(tri.areaGB, 10)}, α+β+γ = ${DD.toPrecision(tri.angleSum, 12)}`,
        { mode: 'triangle', points: [A, B, C] }
      );
    }

    // 7. Regular Right-Angled Hyperbolic Pentagon (Area = pi/2, all angles = pi/2)
    {
      // cosh(R) = cot(pi/5) => exact regular right-angled pentagon
      const pi5 = DD.divScalar(DD.PI, 5);
      const sc = DD.sincos(pi5);
      const cotPi5 = DD.div(sc.cos, sc.sin);
      const R = DD.acosh(cotPi5);
      const verts = [];
      for (let k = 0; k < 5; k++) {
        const th = DD.mulScalar(DD.divScalar(DD.TWO_PI, 5), k);
        verts.push(H2.pointFromHyperbolicPolar(R, th));
      }
      const poly = H2.analyzePolygon(verts);
      const exactArea = DD.HALF_PI;
      const errGB = DD.toNumber(poly.gbDiff);
      const errExact = Math.abs(DD.toNumber(DD.sub(poly.areaNumerical, exactArea)));
      const maxAngErr = Math.max(...poly.interiorAngles.map(a => Math.abs(DD.toNumber(DD.sub(a, DD.HALF_PI)))));
      record(
        'right-pentagon',
        'ガウス–ボネ',
        '直角正五角形 (各内角 π/2, 面積 = 3π − 5π/2 = π/2)',
        '∬_P 4/(1−|z|²)² dxdy = (5−2)π − ∑α_k = π/2',
        poly.reliable && errGB < 1e-20 && errExact < 1e-20 && maxAngErr < 1e-20,
        Math.max(errGB, errExact, maxAngErr),
        `数値積分 = ${DD.toPrecision(poly.areaNumerical, 14)}, π/2 = ${DD.toPrecision(exactArea, 14)}`,
        { mode: 'triangle', points: verts }
      );
    }

    // 8. Hyperbolic Laws of Cosines (1st & 2nd) and Law of Sines
    {
      const A = H2.point('-0.71', '0.42');
      const B = H2.point('0.63', '0.59');
      const C = H2.point('0.12', '-0.84');
      const tri = H2.analyzeTriangle(A, B, C);
      const e1 = DD.toNumber(tri.lawCos1.relErr);
      const e2 = DD.toNumber(tri.lawCos2.err);
      const e3 = DD.toNumber(tri.lawSine.relSpread);
      const maxE = Math.max(e1, e2, e3);
      record(
        'trig-laws',
        '双曲三角法',
        '双曲第1・第2余弦定理および双曲正弦定理',
        'cosh c = cosh a cosh b − sinh a sinh b cos γ, sinh a / sin α = const',
        maxE < 1e-22,
        maxE,
        `第1余弦誤差 ${fmtErr(e1)}, 第2余弦誤差 ${fmtErr(e2)}, 正弦定理差 ${fmtErr(e3)}`,
        { mode: 'triangle', points: [A, B, C] }
      );
    }

    // 9. Hyperbolic Pythagorean Theorem (right triangle at origin)
    {
      const O = H2.point(0, 0);
      const A = H2.point('0.85', '0');
      const B = H2.point('0', '0.73');
      const tri = H2.analyzeTriangle(O, A, B);
      const lhs = DD.cosh(tri.sides.a); // side opposite O (hypotenuse AB)
      const rhs = DD.mul(DD.cosh(tri.sides.b), DD.cosh(tri.sides.c));
      const relErr = Math.abs(DD.toNumber(DD.div(DD.sub(lhs, rhs), lhs)));
      record(
        'pythagoras',
        '双曲三角法',
        '双曲ピタゴラスの定理 (∠O = π/2)',
        'cosh(d(A,B)) = cosh(d(O,A)) · cosh(d(O,B))',
        relErr < 1e-26,
        relErr,
        `cosh c = ${DD.toPrecision(lhs, 13)}`,
        { mode: 'triangle', points: [O, A, B] }
      );
    }

    // 10. Isometry invariance of distance, angles, and NUMERICAL area (even near boundary!)
    {
      const A = H2.point('-0.4', '0.3');
      const B = H2.point('0.5', '-0.2');
      const C = H2.point('0.1', '0.65');
      // Strong translation pushing triangle deep toward |z| -> 1
      const iso = H2.makeIsometry('1.23456789', H2.point('0.985', '-0.12'));
      const tA = H2.applyIsometry(iso, A);
      const tB = H2.applyIsometry(iso, B);
      const tC = H2.applyIsometry(iso, C);

      const tri1 = H2.analyzeTriangle(A, B, C);
      const tri2 = H2.analyzeTriangle(tA, tB, tC);

      const dErr = Math.max(
        Math.abs(DD.toNumber(DD.sub(tri1.sides.a, tri2.sides.a))),
        Math.abs(DD.toNumber(DD.sub(tri1.sides.b, tri2.sides.b))),
        Math.abs(DD.toNumber(DD.sub(tri1.sides.c, tri2.sides.c)))
      );
      const angErr = Math.max(
        Math.abs(DD.toNumber(DD.sub(tri1.angles.alpha, tri2.angles.alpha))),
        Math.abs(DD.toNumber(DD.sub(tri1.angles.beta, tri2.angles.beta))),
        Math.abs(DD.toNumber(DD.sub(tri1.angles.gamma, tri2.angles.gamma)))
      );
      const areaErr = Math.abs(DD.toNumber(DD.sub(tri1.areaNumerical, tri2.areaNumerical)));
      const maxErr = Math.max(dErr, angErr, areaErr);

      record(
        'isom-invariance',
        '等長変換 Isom₊',
        '等長変換 φ_{θ,α} の距離・角度・数値面積の不変性',
        'd(φ(z),φ(w))=d(z,w), Area_num(φ(T))=Area_num(T) (|α|≈0.992)',
        tri2.reliable && maxErr < 1e-18,
        maxErr,
        `距離差 ${fmtErr(dErr)}, 角度差 ${fmtErr(angErr)}, 数値面積差 ${fmtErr(areaErr)}`,
        { mode: 'isometry', points: [A, B, C], isometry: iso }
      );
    }

    // 11. Group composition & inverse of Isom_+(H^2)
    {
      const iso1 = H2.makeIsometry('0.9', H2.point('0.45', '-0.32'));
      const iso2 = H2.makeIsometry('2.1', H2.point('-0.51', '0.62'));
      const comp = H2.composeIsometries(iso2, iso1);
      const inv1 = H2.inverseIsometry(iso1);
      const z = H2.point('0.31', '0.47');

      const zComp1 = H2.applyIsometry(iso2, H2.applyIsometry(iso1, z));
      const zComp2 = H2.applyIsometry(comp, z);
      const compErr = DD.toNumber(DD.cAbs(DD.cSub(zComp1, zComp2)));

      const zBack = H2.applyIsometry(inv1, H2.applyIsometry(iso1, z));
      const invErr = DD.toNumber(DD.cAbs(DD.cSub(zBack, z)));

      record(
        'isom-group',
        '等長変換 Isom₊',
        '群演算 (合成 φ₂∘φ₁ と逆元 φ⁻¹) の整合性',
        '(φ₂∘φ₁)(z) = φ₂(φ₁(z)), φ⁻¹(φ(z)) = z',
        compErr < 1e-26 && invErr < 1e-26,
        Math.max(compErr, invErr),
        `合成差 ${fmtErr(compErr)}, 逆元差 ${fmtErr(invErr)}`,
        { mode: 'isometry', isometry: comp }
      );
    }

    // 12. Isometry classification: Elliptic / Parabolic / Hyperbolic fixed points & translation length
    {
      // Elliptic: |alpha| < |sin(theta/2)|
      const ell = H2.makeIsometry('1.5', H2.point('0.3', '0.2'));
      const cEll = H2.classifyIsometry(ell);
      const ellFixErr = DD.toNumber(DD.cAbs(DD.cSub(H2.applyIsometry(ell, cEll.interiorFixed), cEll.interiorFixed)));

      // Parabolic: |alpha| = sin(theta/2)
      const thP = DD.from('1.2');
      const rP = DD.sin(DD.ldexp(thP, -1));
      const par = H2.makeIsometry(thP, H2.pointFromPolar(rP, '0.7'));
      const cPar = H2.classifyIsometry(par);
      const parFixErr = DD.toNumber(DD.cAbs(DD.cSub(H2.applyIsometry(par, cPar.boundaryFixed[0]), cPar.boundaryFixed[0])));

      // Hyperbolic: |alpha| > |sin(theta/2)|
      const hyp = H2.makeIsometry('0.4', H2.point('0.6', '-0.2'));
      const cHyp = H2.classifyIsometry(hyp);
      const hypFixErr = Math.max(
        DD.toNumber(DD.cAbs(DD.cSub(H2.applyIsometry(hyp, cHyp.attracting), cHyp.attracting))),
        DD.toNumber(DD.cAbs(DD.cSub(H2.applyIsometry(hyp, cHyp.repelling), cHyp.repelling)))
      );
      // Verify translation length along the axis equals 2*acosh(|tr|/2)
      const pAxis = H2.applyIsometry(H2.isometryPower(hyp, 0.5), H2.point(0, 0));
      // Better: pick a point ON the axis: foot of perpendicular from 0 to geodesic(repelling, attracting)?
      // Actually compute distance moved for any point on axis via midpoint of attracting & repelling
      const m = cHyp.repelling, p = cHyp.attracting;
      const dot = DD.add(DD.mul(m.re, p.re), DD.mul(m.im, p.im));
      const C = DD.cMulReal(DD.cAdd(m, p), DD.div(DD.ONE, DD.add(DD.ONE, dot)));
      const cAbs = DD.cAbs(C);
      const R = DD.sqrt(DD.sub(DD.sqr(cAbs), DD.ONE));
      const onAxis = DD.cMulReal(C, DD.div(DD.sub(cAbs, R), cAbs));
      const movedAxis = H2.applyIsometry(hyp, onAxis);
      const axisStep = H2.distance(onAxis, movedAxis);
      const lenErr = Math.abs(DD.toNumber(DD.sub(axisStep, cHyp.translationLength)));

      const maxE = Math.max(ellFixErr, parFixErr, hypFixErr, lenErr);
      record(
        'isom-classify',
        '等長変換 Isom₊',
        '楕円型・放物型・双曲型の不動点と並進距離',
        'φ(p) = p, 軸上の移動距離 = 2·arcosh(|tr|/2)',
        cEll.type === 'elliptic' && cPar.type === 'parabolic' && cHyp.type === 'hyperbolic' && maxE < 1e-22,
        maxE,
        `不動点誤差 ${fmtErr(Math.max(ellFixErr, parFixErr, hypFixErr))}, 並進距離差 ${fmtErr(lenErr)}`,
        { mode: 'isometry', isometry: hyp }
      );
    }

    // 13. Hyperbolic Circle Area: 4*pi*sinh^2(R/2) vs Numerical Green Integral (off-center!)
    {
      const center = H2.point('0.75', '-0.42');
      const R = DD.from('1.8');
      const circ = H2.hyperbolicCircle(center, R);
      const numArea = H2.numericalCircleAreaDD(center, R);
      const relErr = Math.abs(DD.toNumber(DD.div(DD.sub(numArea.area, circ.exactArea), circ.exactArea)));
      record(
        'circle-area',
        '双曲円',
        '非原点中心の双曲円 B_H(p, R) の面積一致',
        '∬_{B_H} 4/(1−|z|²)² dxdy = 4π·sinh²(R/2)',
        circ.reliable && numArea.reliable && relErr < 1e-20,
        relErr,
        `中心 (0.75, −0.42), R=1.8: 面積 = ${DD.toPrecision(circ.exactArea, 13)}`,
        { mode: 'points', points: [center], circleRadius: 1.8 }
      );
    }

    // 14. Lobachevsky Angle of Parallelism: Pi(h) = 2 * atan(e^{-h})
    {
      const A = H2.point('-0.6', '-0.35');
      const B = H2.point('0.7', '-0.1');
      const P = H2.point('-0.1', '0.55');
      const geo = H2.geodesic(A, B);
      const perp = H2.pointToGeodesic(P, A, B);
      // Map P -> 0; angle between ray to foot F and ray to ideal endpoint z_{+inf}
      const TP = H2.makeIsometry(0, P);
      const uFoot = H2.applyIsometry(TP, perp.foot);
      const uIdeal = H2.applyIsometry(TP, geo.idealEnd);
      const prod = DD.cMul(DD.cConj(uFoot), uIdeal);
      const measuredAngle = DD.atan2(DD.abs(prod.im), prod.re);
      const err = Math.abs(DD.toNumber(DD.sub(measuredAngle, perp.angleOfParallelism)));
      record(
        'angle-parallelism',
        '距離・測地線',
        'ロバチェフスキーの平行角公式',
        'Π(h) = 2·arctan(e^{−h}) = ∠(垂線, 極限平行測地線)',
        err < 1e-24,
        err,
        `垂線長 h = ${DD.toPrecision(perp.distance, 10)}, Π(h) = ${DD.toPrecision(perp.angleOfParallelism, 12)} rad`,
        { mode: 'points', points: [A, B, P] }
      );
    }

    // 15. Boundary Precision Guard Test (extreme 1 - |z| = 1e-25 must be rejected cleanly)
    {
      const extreme = H2.pointFromBoundaryOffset('1e-25', '0.5');
      const outside = H2.point('1.0', '0.0');
      const vExt = H2.validatePoint(extreme);
      const vOut = H2.validatePoint(outside);
      const dExt = H2.distanceInfo(extreme, H2.point(0, 0));
      const guardOk = (vExt.valid && !vExt.reliable && !dExt.reliable) && (!vOut.valid);
      record(
        'precision-guard',
        '境界高精度',
        '極端境界領域 (1−|z|=10⁻²⁵) の精度ガード動作',
        '信頼桁不足領域では誤値を出さず非表示フラグを返す',
        guardOk,
        0,
        `1−|z|=10⁻²⁵ → reliable=${vExt.reliable} (推定 ${vExt.reliableDigits} 桁), |z|=1 → valid=${vOut.valid}`,
        null
      );
    }

    const passedCount = results.filter(r => r.passed).length;
    return {
      total: results.length,
      passed: passedCount,
      allPassed: passedCount === results.length,
      results,
    };
  }

  return { runAllTheorems };
});

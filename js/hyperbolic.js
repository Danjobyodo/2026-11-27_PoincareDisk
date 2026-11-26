/**
 * High-Precision Hyperbolic Geometry Engine on the Poincaré Disk Model
 *
 * Conventions (constant Gaussian curvature K = -1):
 *   H^2 = { z in C : |z| < 1 }
 *   d(z, w) = log( (1 + |(z-w)/(1-conj(z)*w)|) / (1 - |(z-w)/(1-conj(z)*w)|) )
 *   Isom_+(H^2) = { phi_{theta, alpha}(z) = e^{i*theta} * (z - alpha)/(1 - conj(alpha)*z) }
 *   Area(B) = double_integral_B 4 / (1 - |z|^2)^2 dx dy
 *
 * Uses 106-bit Double-Double arithmetic (H2DD) throughout to maintain high
 * significant-digit accuracy near the ideal boundary |z| -> 1, and explicitly
 * tracks precision bounds to suppress unreliable values in extreme regimes.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const DD = require('./dd.js');
    module.exports = factory(DD);
  } else {
    root.H2 = factory(root.H2DD);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (DD) {
  'use strict';

  const MIN_RELIABLE_DIGITS = 7;

  // --- 16-point Gauss-Legendre Nodes & Weights in 106-bit DD ---
  const GL16 = (function computeGL16() {
    const n = 16;
    const half = n / 2;
    const nodes = new Array(n);
    const weights = new Array(n);
    const nDD = DD.from(n);

    for (let i = 0; i < half; i++) {
      // Initial float64 approximation
      let x = DD.from(Math.cos(Math.PI * (i + 0.75) / (n + 0.5)));
      // Newton iterations on Legendre polynomial P_n(x) = 0
      for (let iter = 0; iter < 6; iter++) {
        let p0 = DD.ONE;
        let p1 = x;
        for (let k = 2; k <= n; k++) {
          const kDD = DD.from(k);
          const pk = DD.div(
            DD.sub(
              DD.mul(DD.from(2 * k - 1), DD.mul(x, p1)),
              DD.mul(DD.from(k - 1), p0)
            ),
            kDD
          );
          p0 = p1;
          p1 = pk;
        }
        // P'_n(x) = n * (x * P_n(x) - P_{n-1}(x)) / (x^2 - 1)
        const dp = DD.div(
          DD.mul(nDD, DD.sub(DD.mul(x, p1), p0)),
          DD.sub(DD.sqr(x), DD.ONE)
        );
        const dx = DD.div(p1, dp);
        x = DD.sub(x, dx);
        if (Math.abs(dx.hi) < 1e-31) break;
      }

      // Compute final P'_n(x) for weight w = 2 / ((1 - x^2) * (P'_n(x))^2)
      let p0 = DD.ONE;
      let p1 = x;
      for (let k = 2; k <= n; k++) {
        const pk = DD.div(
          DD.sub(
            DD.mul(DD.from(2 * k - 1), DD.mul(x, p1)),
            DD.mul(DD.from(k - 1), p0)
          ),
          DD.from(k)
        );
        p0 = p1;
        p1 = pk;
      }
      const oneMinusX2 = DD.sub(DD.ONE, DD.sqr(x));
      const dp = DD.div(
        DD.mul(nDD, DD.sub(p0, DD.mul(x, p1))),
        oneMinusX2
      );
      const w = DD.div(DD.TWO, DD.mul(oneMinusX2, DD.sqr(dp)));

      nodes[i] = DD.neg(x);
      weights[i] = w;
      nodes[n - 1 - i] = x;
      weights[n - 1 - i] = w;
    }
    return { nodes, weights };
  })();

  // --- Point Constructors & Precision Guard ---

  function point(x, y) {
    const re = typeof x === 'string' ? DD.fromString(x) : DD.from(x);
    const im = typeof y === 'string' ? DD.fromString(y) : DD.from(y || 0);
    return { re, im };
  }

  function pointFromPolar(r, theta) {
    const rDD = typeof r === 'string' ? DD.fromString(r) : DD.from(r);
    const tDD = typeof theta === 'string' ? DD.fromString(theta) : DD.from(theta);
    const sc = DD.sincos(tDD);
    return { re: DD.mul(rDD, sc.cos), im: DD.mul(rDD, sc.sin) };
  }

  /**
   * Constructs z = (1 - delta) * e^{i * theta} accurately in DD
   * even for tiny delta like 1e-15.
   */
  function pointFromBoundaryOffset(delta, theta) {
    const dDD = typeof delta === 'string' ? DD.fromString(delta) : DD.from(delta);
    const tDD = typeof theta === 'string' ? DD.fromString(theta) : DD.from(theta);
    const rDD = DD.sub(DD.ONE, dDD);
    const sc = DD.sincos(tDD);
    return { re: DD.mul(rDD, sc.cos), im: DD.mul(rDD, sc.sin) };
  }

  /**
   * Constructs z with hyperbolic distance rho from origin and argument theta:
   * |z| = tanh(rho / 2).
   */
  function pointFromHyperbolicPolar(rho, theta) {
    const rhoDD = typeof rho === 'string' ? DD.fromString(rho) : DD.from(rho);
    const tDD = typeof theta === 'string' ? DD.fromString(theta) : DD.from(theta);
    const rDD = DD.tanh(DD.ldexp(rhoDD, -1));
    const sc = DD.sincos(tDD);
    return { re: DD.mul(rDD, sc.cos), im: DD.mul(rDD, sc.sin) };
  }

  function toFloat(z) {
    return { x: DD.toNumber(z.re), y: DD.toNumber(z.im) };
  }

  function validatePoint(z) {
    if (!z || !DD.isFiniteDD(z.re) || !DD.isFiniteDD(z.im)) {
      return { valid: false, reliable: false, reason: 'invalid_number', oneMinusAbs2: DD.ZERO, reliableDigits: 0 };
    }
    const om = DD.oneMinusAbs2(z);
    if (!DD.isFiniteDD(om) || om.hi < 0 || (om.hi === 0 && om.lo <= 0)) {
      return { valid: false, reliable: false, reason: 'outside_disk', oneMinusAbs2: om, reliableDigits: 0 };
    }
    // 106-bit DD has ~31.9 decimal digits; cancellation in 1 - |z|^2 loses -log10(om) digits
    const loss = om.hi < 1 ? Math.max(0, -Math.log10(om.hi)) : 0;
    const reliableDigits = Math.max(0, Math.min(30, Math.floor(30.5 - loss)));
    const reliable = reliableDigits >= MIN_RELIABLE_DIGITS;
    return {
      valid: true,
      reliable,
      reason: reliable ? 'ok' : 'boundary_precision_limit',
      oneMinusAbs2: om,
      reliableDigits,
    };
  }

  function normalizeAngle2Pi(theta) {
    let t = theta;
    const k = Math.floor(DD.toNumber(t) / DD.toNumber(DD.TWO_PI));
    if (k !== 0) {
      t = DD.sub(t, DD.mulScalar(DD.TWO_PI, k));
    }
    while (t.hi < 0) t = DD.add(t, DD.TWO_PI);
    while (DD.cmp(t, DD.TWO_PI) >= 0) t = DD.sub(t, DD.TWO_PI);
    return t;
  }

  // --- Metric: Distance & Pseudo-Hyperbolic Distance ---

  /**
   * Computes pseudo-hyperbolic distance rho(z, w) = |(z - w) / (1 - conj(z) * w)|
   * and hyperbolic distance d(z, w) = log((1 + rho) / (1 - rho))
   * using the cancellation-free identity d(z, w) = 2 * asinh(|z-w| / sqrt((1-|z|^2)(1-|w|^2))).
   */
  function distanceInfo(z, w) {
    const vz = validatePoint(z);
    const vw = validatePoint(w);
    if (!vz.valid || !vw.valid) {
      return { reliable: false, reason: !vz.valid ? vz.reason : vw.reason, reliableDigits: 0 };
    }
    const diff = DD.cSub(z, w);
    const diffAbs = DD.cAbs(diff);
    if (DD.isZero(diffAbs)) {
      return {
        reliable: vz.reliable && vw.reliable,
        reason: (vz.reliable && vw.reliable) ? 'ok' : 'boundary_precision_limit',
        reliableDigits: Math.min(vz.reliableDigits, vw.reliableDigits),
        distance: DD.ZERO,
        pseudoDistance: DD.ZERO,
      };
    }

    const denomSqrt = DD.sqrt(DD.mul(vz.oneMinusAbs2, vw.oneMinusAbs2));
    const u = DD.div(diffAbs, denomSqrt);
    const dist = DD.ldexp(DD.asinh(u), 1);

    // Direct pseudo-hyperbolic distance rho = |(z - w) / (1 - conj(z) * w)|
    const oneMinusZbarW = DD.cSub({ re: DD.ONE, im: DD.ZERO }, DD.cMul(DD.cConj(z), w));
    const oneMinusAbs = DD.cAbs(oneMinusZbarW);
    const pseudo = DD.div(diffAbs, oneMinusAbs);

    const reliableDigits = Math.min(vz.reliableDigits, vw.reliableDigits);
    const reliable = reliableDigits >= MIN_RELIABLE_DIGITS && DD.isFiniteDD(dist);

    return {
      reliable,
      reason: reliable ? 'ok' : 'boundary_precision_limit',
      reliableDigits,
      distance: dist,
      pseudoDistance: pseudo,
    };
  }

  function distance(z, w) {
    const info = distanceInfo(z, w);
    return info.reliable ? info.distance : { hi: NaN, lo: NaN };
  }

  /**
   * Direct evaluation of user's formula log((1+rho)/(1-rho)) in DD,
   * useful for cross-verification against 2*asinh(u).
   */
  function distanceDirectLogFormula(z, w) {
    const num = DD.cSub(z, w);
    const den = DD.cSub({ re: DD.ONE, im: DD.ZERO }, DD.cMul(DD.cConj(z), w));
    const rho = DD.cAbs(DD.cDiv(num, den));
    const oneMinusRho = DD.sub(DD.ONE, rho);
    if (oneMinusRho.hi <= 0) return { hi: NaN, lo: NaN };
    return DD.log(DD.div(DD.add(DD.ONE, rho), oneMinusRho));
  }

  // --- Isometries: Isom_+(H^2) = { phi_{theta, alpha} } ---

  function makeIsometry(theta, alpha) {
    const tDD = typeof theta === 'string' ? DD.fromString(theta) : DD.from(theta || 0);
    const a = alpha || { re: DD.ZERO, im: DD.ZERO };
    return {
      theta: normalizeAngle2Pi(tDD),
      alpha: { re: DD.from(a.re), im: DD.from(a.im) },
    };
  }

  /**
   * phi_{theta, alpha}(z) = e^{i*theta} * (z - alpha) / (1 - conj(alpha) * z)
   */
  function applyIsometry(iso, z) {
    const rot = DD.cExpI(iso.theta);
    const num = DD.cSub(z, iso.alpha);
    const den = DD.cSub({ re: DD.ONE, im: DD.ZERO }, DD.cMul(DD.cConj(iso.alpha), z));
    return DD.cMul(rot, DD.cDiv(num, den));
  }

  /**
   * Inverse: phi_{theta, alpha}^{-1} = phi_{-theta mod 2pi, -e^{i*theta} * alpha}
   */
  function inverseIsometry(iso) {
    const rot = DD.cExpI(iso.theta);
    const newAlpha = DD.cNeg(DD.cMul(rot, iso.alpha));
    const newTheta = normalizeAngle2Pi(DD.neg(iso.theta));
    return { theta: newTheta, alpha: newAlpha };
  }

  /**
   * Group composition: iso2 o iso1 = phi_{theta3, alpha3}
   */
  function composeIsometries(iso2, iso1) {
    const inv1 = inverseIsometry(iso1);
    const alpha3 = applyIsometry(inv1, iso2.alpha);
    const e1 = DD.cExpI(iso1.theta);
    const e2 = DD.cExpI(iso2.theta);
    // e^{i*theta3} = e^{i*theta2} * (e^{i*theta1} + alpha2 * conj(alpha1)) / (1 + conj(alpha2) * e^{i*theta1} * alpha1)
    const num = DD.cMul(e2, DD.cAdd(e1, DD.cMul(iso2.alpha, DD.cConj(iso1.alpha))));
    const den = DD.cAdd(
      { re: DD.ONE, im: DD.ZERO },
      DD.cMul(DD.cConj(iso2.alpha), DD.cMul(e1, iso1.alpha))
    );
    const rot3 = DD.cDiv(num, den);
    const theta3 = normalizeAngle2Pi(DD.cArg(rot3));
    return { theta: theta3, alpha: alpha3 };
  }

  /**
   * Classifies phi_{theta, alpha} in PSU(1,1) as identity / elliptic / parabolic / hyperbolic,
   * computes SU(1,1) trace, fixed points, rotation angle or translation length.
   */
  function classifyIsometry(iso) {
    const va = validatePoint(iso.alpha);
    if (!va.valid) {
      return { valid: false, type: 'invalid', reason: va.reason };
    }
    const halfTheta = DD.ldexp(iso.theta, -1);
    const sc = DD.sincos(halfTheta);
    const sqrtOm = DD.sqrt(va.oneMinusAbs2);
    // SU(1,1) trace: 2 * cos(theta / 2) / sqrt(1 - |alpha|^2)
    const trace = DD.div(DD.ldexp(sc.cos, 1), sqrtOm);
    const absTrace = DD.abs(trace);
    const alphaAbs2 = DD.cAbs2(iso.alpha);
    const alphaAbs = DD.sqrt(alphaAbs2);

    const sinHalf = sc.sin;
    const sinHalf2 = DD.sqr(sinHalf);
    // D = |alpha|^2 - sin^2(theta/2)
    // D < 0 => elliptic, D == 0 => parabolic (or identity), D > 0 => hyperbolic
    const disc = DD.sub(alphaAbs2, sinHalf2);

    const EPS = 1e-12;
    if (alphaAbs.hi < 1e-15 && Math.abs(sinHalf.hi) < 1e-15) {
      return {
        valid: true,
        type: 'identity',
        labelJa: '恒等写像 (Identity)',
        trace,
        absTrace,
        fixedPoints: [],
        interiorFixed: null,
        boundaryFixed: [],
        rotationAngle: DD.ZERO,
        translationLength: DD.ZERO,
      };
    }

    if (alphaAbs.hi < 1e-15) {
      // Pure rotation around 0
      return {
        valid: true,
        type: 'elliptic',
        labelJa: '楕円型 (Elliptic)',
        trace,
        absTrace,
        fixedPoints: [{ re: DD.ZERO, im: DD.ZERO }],
        interiorFixed: { re: DD.ZERO, im: DD.ZERO },
        boundaryFixed: [],
        rotationAngle: iso.theta,
        translationLength: DD.ZERO,
      };
    }

    const eHalf = { re: sc.cos, im: sc.sin };
    const conjAlpha = DD.cConj(iso.alpha);

    if (disc.hi < -EPS) {
      // Elliptic: unique fixed point inside H^2
      const s = DD.sqrt(DD.neg(disc));
      // Fixed points: z = e^{i*theta/2} * (-i * (sin(theta/2) +- s)) / conj(alpha)
      const factor1 = { re: DD.ZERO, im: DD.neg(DD.add(sinHalf, s)) };
      const factor2 = { re: DD.ZERO, im: DD.neg(DD.sub(sinHalf, s)) };
      const z1 = DD.cDiv(DD.cMul(eHalf, factor1), conjAlpha);
      const z2 = DD.cDiv(DD.cMul(eHalf, factor2), conjAlpha);
      const interiorFixed = DD.cmp(DD.cAbs2(z1), DD.cAbs2(z2)) < 0 ? z1 : z2;

      // Signed rotation angle at interiorFixed = arg(phi'(p))
      // phi'(z) = e^{i*theta} * (1 - |alpha|^2) / (1 - conj(alpha)*z)^2
      const denom = DD.cSub({ re: DD.ONE, im: DD.ZERO }, DD.cMul(conjAlpha, interiorFixed));
      const deriv = DD.cDiv(
        DD.cMulReal(DD.cExpI(iso.theta), va.oneMinusAbs2),
        DD.cMul(denom, denom)
      );
      const rotAngle = normalizeAngle2Pi(DD.cArg(deriv));

      return {
        valid: true,
        type: 'elliptic',
        labelJa: '楕円型 (Elliptic)',
        trace,
        absTrace,
        fixedPoints: [interiorFixed],
        interiorFixed,
        boundaryFixed: [],
        rotationAngle: rotAngle,
        translationLength: DD.ZERO,
      };
    }

    if (Math.abs(disc.hi) <= EPS) {
      // Parabolic: unique fixed point on dH^2
      const factor = { re: DD.ZERO, im: DD.neg(sinHalf) };
      const rawFix = DD.cDiv(DD.cMul(eHalf, factor), conjAlpha);
      const r = DD.cAbs(rawFix);
      const bFix = DD.cMulReal(rawFix, DD.div(DD.ONE, r));

      return {
        valid: true,
        type: 'parabolic',
        labelJa: '放物型 (Parabolic)',
        trace,
        absTrace,
        fixedPoints: [bFix],
        interiorFixed: null,
        boundaryFixed: [bFix],
        rotationAngle: DD.ZERO,
        translationLength: DD.ZERO,
      };
    }

    // Hyperbolic: two distinct fixed points on dH^2
    const s = DD.sqrt(disc);
    const f1 = { re: s, im: DD.neg(sinHalf) };
    const f2 = { re: DD.neg(s), im: DD.neg(sinHalf) };
    let z1 = DD.cDiv(DD.cMul(eHalf, f1), conjAlpha);
    let z2 = DD.cDiv(DD.cMul(eHalf, f2), conjAlpha);
    // Project cleanly to |z|=1
    z1 = DD.cMulReal(z1, DD.div(DD.ONE, DD.cAbs(z1)));
    z2 = DD.cMulReal(z2, DD.div(DD.ONE, DD.cAbs(z2)));

    // Determine attracting (|phi'(z)| < 1) vs repelling (|phi'(z)| > 1)
    const d1 = DD.cAbs2(DD.cSub({ re: DD.ONE, im: DD.ZERO }, DD.cMul(conjAlpha, z1)));
    const d2 = DD.cAbs2(DD.cSub({ re: DD.ONE, im: DD.ZERO }, DD.cMul(conjAlpha, z2)));
    // |phi'(z)| = (1-|alpha|^2) / |1 - conj(alpha)*z|^2 -> larger denom means attracting
    const attracting = DD.cmp(d1, d2) > 0 ? z1 : z2;
    const repelling = DD.cmp(d1, d2) > 0 ? z2 : z1;

    // Translation length l = 2 * acosh(|tr| / 2)
    const halfAbsTr = DD.ldexp(absTrace, -1);
    const translationLength = DD.ldexp(DD.acosh(halfAbsTr), 1);

    return {
      valid: true,
      type: 'hyperbolic',
      labelJa: '双曲型 (Hyperbolic)',
      trace,
      absTrace,
      fixedPoints: [repelling, attracting],
      interiorFixed: null,
      boundaryFixed: [repelling, attracting],
      repelling,
      attracting,
      rotationAngle: DD.ZERO,
      translationLength,
    };
  }

  /**
   * Computes fractional power phi^t (t in [0, 1]) along the 1-parameter subgroup
   * for smooth geodesic/horocyclic/circular animation.
   */
  function isometryPower(iso, t) {
    const tDD = DD.from(t);
    if (Math.abs(t) < 1e-15) return makeIsometry(0, { re: DD.ZERO, im: DD.ZERO });
    if (Math.abs(t - 1) < 1e-15) return iso;

    const info = classifyIsometry(iso);
    if (!info.valid || info.type === 'identity') {
      return makeIsometry(0, { re: DD.ZERO, im: DD.ZERO });
    }

    if (info.type === 'elliptic') {
      // Conjugate interior fixed point p to 0, rotate by t * signedAngle, conjugate back
      let angle = info.rotationAngle;
      if (DD.cmp(angle, DD.PI) > 0) {
        angle = DD.sub(angle, DD.TWO_PI);
      }
      const toOrigin = makeIsometry(0, info.interiorFixed);
      const fromOrigin = inverseIsometry(toOrigin);
      const rot = makeIsometry(DD.mul(angle, tDD), { re: DD.ZERO, im: DD.ZERO });
      return composeIsometries(fromOrigin, composeIsometries(rot, toOrigin));
    }

    if (info.type === 'hyperbolic') {
      // Map repelling -> -1, attracting -> +1 via rotation + translation onto real diameter
      const m = info.repelling;
      const p = info.attracting;
      // Rotate so midpoint of arc or angle aligns: find rotation bringing (m, p) symmetric about real axis
      // Actually find a point on axis closest to origin (Euclidean midpoint of chord scaled? Simpler:
      // map m -> -1 and p -> +1 by finding point on axis or conjugating via Cayley!)
      // Use direct Mobius conjugation in float64/DD:
      // Any point on axis: geodesic connecting m and p. Point closest to 0 on axis:
      const sum = DD.cAdd(m, p);
      const sumAbs = DD.cAbs(sum);
      let axisCenter;
      if (sumAbs.hi < 1e-12) {
        // Diameter! Axis passes through 0
        axisCenter = { re: DD.ZERO, im: DD.ZERO };
      } else {
        // Orthogonal circle center C = 2 / conj(m + p) -> wait: C = (m+p) / (1 + Re(conj(m)*p))
        const dot = DD.add(DD.mul(m.re, p.re), DD.mul(m.im, p.im));
        const denom = DD.add(DD.ONE, dot);
        const C = DD.cMulReal(sum, DD.div(DD.ONE, denom));
        const cAbs = DD.cAbs(C);
        const R = DD.sqrt(DD.sub(DD.sqr(cAbs), DD.ONE));
        // Point on axis closest to 0 is (|C| - R) * (C / |C|)
        axisCenter = DD.cMulReal(C, DD.div(DD.sub(cAbs, R), cAbs));
      }
      // Map axisCenter -> 0
      const T1 = makeIsometry(0, axisCenter);
      const p1 = applyIsometry(T1, p);
      const ang = DD.cArg(p1);
      // Rotate so attracting is at +1, repelling at -1
      const T = composeIsometries(makeIsometry(DD.neg(ang), { re: DD.ZERO, im: DD.ZERO }), T1);
      const Tinv = inverseIsometry(T);
      // Pure hyperbolic translation along (-1, +1) towards +1 by distance t * L:
      // phi_{0, -tanh(t*L/2)}(z) maps 0 -> +tanh(t*L/2), so alpha = -tanh(t*L/2)
      const shift = DD.tanh(DD.ldexp(DD.mul(info.translationLength, tDD), -1));
      const trans = makeIsometry(0, { re: DD.neg(shift), im: DD.ZERO });
      return composeIsometries(Tinv, composeIsometries(trans, T));
    }

    // Parabolic: conjugate fixed point z_inf to 1, use upper-half-plane Cayley map
    // C(z) = i * (1 + z) / (1 - z) sends 1 -> infinity, 0 -> i.
    // Parabolic map becomes w -> w + k (real k). Fractional power is w -> w + t*k!
    const zInf = info.boundaryFixed[0];
    const rotTo1 = makeIsometry(DD.neg(DD.cArg(zInf)), { re: DD.ZERO, im: DD.ZERO });
    const rotFrom1 = inverseIsometry(rotTo1);
    const conjIso = composeIsometries(rotTo1, composeIsometries(iso, rotFrom1));
    // Evaluate conjIso(0) and map to UHP: w0 = C(0) = i, w1 = C(conjIso(0))
    const zImg = applyIsometry(conjIso, { re: DD.ZERO, im: DD.ZERO });
    const oneMinusZ = DD.cSub({ re: DD.ONE, im: DD.ZERO }, zImg);
    const onePlusZ = DD.cAdd({ re: DD.ONE, im: DD.ZERO }, zImg);
    const ratio = DD.cDiv(onePlusZ, oneMinusZ);
    // w1 = i * ratio = (-ratio.im) + i*(ratio.re); shift k = Re(w1) = -ratio.im
    const k = DD.neg(ratio.im);
    const kt = DD.mul(k, tDD);
    // Inverse Cayley of w -> w + kt applied to z:
    // z' = (w' - i) / (w' + i), where w' = i*(1+z)/(1-z) + kt
    // Compute image of 0 and image of -1 to recover (theta, alpha):
    // Actually w(0) = i => w'(0) = kt + i => z'(0) = kt / (kt + 2i)
    // And w(z) = i - kt => z = (-kt) / (-kt + 2i) maps to 0! So alpha_conj = -kt / (-kt + 2i)
    const twoI = { re: DD.ZERO, im: DD.TWO };
    const negKt = { re: DD.neg(kt), im: DD.ZERO };
    const alphaC = DD.cDiv(negKt, DD.cAdd(negKt, twoI));
    // Check image of 0: phi_{thetaC, alphaC}(0) = -e^{i*thetaC} * alphaC = kt / (kt + 2i)
    const img0 = DD.cDiv({ re: kt, im: DD.ZERO }, DD.cAdd({ re: kt, im: DD.ZERO }, twoI));
    let thetaC = DD.ZERO;
    if (DD.cAbs2(alphaC).hi > 1e-30) {
      const rotC = DD.cDiv(img0, DD.cNeg(alphaC));
      thetaC = normalizeAngle2Pi(DD.cArg(rotC));
    }
    const powConj = makeIsometry(thetaC, alphaC);
    return composeIsometries(rotFrom1, composeIsometries(powConj, rotTo1));
  }

  // --- Geodesics, Midpoints, Perpendiculars, Angle of Parallelism ---

  /**
   * Complete description of the geodesic passing through distinct points A, B in H^2.
   */
  function geodesic(A, B) {
    const vA = validatePoint(A);
    const vB = validatePoint(B);
    if (!vA.valid || !vB.valid) return { valid: false, reason: 'invalid_point' };

    const dInfo = distanceInfo(A, B);
    if (!dInfo.reliable || dInfo.distance.hi < 1e-15) {
      return { valid: false, reason: dInfo.reliable ? 'coincident_points' : dInfo.reason };
    }

    // Map A -> 0 via T_A = phi_{0, A}
    const TA = makeIsometry(0, A);
    const TAinv = inverseIsometry(TA);
    const w = applyIsometry(TA, B);
    const psi = DD.cArg(w);
    const dir = DD.cExpI(psi);

    // Ideal endpoints on dH^2
    const idealEnd = applyIsometry(TAinv, dir);
    const idealStart = applyIsometry(TAinv, DD.cNeg(dir));

    // Hyperbolic midpoint (s = L / 2)
    const halfL = DD.ldexp(dInfo.distance, -1);
    const midW = DD.cMulReal(dir, DD.tanh(DD.ldexp(halfL, -1)));
    const midpoint = applyIsometry(TAinv, midW);

    // Euclidean representation: diameter or circle orthogonal to |z| = 1
    const cross = DD.sub(DD.mul(A.re, B.im), DD.mul(A.im, B.re));
    let isDiameter = Math.abs(cross.hi) < 1e-13;
    let center = null;
    let radius = null;

    if (!isDiameter) {
      const sA = DD.ldexp(DD.add(DD.ONE, DD.cAbs2(A)), -1);
      const sB = DD.ldexp(DD.add(DD.ONE, DD.cAbs2(B)), -1);
      const cx = DD.div(DD.sub(DD.mul(sA, B.im), DD.mul(sB, A.im)), cross);
      const cy = DD.div(DD.sub(DD.mul(A.re, sB), DD.mul(B.re, sA)), cross);
      const c2 = DD.add(DD.sqr(cx), DD.sqr(cy));
      const r2 = DD.sub(c2, DD.ONE);
      if (r2.hi <= 0 || cx.hi * cx.hi + cy.hi * cy.hi > 1e20) {
        isDiameter = true;
      } else {
        center = { re: cx, im: cy };
        radius = DD.sqrt(r2);
      }
    }

    // Unit-speed parameterization z(s) for s in (-inf, +inf), with z(0) = A, z(L) = B
    function pointAtArcLength(s) {
      const sDD = DD.from(s);
      const t = DD.tanh(DD.ldexp(sDD, -1));
      return applyIsometry(TAinv, DD.cMulReal(dir, t));
    }

    return {
      valid: true,
      A,
      B,
      length: dInfo.distance,
      reliableDigits: dInfo.reliableDigits,
      midpoint,
      idealStart,
      idealEnd,
      isDiameter,
      center,
      radius,
      TA,
      TAinv,
      dir,
      psi,
      pointAtArcLength,
    };
  }

  /**
   * Foot of perpendicular from P to geodesic AB, hyperbolic distance h,
   * and Lobachevsky angle of parallelism Pi(h) = 2 * atan(e^{-h}).
   */
  function pointToGeodesic(P, A, B) {
    const vP = validatePoint(P);
    const geo = geodesic(A, B);
    if (!vP.valid || !geo.valid) return { valid: false };

    // Transform so A -> 0 and B -> +real axis
    const rot = makeIsometry(DD.neg(geo.psi), { re: DD.ZERO, im: DD.ZERO });
    const g = composeIsometries(rot, geo.TA);
    const gInv = inverseIsometry(g);

    const w = applyIsometry(g, P);
    const omW = DD.oneMinusAbs2(w);
    // Exact distance to real diameter: sinh(h) = 2 * |Im(w)| / (1 - |w|^2)
    const sinhH = DD.div(DD.ldexp(DD.abs(w.im), 1), omW);
    const h = DD.asinh(sinhH);

    // Foot of perpendicular f on real diameter (-1, 1):
    // f = 2u / (1 + |w|^2 + sqrt((1 + |w|^2)^2 - 4u^2))
    const u = w.re;
    const onePlusW2 = DD.add(DD.ONE, DD.cAbs2(w));
    const disc = DD.sub(DD.sqr(onePlusW2), DD.ldexp(DD.sqr(u), 2));
    const fReal = DD.div(DD.ldexp(u, 1), DD.add(onePlusW2, DD.sqrt(disc.hi > 0 ? disc : DD.ZERO)));
    const foot = applyIsometry(gInv, { re: fReal, im: DD.ZERO });

    // Angle of parallelism Pi(h) = 2 * atan(exp(-h))
    const piH = DD.ldexp(DD.atan(DD.exp(DD.neg(h))), 1);

    return {
      valid: true,
      foot,
      distance: h,
      angleOfParallelism: piH,
      reliableDigits: Math.min(vP.reliableDigits, geo.reliableDigits),
    };
  }

  // --- Hyperbolic Angles ---

  /**
   * Interior angle at vertex A formed by geodesics A->B and A->C (in [0, pi]).
   * Computed conformally via T_A = phi_{0, A} which sends A -> 0 so geodesics become rays.
   */
  function angleInfo(B, A, C) {
    const vA = validatePoint(A);
    const vB = validatePoint(B);
    const vC = validatePoint(C);
    if (!vA.valid || !vB.valid || !vC.valid) {
      return { reliable: false, reason: 'invalid_point', reliableDigits: 0 };
    }
    const TA = makeIsometry(0, A);
    const u = applyIsometry(TA, B);
    const v = applyIsometry(TA, C);
    if (DD.cAbs2(u).hi < 1e-30 || DD.cAbs2(v).hi < 1e-30) {
      return { reliable: false, reason: 'coincident_points', reliableDigits: 0 };
    }

    // conj(u) * v = dot + i * cross
    const prod = DD.cMul(DD.cConj(u), v);
    const ang = DD.atan2(DD.abs(prod.im), prod.re);
    const signedAngle = DD.atan2(prod.im, prod.re);

    const reliableDigits = Math.min(vA.reliableDigits, vB.reliableDigits, vC.reliableDigits);
    const reliable = reliableDigits >= MIN_RELIABLE_DIGITS && DD.isFiniteDD(ang);

    return {
      reliable,
      reason: reliable ? 'ok' : 'boundary_precision_limit',
      reliableDigits,
      angle: ang,
      signedAngle,
      tangentU: DD.cArg(u),
      tangentV: DD.cArg(v),
    };
  }

  // --- Hyperbolic Circle B_H(p, R) ---

  function hyperbolicCircle(center, radius) {
    const vc = validatePoint(center);
    const R = typeof radius === 'string' ? DD.fromString(radius) : DD.from(radius);
    if (!vc.valid || !DD.isFiniteDD(R) || R.hi <= 0) {
      return { valid: false, reliable: false, reason: !vc.valid ? vc.reason : 'invalid_radius' };
    }
    const t = DD.tanh(DD.ldexp(R, -1));
    const t2 = DD.sqr(t);
    const p2 = DD.cAbs2(center);
    const denom = DD.sub(DD.ONE, DD.mul(p2, t2));

    const euclidCenter = DD.cMulReal(center, DD.div(DD.sub(DD.ONE, t2), denom));
    const euclidRadius = DD.div(DD.mul(t, vc.oneMinusAbs2), denom);

    // Exact hyperbolic circumference = 2*pi*sinh(R), exact area = 4*pi*sinh^2(R/2)
    const circumference = DD.mul(DD.TWO_PI, DD.sinh(R));
    const exactArea = DD.mul(DD.FOUR, DD.mul(DD.PI, DD.sqr(DD.sinh(DD.ldexp(R, -1)))));

    // Reliability check: furthest point on circle has distance d(0,p) + R
    const d0 = DD.ldexp(DD.asinh(DD.div(DD.sqrt(p2), DD.sqrt(vc.oneMinusAbs2))), 1);
    const maxDist = DD.add(d0, R);
    // 1 - r_max^2 ~ 4 * exp(-maxDist)
    const approxMinOmLog10 = -maxDist.hi / Math.LN10 + 0.6;
    const reliableDigits = Math.max(0, Math.min(30, Math.floor(30.5 + Math.min(0, approxMinOmLog10))));
    const reliable = reliableDigits >= MIN_RELIABLE_DIGITS && DD.isFiniteDD(exactArea);

    return {
      valid: true,
      reliable,
      reliableDigits,
      center,
      radius: R,
      euclidCenter,
      euclidRadius,
      circumference,
      exactArea,
    };
  }

  /**
   * Independent numerical area of hyperbolic circle B_H(p, R) via
   * Green's contour integral oint 2(x dy - y dx)/(1 - |z|^2) around Euclidean circle.
   */
  function numericalCircleAreaDD(center, radius) {
    const c = hyperbolicCircle(center, radius);
    if (!c.valid || !c.reliable) {
      return { reliable: false, area: { hi: NaN, lo: NaN } };
    }
    const cx = c.euclidCenter.re;
    const cy = c.euclidCenter.im;
    const r = c.euclidRadius;

    function integrand(phi) {
      const sc = DD.sincos(phi);
      const x = DD.add(cx, DD.mul(r, sc.cos));
      const y = DD.add(cy, DD.mul(r, sc.sin));
      const dx = DD.neg(DD.mul(r, sc.sin));
      const dy = DD.mul(r, sc.cos);
      const om = DD.sub(DD.sub(DD.ONE, DD.sqr(x)), DD.sqr(y));
      // 2 * (x * dy - y * dx) / (1 - x^2 - y^2)
      const num = DD.ldexp(DD.sub(DD.mul(x, dy), DD.mul(y, dx)), 1);
      return DD.div(num, om);
    }

    const total = adaptiveGL16(integrand, DD.ZERO, DD.TWO_PI, 1e-22, 12);
    return { reliable: true, area: DD.abs(total) };
  }

  // --- Adaptive 16-Point Gauss-Legendre Quadrature in DD ---

  function integrateGL16(fn, a, b) {
    const mid = DD.ldexp(DD.add(a, b), -1);
    const halfLen = DD.ldexp(DD.sub(b, a), -1);
    let sum = DD.ZERO;
    for (let i = 0; i < 16; i++) {
      const x = DD.add(mid, DD.mul(halfLen, GL16.nodes[i]));
      sum = DD.add(sum, DD.mul(GL16.weights[i], fn(x)));
    }
    return DD.mul(halfLen, sum);
  }

  function adaptiveGL16(fn, a, b, tol, maxDepth) {
    const whole = integrateGL16(fn, a, b);
    function recurse(lo, hi, val, depth) {
      const mid = DD.ldexp(DD.add(lo, hi), -1);
      const left = integrateGL16(fn, lo, mid);
      const right = integrateGL16(fn, mid, hi);
      const combined = DD.add(left, right);
      const err = Math.abs(DD.sub(combined, val).hi);
      const scale = Math.max(1, Math.abs(combined.hi));
      if (depth <= 0 || err <= tol * scale) {
        return combined;
      }
      return DD.add(
        recurse(lo, mid, left, depth - 1),
        recurse(mid, hi, right, depth - 1)
      );
    }
    return recurse(a, b, whole, maxDepth || 10);
  }

  // --- Numerical Area Integration of Geodesic Polygons ---

  /**
   * Independent numerical evaluation of
   *   Area(P) = double_integral_P 4 / (1 - |z|^2)^2 dx dy
   *           = contour_integral_{dP} 2(x dy - y dx) / (1 - x^2 - y^2)
   * along the exact geodesic edges parameterized by hyperbolic arc length s in [0, L].
   *
   * Evaluates x(s), y(s), x'(s), y'(s) directly in 106-bit DD without using Gauss-Bonnet
   * or isometry invariance. Remains smooth and bounded (|integrand| < 1) even as |z| -> 1!
   */
  function numericalGeodesicEdgeIntegralDD(A, B) {
    const geo = geodesic(A, B);
    if (!geo.valid) return DD.ZERO;

    const L = geo.length;
    const omA = DD.oneMinusAbs2(A);
    const conjA = DD.cConj(A);
    const dir = geo.dir;

    function integrand(s) {
      const halfS = DD.ldexp(s, -1);
      const t = DD.tanh(halfS);
      const u = DD.cMulReal(dir, t);
      const denom = DD.cAdd({ re: DD.ONE, im: DD.ZERO }, DD.cMul(conjA, u));
      const num = DD.cAdd(u, A);
      // z(s) = (u + A) / (1 + conj(A) * u)
      const z = DD.cDiv(num, denom);

      // u'(s) = 0.5 * (1 - t^2) * dir
      const oneMinusT2 = DD.sub(DD.ONE, DD.sqr(t));
      const uPrime = DD.cMulReal(dir, DD.ldexp(oneMinusT2, -1));
      // z'(s) = (1 - |A|^2) * u'(s) / (1 + conj(A) * u)^2
      const denom2 = DD.cMul(denom, denom);
      const zPrime = DD.cDiv(DD.cMulReal(uPrime, omA), denom2);

      // 1 - |z(s)|^2 = (1 - |A|^2) * (1 - t^2) / |1 + conj(A) * u|^2
      // (Exact algebraic identity, zero cancellation at boundary!)
      const omZ = DD.div(DD.mul(omA, oneMinusT2), DD.cAbs2(denom));

      // 2 * (x * y' - y * x') / (1 - x^2 - y^2)
      const cross = DD.sub(DD.mul(z.re, zPrime.im), DD.mul(z.im, zPrime.re));
      return DD.div(DD.ldexp(cross, 1), omZ);
    }

    return adaptiveGL16(integrand, DD.ZERO, L, 1e-22, 10);
  }

  function numericalPolygonAreaDD(vertices) {
    const n = vertices.length;
    if (n < 3) return { reliable: false, area: DD.ZERO, signedArea: DD.ZERO };
    let sum = DD.ZERO;
    let minDigits = 30;
    for (let i = 0; i < n; i++) {
      const vi = validatePoint(vertices[i]);
      if (!vi.valid || !vi.reliable) {
        return { reliable: false, area: { hi: NaN, lo: NaN }, signedArea: { hi: NaN, lo: NaN }, reliableDigits: vi.reliableDigits };
      }
      minDigits = Math.min(minDigits, vi.reliableDigits);
      const next = vertices[(i + 1) % n];
      sum = DD.add(sum, numericalGeodesicEdgeIntegralDD(vertices[i], next));
    }
    return {
      reliable: minDigits >= MIN_RELIABLE_DIGITS && DD.isFiniteDD(sum),
      reliableDigits: minDigits,
      signedArea: sum,
      area: DD.abs(sum),
    };
  }

  /**
   * Direct 2D Gauss-Legendre numerical integration of
   *   double_integral_T 4 / (1 - x^2 - y^2)^2 dx dy
   * over the curvilinear hyperbolic triangle T = ABC using geodesic fan coordinates
   * (u, v) in [0, 1]^2 -> P(u, v) = geodesic(A -> geodesic(B->C)(u))(v).
   *
   * Used as an additional completely direct 2D check for moderate triangles
   * (where 1 - |z|^2 is not too extreme for 2D float64 quadrature).
   */
  function numericalTriangleArea2D(A, B, C, order) {
    const vA = validatePoint(A), vB = validatePoint(B), vC = validatePoint(C);
    if (!vA.valid || !vB.valid || !vC.valid) return { applicable: false, area: NaN };

    const minOm = Math.min(vA.oneMinusAbs2.hi, vB.oneMinusAbs2.hi, vC.oneMinusAbs2.hi);
    if (minOm < 1e-3) {
      // Near the boundary, 4/(1-|z|^2)^2 spikes > 10^6; 1D Green DD quadrature handles this regime cleanly.
      return { applicable: false, reason: 'boundary_spike_use_dd_green', area: NaN };
    }

    const geoBC = geodesic(B, C);
    if (!geoBC.valid) return { applicable: false, area: NaN };

    // Use 16-point Gauss-Legendre in float64 on [0,1]^2
    const nodes = GL16.nodes.map(x => 0.5 * (x.hi + 1));
    const weights = GL16.weights.map(w => 0.5 * w.hi);

    // Helper: geodesic point from P to Q at fraction t in [0, 1] in float64
    const Ax = A.re.hi, Ay = A.im.hi;
    const Bx = B.re.hi, By = B.im.hi;
    const Cx = C.re.hi, Cy = C.im.hi;

    function mobiusToOrigin(px, py, qx, qy) {
      const dx = qx - px, dy = qy - py;
      const dr = 1 - (px * qx + py * qy);
      const di = -(px * qy - py * qx);
      const d2 = dr * dr + di * di;
      return [(dx * dr + dy * di) / d2, (dy * dr - dx * di) / d2];
    }

    function mobiusFromOrigin(px, py, ux, uy) {
      const nr = ux + px, ni = uy + py;
      const dr = 1 + (px * ux + py * uy);
      const di = px * uy - py * ux;
      const d2 = dr * dr + di * di;
      return [(nr * dr + ni * di) / d2, (ni * dr - nr * di) / d2];
    }

    const [bcUx, bcUy] = mobiusToOrigin(Bx, By, Cx, Cy);
    const bcR = Math.hypot(bcUx, bcUy);
    if (bcR < 1e-12) return { applicable: false, area: 0 };
    const bcL = 2 * Math.atanh(bcR);
    const bcDirX = bcUx / bcR, bcDirY = bcUy / bcR;

    function mapUV(u, v) {
      const t1 = Math.tanh(0.5 * u * bcL);
      const [qx, qy] = mobiusFromOrigin(Bx, By, t1 * bcDirX, t1 * bcDirY);
      const [aqUx, aqUy] = mobiusToOrigin(Ax, Ay, qx, qy);
      const aqR = Math.hypot(aqUx, aqUy);
      if (aqR < 1e-14) return [Ax, Ay];
      const aqL = 2 * Math.atanh(aqR);
      const t2 = Math.tanh(0.5 * v * aqL);
      return mobiusFromOrigin(Ax, Ay, t2 * (aqUx / aqR), t2 * (aqUy / aqR));
    }

    const eps = 1e-6;
    let total = 0;
    const subdiv = order || 2;
    const h = 1 / subdiv;

    for (let su = 0; su < subdiv; su++) {
      for (let sv = 0; sv < subdiv; sv++) {
        for (let i = 0; i < 16; i++) {
          const u = (su + nodes[i]) * h;
          const wu = weights[i] * h;
          for (let j = 0; j < 16; j++) {
            const v = (sv + nodes[j]) * h;
            const wv = weights[j] * h;
            const [x, y] = mapUV(u, v);
            // Central difference Jacobian |det J|
            const du = Math.min(eps, u * 0.5, (1 - u) * 0.5);
            const dv = Math.min(eps, v * 0.5, (1 - v) * 0.5);
            const [xUp, yUp] = mapUV(u + du, v);
            const [xUm, yUm] = mapUV(u - du, v);
            const [xVp, yVp] = mapUV(u, v + dv);
            const [xVm, yVm] = mapUV(u, v - dv);
            const dxdu = (xUp - xUm) / (2 * du);
            const dydu = (yUp - yUm) / (2 * du);
            const dxdv = (xVp - xVm) / (2 * dv);
            const dydv = (yVp - yVm) / (2 * dv);
            const jac = Math.abs(dxdu * dydv - dydu * dxdv);
            const om = 1 - (x * x + y * y);
            const density = 4 / (om * om);
            total += wu * wv * density * jac;
          }
        }
      }
    }
    return { applicable: true, area: total };
  }

  // --- Full Triangle Analysis (Gauss-Bonnet, L'Huilier, Laws of Cosines/Sines, Centers) ---

  function analyzeTriangle(A, B, C) {
    const vA = validatePoint(A);
    const vB = validatePoint(B);
    const vC = validatePoint(C);
    if (!vA.valid || !vB.valid || !vC.valid) {
      return { valid: false, reliable: false, reason: 'invalid_point' };
    }

    const dA = distanceInfo(B, C); // side a opposite A
    const dB = distanceInfo(C, A); // side b opposite B
    const dC = distanceInfo(A, B); // side c opposite C

    const angA = angleInfo(B, A, C);
    const angB = angleInfo(C, B, A);
    const angC = angleInfo(A, C, B);

    const minDigits = Math.min(
      vA.reliableDigits, vB.reliableDigits, vC.reliableDigits,
      dA.reliableDigits || 0, dB.reliableDigits || 0, dC.reliableDigits || 0
    );

    if (!dA.reliable || !dB.reliable || !dC.reliable || !angA.reliable || !angB.reliable || !angC.reliable) {
      return {
        valid: true,
        reliable: false,
        reason: minDigits < MIN_RELIABLE_DIGITS ? 'boundary_precision_limit' : 'degenerate',
        reliableDigits: minDigits,
      };
    }

    const a = dA.distance, b = dB.distance, c = dC.distance;
    const alpha = angA.angle, beta = angB.angle, gamma = angC.angle;

    // Check degeneracy (collinear / zero area)
    const angleSum = DD.add(DD.add(alpha, beta), gamma);
    const areaGB = DD.sub(DD.PI, angleSum);
    const isDegenerate = areaGB.hi < 1e-16 || a.hi < 1e-14 || b.hi < 1e-14 || c.hi < 1e-14;

    // L'Huilier's formula from side lengths alone:
    // tan(Area / 4) = sqrt(tanh(s/2) * tanh((s-a)/2) * tanh((s-b)/2) * tanh((s-c)/2))
    const s = DD.ldexp(DD.add(DD.add(a, b), c), -1);
    const sMa = DD.sub(s, a);
    const sMb = DD.sub(s, b);
    const sMc = DD.sub(s, c);
    let areaLHuilier = DD.ZERO;
    if (sMa.hi > 0 && sMb.hi > 0 && sMc.hi > 0) {
      const prod = DD.mul(
        DD.mul(DD.tanh(DD.ldexp(s, -1)), DD.tanh(DD.ldexp(sMa, -1))),
        DD.mul(DD.tanh(DD.ldexp(sMb, -1)), DD.tanh(DD.ldexp(sMc, -1)))
      );
      areaLHuilier = prod.hi > 0 ? DD.ldexp(DD.atan(DD.sqrt(prod)), 2) : DD.ZERO;
    }

    // Independent numerical area integral (106-bit DD Green quadrature)
    const numRes = numericalPolygonAreaDD([A, B, C]);
    const areaNumerical = numRes.area;

    // Discrepancy between numerical integral and Gauss-Bonnet pi - (alpha + beta + gamma)
    const gbDiff = DD.abs(DD.sub(areaNumerical, areaGB));
    const gbRelDiff = areaGB.hi > 1e-15 ? DD.div(gbDiff, areaGB) : gbDiff;
    const lhuilierDiff = DD.abs(DD.sub(areaLHuilier, areaGB));

    // Verify 1st Law of Cosines: cosh(c) = cosh(a)*cosh(b) - sinh(a)*sinh(b)*cos(gamma)
    // Use relative residual to stay meaningful for large hyperbolic sides
    let lawCos1RelErr = DD.ZERO;
    let lawCos1LHS = DD.ZERO, lawCos1RHS = DD.ZERO;
    if (a.hi < 300 && b.hi < 300 && c.hi < 300) {
      lawCos1LHS = DD.cosh(c);
      lawCos1RHS = DD.sub(
        DD.mul(DD.cosh(a), DD.cosh(b)),
        DD.mul(DD.mul(DD.sinh(a), DD.sinh(b)), DD.cos(gamma))
      );
      lawCos1RelErr = DD.div(DD.abs(DD.sub(lawCos1LHS, lawCos1RHS)), lawCos1LHS);
    }

    // Verify 2nd (Dual) Law of Cosines: cos(gamma) = -cos(alpha)*cos(beta) + sin(alpha)*sin(beta)*cosh(c)
    let lawCos2Err = DD.ZERO;
    let lawCos2LHS = DD.cos(gamma), lawCos2RHS = DD.ZERO;
    if (c.hi < 300) {
      lawCos2RHS = DD.add(
        DD.neg(DD.mul(DD.cos(alpha), DD.cos(beta))),
        DD.mul(DD.mul(DD.sin(alpha), DD.sin(beta)), DD.cosh(c))
      );
      lawCos2Err = DD.abs(DD.sub(lawCos2LHS, lawCos2RHS));
    }

    // Verify Law of Sines: sinh(a)/sin(alpha) = sinh(b)/sin(beta) = sinh(c)/sin(gamma)
    let lawSineSpread = DD.ZERO;
    let sineRatios = null;
    if (!isDegenerate && a.hi < 300 && b.hi < 300 && c.hi < 300 &&
        alpha.hi > 1e-12 && beta.hi > 1e-12 && gamma.hi > 1e-12) {
      const rA = DD.div(DD.sinh(a), DD.sin(alpha));
      const rB = DD.div(DD.sinh(b), DD.sin(beta));
      const rC = DD.div(DD.sinh(c), DD.sin(gamma));
      sineRatios = [rA, rB, rC];
      const d1 = DD.abs(DD.sub(rA, rB));
      const d2 = DD.abs(DD.sub(rB, rC));
      const d3 = DD.abs(DD.sub(rC, rA));
      const maxD = DD.cmp(d1, d2) > 0 ? (DD.cmp(d1, d3) > 0 ? d1 : d3) : (DD.cmp(d2, d3) > 0 ? d2 : d3);
      lawSineSpread = DD.div(maxD, rA);
    }

    // Hyperbolic Incenter & Inradius:
    // tanh(r_in) = sqrt(sinh(s-a)*sinh(s-b)*sinh(s-c) / sinh(s))
    let incircle = null;
    if (!isDegenerate && s.hi < 250) {
      try {
        // Construct incenter by intersecting angle bisectors at A and B
        const incenter = computeIncenter(A, B, C);
        if (incenter) {
          const distSide = pointToGeodesic(incenter, A, B);
          if (distSide.valid && distSide.distance.hi > 1e-12) {
            incircle = hyperbolicCircle(incenter, distSide.distance);
          }
        }
      } catch (_) {
        incircle = null;
      }
    }

    // Hyperbolic Centroid (intersection of medians A->mid(BC) and B->mid(CA))
    let centroid = null;
    if (!isDegenerate) {
      const gBC = geodesic(B, C);
      const gCA = geodesic(C, A);
      if (gBC.valid && gCA.valid) {
        centroid = intersectGeodesics(A, gBC.midpoint, B, gCA.midpoint);
      }
    }

    // Hyperbolic Circumcircle (exists in H^2 iff perpendicular bisectors intersect inside H^2)
    let circumcircle = null;
    if (!isDegenerate) {
      const circumcenter = computeCircumcenter(A, B, C);
      if (circumcenter) {
        const Rcirc = distanceInfo(circumcenter, A);
        if (Rcirc.reliable && Rcirc.distance.hi > 1e-12) {
          circumcircle = hyperbolicCircle(circumcenter, Rcirc.distance);
        }
      }
    }

    // Estimate effective reliable digits for areaGB (angle cancellation if area is tiny)
    const areaLoss = areaGB.hi > 0 && areaGB.hi < 1 ? Math.max(0, -Math.log10(areaGB.hi)) : 0;
    const areaReliableDigits = Math.max(0, Math.min(minDigits, Math.floor(minDigits - areaLoss * 0.5)));

    return {
      valid: true,
      reliable: minDigits >= MIN_RELIABLE_DIGITS,
      isDegenerate,
      reliableDigits: minDigits,
      areaReliableDigits,
      vertices: [A, B, C],
      sides: { a, b, c },
      angles: { alpha, beta, gamma },
      angleSum,
      areaGB,
      areaNumerical,
      areaLHuilier,
      gbDiff,
      gbRelDiff,
      lhuilierDiff,
      lawCos1: { lhs: lawCos1LHS, rhs: lawCos1RHS, relErr: lawCos1RelErr },
      lawCos2: { lhs: lawCos2LHS, rhs: lawCos2RHS, err: lawCos2Err },
      lawSine: { ratios: sineRatios, relSpread: lawSineSpread },
      centroid,
      incircle,
      circumcircle,
    };
  }

  /**
   * Analyzes a general simple geodesic n-gon (n >= 3) via Gauss-Bonnet:
   *   Area = (n - 2) * pi - sum(alpha_k)
   * and compares with independent numerical quadrature.
   */
  function analyzePolygon(vertices) {
    const n = vertices.length;
    if (n < 3) return { valid: false, reliable: false, reason: 'too_few_vertices' };
    if (n === 3) {
      const tri = analyzeTriangle(vertices[0], vertices[1], vertices[2]);
      return Object.assign({ n: 3 }, tri);
    }

    let minDigits = 30;
    const sides = [];
    for (let i = 0; i < n; i++) {
      const v = validatePoint(vertices[i]);
      if (!v.valid || !v.reliable) {
        return { valid: v.valid, reliable: false, reason: v.reason, reliableDigits: v.reliableDigits };
      }
      minDigits = Math.min(minDigits, v.reliableDigits);
      const d = distanceInfo(vertices[i], vertices[(i + 1) % n]);
      if (!d.reliable) return { valid: true, reliable: false, reason: d.reason, reliableDigits: minDigits };
      sides.push(d.distance);
    }

    // Determine orientation from signed numerical area so reflex interior angles (> pi) are handled properly!
    const numRes = numericalPolygonAreaDD(vertices);
    if (!numRes.reliable) {
      return { valid: true, reliable: false, reason: 'boundary_precision_limit', reliableDigits: minDigits };
    }
    const ccw = numRes.signedArea.hi >= 0;

    const interiorAngles = [];
    let angleSum = DD.ZERO;
    for (let i = 0; i < n; i++) {
      const prev = vertices[(i + n - 1) % n];
      const curr = vertices[i];
      const next = vertices[(i + 1) % n];
      // For CCW polygon, interior angle goes from (curr->next) to (curr->prev) counter-clockwise
      const info = angleInfo(next, curr, prev);
      if (!info.reliable) return { valid: true, reliable: false, reason: info.reason };
      let ang = ccw ? info.signedAngle : DD.neg(info.signedAngle);
      if (ang.hi < 0) ang = DD.add(ang, DD.TWO_PI);
      interiorAngles.push(ang);
      angleSum = DD.add(angleSum, ang);
    }

    const expectedMaxSum = DD.mul(DD.from(n - 2), DD.PI);
    const areaGB = DD.sub(expectedMaxSum, angleSum);
    const areaNumerical = numRes.area;
    const gbDiff = DD.abs(DD.sub(areaNumerical, areaGB));
    const gbRelDiff = Math.abs(areaGB.hi) > 1e-15 ? DD.div(gbDiff, DD.abs(areaGB)) : gbDiff;

    return {
      valid: true,
      reliable: minDigits >= MIN_RELIABLE_DIGITS,
      reliableDigits: minDigits,
      n,
      vertices,
      sides,
      interiorAngles,
      angleSum,
      areaGB,
      areaNumerical,
      gbDiff,
      gbRelDiff,
      ccw,
    };
  }

  // --- Geodesic Intersection & Triangle Centers ---

  /**
   * Intersects two geodesics (A1-B1) and (A2-B2) inside H^2, if they intersect.
   */
  function intersectGeodesics(A1, B1, A2, B2) {
    const g1 = geodesic(A1, B1);
    const g2 = geodesic(A2, B2);
    if (!g1.valid || !g2.valid) return null;

    // Map A1 -> 0 and B1 -> +real axis so geodesic 1 is the real diameter (-1, 1)
    const rot = makeIsometry(DD.neg(g1.psi), { re: DD.ZERO, im: DD.ZERO });
    const g = composeIsometries(rot, g1.TA);
    const gInv = inverseIsometry(g);

    const p2 = applyIsometry(g, A2);
    const q2 = applyIsometry(g, B2);
    const g2t = geodesic(p2, q2);
    if (!g2t.valid) return null;

    if (g2t.isDiameter) {
      // Both are diameters: intersect at origin unless collinear
      const cross = DD.sub(DD.mul(p2.re, q2.im), DD.mul(p2.im, q2.re));
      if (Math.abs(p2.im.hi) < 1e-14 && Math.abs(q2.im.hi) < 1e-14) return null;
      return applyIsometry(gInv, { re: DD.ZERO, im: DD.ZERO });
    }

    // Orthogonal circle (cx, cy), R intersects real axis y = 0 at (x - cx)^2 + cy^2 = R^2
    // => (x - cx)^2 = R^2 - cy^2 = cx^2 - 1 (since cx^2 + cy^2 - R^2 = 1!)
    // WAIT: x^2 - 2*cx*x + 1 = 0 => x = cx - sgn(cx)*sqrt(cx^2 - 1) = 1 / (cx + sgn(cx)*sqrt(cx^2 - 1))!
    const cx = g2t.center.re;
    const disc = DD.sub(DD.sqr(cx), DD.ONE);
    if (disc.hi <= 0) return null; // Ultra-parallel or limiting parallel (no interior intersection)
    const sq = DD.sqrt(disc);
    const denom = cx.hi >= 0 ? DD.add(cx, sq) : DD.sub(cx, sq);
    const xInt = DD.div(DD.ONE, denom);
    if (Math.abs(xInt.hi) >= 1) return null;
    return applyIsometry(gInv, { re: xInt, im: DD.ZERO });
  }

  function computeIncenter(A, B, C) {
    // Angle bisector at A: map A->0, bisect rays to B and C
    const TA = makeIsometry(0, A);
    const TAinv = inverseIsometry(TA);
    const uB = applyIsometry(TA, B);
    const uC = applyIsometry(TA, C);
    const dirB = DD.cMulReal(uB, DD.div(DD.ONE, DD.cAbs(uB)));
    const dirC = DD.cMulReal(uC, DD.div(DD.ONE, DD.cAbs(uC)));
    const bisA_dir = DD.cAdd(dirB, dirC);
    if (DD.cAbs2(bisA_dir).hi < 1e-24) return null;
    const bisA_pt = applyIsometry(TAinv, DD.cMulReal(bisA_dir, DD.div(DD.HALF, DD.cAbs(bisA_dir))));

    // Angle bisector at B
    const TB = makeIsometry(0, B);
    const TBinv = inverseIsometry(TB);
    const vA = applyIsometry(TB, A);
    const vC = applyIsometry(TB, C);
    const dirA = DD.cMulReal(vA, DD.div(DD.ONE, DD.cAbs(vA)));
    const dirC2 = DD.cMulReal(vC, DD.div(DD.ONE, DD.cAbs(vC)));
    const bisB_dir = DD.cAdd(dirA, dirC2);
    if (DD.cAbs2(bisB_dir).hi < 1e-24) return null;
    const bisB_pt = applyIsometry(TBinv, DD.cMulReal(bisB_dir, DD.div(DD.HALF, DD.cAbs(bisB_dir))));

    return intersectGeodesics(A, bisA_pt, B, bisB_pt);
  }

  function perpendicularBisector(A, B) {
    const g = geodesic(A, B);
    if (!g.valid) return null;
    const M = g.midpoint;
    // Map M -> 0; then geodesic AB is a diameter, and its perpendicular bisector is the orthogonal diameter!
    const TM = makeIsometry(0, M);
    const TMinv = inverseIsometry(TM);
    const uA = applyIsometry(TM, A);
    const len = DD.cAbs(uA);
    if (len.hi < 1e-15) return null;
    // Rotate uA by 90 degrees and scale to 0.5
    const perpDir = { re: DD.div(DD.neg(uA.im), len), im: DD.div(uA.re, len) };
    const P2 = applyIsometry(TMinv, DD.cMulReal(perpDir, DD.HALF));
    return { M, P2, geodesic: geodesic(M, P2) };
  }

  function computeCircumcenter(A, B, C) {
    const pb1 = perpendicularBisector(A, B);
    const pb2 = perpendicularBisector(B, C);
    if (!pb1 || !pb2) return null;
    return intersectGeodesics(pb1.M, pb1.P2, pb2.M, pb2.P2);
  }

  return {
    DD,
    MIN_RELIABLE_DIGITS,
    point,
    pointFromPolar,
    pointFromBoundaryOffset,
    pointFromHyperbolicPolar,
    toFloat,
    validatePoint,
    normalizeAngle2Pi,
    distanceInfo,
    distance,
    distanceDirectLogFormula,
    makeIsometry,
    applyIsometry,
    inverseIsometry,
    composeIsometries,
    classifyIsometry,
    isometryPower,
    geodesic,
    pointToGeodesic,
    perpendicularBisector,
    intersectGeodesics,
    angleInfo,
    hyperbolicCircle,
    numericalCircleAreaDD,
    numericalPolygonAreaDD,
    numericalTriangleArea2D,
    analyzeTriangle,
    analyzePolygon,
  };
});

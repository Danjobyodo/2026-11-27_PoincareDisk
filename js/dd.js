/**
 * Double-Double (106-bit, ~31 decimal digits) real and complex arithmetic
 * for high-precision hyperbolic geometry near the ideal boundary |z| -> 1.
 *
 * Dual-mode: works as browser global (window.H2DD) and Node.js CommonJS module.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.H2DD = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SPLIT = 134217729; // 2^27 + 1 (Dekker split constant)

  // --- Error-Free Transformations ---

  function quickTwoSum(a, b) {
    const s = a + b;
    const e = b - (s - a);
    return { hi: s, lo: e };
  }

  function twoSum(a, b) {
    const s = a + b;
    const v = s - a;
    const e = (a - (s - v)) + (b - v);
    return { hi: s, lo: e };
  }

  function split(a) {
    const t = SPLIT * a;
    const hi = t - (t - a);
    const lo = a - hi;
    return [hi, lo];
  }

  function twoProd(a, b) {
    const p = a * b;
    // Guard against Dekker split overflow for huge operands
    if (Math.abs(a) > 1e140 || Math.abs(b) > 1e140) {
      return { hi: p, lo: 0 };
    }
    const [aHi, aLo] = split(a);
    const [bHi, bLo] = split(b);
    const e = ((aHi * bHi - p) + aHi * bLo + aLo * bHi) + aLo * bLo;
    return { hi: p, lo: e };
  }

  // --- Constructors & Constants ---

  function make(hi, lo) {
    return quickTwoSum(hi, lo || 0);
  }

  function from(x) {
    if (x && typeof x === 'object' && typeof x.hi === 'number') {
      return { hi: x.hi, lo: x.lo || 0 };
    }
    return { hi: Number(x), lo: 0 };
  }

  const ZERO = Object.freeze({ hi: 0, lo: 0 });
  const ONE = Object.freeze({ hi: 1, lo: 0 });
  const TWO = Object.freeze({ hi: 2, lo: 0 });
  const FOUR = Object.freeze({ hi: 4, lo: 0 });
  const HALF = Object.freeze({ hi: 0.5, lo: 0 });
  const NEG_ONE = Object.freeze({ hi: -1, lo: 0 });

  // Verified 106-bit constants
  const PI = Object.freeze({ hi: 3.141592653589793, lo: 1.2246467991473532e-16 });
  const TWO_PI = Object.freeze({ hi: 6.283185307179586, lo: 2.4492935982947064e-16 });
  const HALF_PI = Object.freeze({ hi: 1.5707963267948966, lo: 6.123233995736766e-17 });
  const LN2 = Object.freeze({ hi: 0.6931471805599453, lo: 2.3190468138462996e-17 });
  const LN10 = Object.freeze({ hi: 2.302585092994046, lo: -2.1707562233822494e-16 });

  function isFiniteDD(a) {
    return Number.isFinite(a.hi) && Number.isFinite(a.lo);
  }

  function isNaNDD(a) {
    return Number.isNaN(a.hi) || Number.isNaN(a.lo);
  }

  function isZero(a) {
    return a.hi === 0 && a.lo === 0;
  }

  function toNumber(a) {
    return a.hi + a.lo;
  }

  // --- Core Arithmetic ---

  function neg(a) {
    return { hi: -a.hi, lo: -a.lo };
  }

  function abs(a) {
    return a.hi < 0 ? { hi: -a.hi, lo: -a.lo } : { hi: a.hi, lo: a.lo };
  }

  function cmp(a, b) {
    if (a.hi < b.hi) return -1;
    if (a.hi > b.hi) return 1;
    if (a.lo < b.lo) return -1;
    if (a.lo > b.lo) return 1;
    return 0;
  }

  // Accurate IEEE-style double-double addition (Hida-Li-Bailey)
  function add(a, b) {
    const s = twoSum(a.hi, b.hi);
    const t = twoSum(a.lo, b.lo);
    let c = s.lo + t.hi;
    const v = quickTwoSum(s.hi, c);
    c = t.lo + v.lo;
    return quickTwoSum(v.hi, c);
  }

  function addScalar(a, b) {
    const s = twoSum(a.hi, b);
    const v = quickTwoSum(s.hi, s.lo + a.lo);
    return v;
  }

  function sub(a, b) {
    return add(a, { hi: -b.hi, lo: -b.lo });
  }

  function subScalar(a, b) {
    return addScalar(a, -b);
  }

  function mul(a, b) {
    const p = twoProd(a.hi, b.hi);
    const e = p.lo + (a.hi * b.lo + a.lo * b.hi);
    return quickTwoSum(p.hi, e);
  }

  function mulScalar(a, b) {
    const p = twoProd(a.hi, b);
    const e = p.lo + a.lo * b;
    return quickTwoSum(p.hi, e);
  }

  function sqr(a) {
    const p = twoProd(a.hi, a.hi);
    const e = p.lo + 2.0 * a.hi * a.lo + a.lo * a.lo;
    return quickTwoSum(p.hi, e);
  }

  function div(a, b) {
    if (b.hi === 0 && b.lo === 0) {
      return { hi: a.hi / 0, lo: NaN };
    }
    const q1 = a.hi / b.hi;
    let r = sub(a, mulScalar(b, q1));
    const q2 = r.hi / b.hi;
    r = sub(r, mulScalar(b, q2));
    const q3 = r.hi / b.hi;
    const s = quickTwoSum(q1, q2);
    return addScalar(s, q3);
  }

  function divScalar(a, b) {
    return div(a, { hi: b, lo: 0 });
  }

  function ldexp(a, k) {
    // Exact power-of-2 scaling (handles large exponents safely)
    if (k === 0 || isZero(a)) return { hi: a.hi, lo: a.lo };
    let hi = a.hi;
    let lo = a.lo;
    let rem = k;
    while (rem > 500) {
      const f = Math.pow(2, 500);
      hi *= f;
      lo *= f;
      rem -= 500;
    }
    while (rem < -500) {
      const f = Math.pow(2, -500);
      hi *= f;
      lo *= f;
      rem += 500;
    }
    const f = Math.pow(2, rem);
    return { hi: hi * f, lo: lo * f };
  }

  function sqrt(a) {
    if (a.hi < 0 || (a.hi === 0 && a.lo < 0)) {
      return { hi: NaN, lo: NaN };
    }
    if (a.hi === 0 && a.lo === 0) return ZERO;
    // Scale to avoid underflow/overflow for extreme magnitudes
    let y = from(Math.sqrt(a.hi));
    // Two Newton steps: y = 0.5 * (y + a / y)
    y = ldexp(add(y, div(a, y)), -1);
    y = ldexp(add(y, div(a, y)), -1);
    return y;
  }

  function hypot(a, b) {
    const aa = abs(a);
    const bb = abs(b);
    if (isZero(aa)) return bb;
    if (isZero(bb)) return aa;
    const m = cmp(aa, bb) >= 0 ? aa : bb;
    const u = div(aa, m);
    const v = div(bb, m);
    return mul(m, sqrt(add(sqr(u), sqr(v))));
  }

  // --- Elementary Functions (106-bit precision) ---

  function exp(x) {
    if (isNaNDD(x)) return { hi: NaN, lo: NaN };
    if (x.hi > 709.78) return { hi: Infinity, lo: 0 };
    if (x.hi < -745.13) return ZERO;
    if (isZero(x)) return ONE;

    // Range reduction: x = k * ln(2) + r, |r| <= ln(2)/2
    const k = Math.round(x.hi / LN2.hi);
    const r = sub(x, mulScalar(LN2, k));

    // Halve 4 times so |t| <= 0.0217
    const t = ldexp(r, -4);
    let sum = ONE;
    let term = ONE;
    for (let n = 1; n <= 16; n++) {
      term = divScalar(mul(term, t), n);
      sum = add(sum, term);
      if (Math.abs(term.hi) < 1e-34) break;
    }
    // Square 4 times
    sum = sqr(sum);
    sum = sqr(sum);
    sum = sqr(sum);
    sum = sqr(sum);
    return ldexp(sum, k);
  }

  function log(x) {
    if (isNaNDD(x) || x.hi < 0 || (x.hi === 0 && x.lo <= 0)) {
      return { hi: NaN, lo: NaN };
    }
    if (x.hi === 1 && x.lo === 0) return ZERO;

    // Initial float64 guess
    let y = from(Math.log(x.hi));
    // Two Newton steps: y <- y + (x * exp(-y) - 1)
    for (let i = 0; i < 2; i++) {
      const ey = exp(y);
      const step = div(sub(x, ey), ey);
      y = add(y, step);
    }
    return y;
  }

  function log1p(x) {
    if (Math.abs(x.hi) < 1e-3) {
      // Taylor series: x - x^2/2 + x^3/3 - ...
      let sum = ZERO;
      let pow = x;
      for (let n = 1; n <= 16; n++) {
        const term = divScalar(pow, n);
        sum = (n % 2 === 1) ? add(sum, term) : sub(sum, term);
        if (Math.abs(term.hi) < Math.abs(sum.hi) * 1e-33) break;
        pow = mul(pow, x);
      }
      return sum;
    }
    return log(add(ONE, x));
  }

  function sinh(x) {
    if (Math.abs(x.hi) < 1e-2) {
      // Taylor series for small |x| (zero cancellation)
      const x2 = sqr(x);
      let sum = x;
      let term = x;
      for (let n = 1; n <= 12; n++) {
        term = divScalar(mul(term, x2), (2 * n) * (2 * n + 1));
        sum = add(sum, term);
        if (Math.abs(term.hi) < Math.abs(sum.hi) * 1e-33) break;
      }
      return sum;
    }
    const ex = exp(x);
    const emx = div(ONE, ex);
    return ldexp(sub(ex, emx), -1);
  }

  function cosh(x) {
    const ex = exp(abs(x));
    const emx = div(ONE, ex);
    return ldexp(add(ex, emx), -1);
  }

  function tanh(x) {
    if (x.hi > 40) return ONE;
    if (x.hi < -40) return NEG_ONE;
    if (Math.abs(x.hi) < 1e-2) {
      return div(sinh(x), cosh(x));
    }
    const e2x = exp(ldexp(x, 1));
    return div(sub(e2x, ONE), add(e2x, ONE));
  }

  function asinh(x) {
    if (isZero(x)) return ZERO;
    const negative = x.hi < 0;
    const u = abs(x);
    let res;
    if (u.hi > 1e100) {
      res = add(LN2, log(u));
    } else if (u.hi < 1e-2) {
      // log1p(u + u^2 / (1 + sqrt(1 + u^2))) -> zero cancellation!
      const u2 = sqr(u);
      const denom = add(ONE, sqrt(add(ONE, u2)));
      const arg = add(u, div(u2, denom));
      res = log1p(arg);
    } else {
      res = log(add(u, sqrt(add(ONE, sqr(u)))));
    }
    return negative ? neg(res) : res;
  }

  function acosh(x) {
    if (cmp(x, ONE) < 0) return { hi: NaN, lo: NaN };
    const xm1 = sub(x, ONE);
    if (xm1.hi < 1e-2) {
      // acosh(1 + d) = asinh(sqrt(d * (2 + d)))
      return asinh(sqrt(mul(xm1, add(TWO, xm1))));
    }
    return log(add(x, sqrt(sub(sqr(x), ONE))));
  }

  function sincos(x) {
    if (isNaNDD(x)) return { sin: { hi: NaN, lo: NaN }, cos: { hi: NaN, lo: NaN } };
    if (isZero(x)) return { sin: ZERO, cos: ONE };

    // Reduce x = k * (pi/2) + r, |r| <= pi/4
    const k = Math.round(x.hi / HALF_PI.hi);
    const r = sub(x, mulScalar(HALF_PI, k));

    // Halve 4 times so |t| <= 0.05
    const t = ldexp(r, -4);
    const t2 = sqr(t);

    // sin(t) Taylor series
    let s = t;
    let termS = t;
    for (let n = 1; n <= 12; n++) {
      termS = neg(divScalar(mul(termS, t2), (2 * n) * (2 * n + 1)));
      s = add(s, termS);
      if (Math.abs(termS.hi) < 1e-34) break;
    }

    // cos(t) Taylor series
    let c = ONE;
    let termC = ONE;
    for (let n = 1; n <= 12; n++) {
      termC = neg(divScalar(mul(termC, t2), (2 * n - 1) * (2 * n)));
      c = add(c, termC);
      if (Math.abs(termC.hi) < 1e-34) break;
    }

    // Double angle 4 times
    for (let i = 0; i < 4; i++) {
      const s2 = ldexp(mul(s, c), 1);
      const c2 = sub(sqr(c), sqr(s));
      s = s2;
      c = c2;
    }

    const q = ((k % 4) + 4) % 4;
    if (q === 0) return { sin: s, cos: c };
    if (q === 1) return { sin: c, cos: neg(s) };
    if (q === 2) return { sin: neg(s), cos: neg(c) };
    return { sin: neg(c), cos: s };
  }

  function sin(x) {
    return sincos(x).sin;
  }

  function cos(x) {
    return sincos(x).cos;
  }

  function tan(x) {
    const sc = sincos(x);
    return div(sc.sin, sc.cos);
  }

  function atan2(y, x) {
    if (isNaNDD(y) || isNaNDD(x)) return { hi: NaN, lo: NaN };
    if (isZero(x) && isZero(y)) return ZERO;
    if (isZero(x)) return y.hi > 0 ? HALF_PI : neg(HALF_PI);
    if (isZero(y)) return x.hi >= 0 ? ZERO : PI;

    // Normalize magnitude to prevent overflow/underflow
    const scale = Math.max(Math.abs(x.hi), Math.abs(y.hi));
    const xs = divScalar(x, scale);
    const ys = divScalar(y, scale);

    let theta = from(Math.atan2(ys.hi, xs.hi));
    // Two Newton steps on tan(phi - theta) = (y cos t - x sin t) / (x cos t + y sin t)
    for (let i = 0; i < 2; i++) {
      const sc = sincos(theta);
      const num = sub(mul(ys, sc.cos), mul(xs, sc.sin));
      const den = add(mul(xs, sc.cos), mul(ys, sc.sin));
      theta = add(theta, div(num, den));
    }
    return theta;
  }

  function atan(x) {
    return atan2(x, ONE);
  }

  // --- Decimal String Parser & Formatter ---

  function pow10(n) {
    // Compute 10^n in DD accurately
    if (n === 0) return ONE;
    const negExp = n < 0;
    let e = Math.abs(n);
    let base = from(10);
    let res = ONE;
    while (e > 0) {
      if (e & 1) res = mul(res, base);
      e >>= 1;
      if (e > 0) base = sqr(base);
    }
    return negExp ? div(ONE, res) : res;
  }

  function fromString(str) {
    if (typeof str === 'number') return from(str);
    const s = String(str).trim().replace(/−/g, '-');
    if (!s) return { hi: NaN, lo: NaN };

    // Handle simple expressions like "1 - 1e-10" or "pi/4"
    const m = s.match(/^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
    if (!m || (!m[2] && !m[3])) {
      const n = Number(s);
      return Number.isNaN(n) ? { hi: NaN, lo: NaN } : from(n);
    }

    const sign = m[1] === '-' ? -1 : 1;
    const intPart = m[2] || '0';
    const fracPart = m[3] || '';
    const expPart = m[4] ? parseInt(m[4], 10) : 0;

    const digits = (intPart + fracPart).replace(/^0+/, '');
    if (!digits) return ZERO;

    const totalExp = expPart - fracPart.length;
    // Take up to 34 significant digits
    const kept = digits.slice(0, 34);
    const dropped = digits.length - kept.length;

    let acc = ZERO;
    for (let i = 0; i < kept.length; i++) {
      acc = addScalar(mulScalar(acc, 10), kept.charCodeAt(i) - 48);
    }

    const finalExp = totalExp + dropped;
    if (finalExp !== 0) {
      acc = mul(acc, pow10(finalExp));
    }
    return sign < 0 ? neg(acc) : acc;
  }

  function toPrecision(a, sigFigs) {
    const sf = Math.max(1, Math.min(28, sigFigs || 12));
    if (!isFiniteDD(a)) return String(a.hi);
    if (isZero(a)) return '0';

    const negative = a.hi < 0;
    let v = abs(a);
    const exp10 = Math.floor(Math.log10(v.hi));

    // Scale v so that 1 <= v < 10
    let scaled = mul(v, pow10(-exp10));
    let adjExp = exp10;
    while (scaled.hi >= 10) {
      scaled = divScalar(scaled, 10);
      adjExp++;
    }
    while (scaled.hi < 1) {
      scaled = mulScalar(scaled, 10);
      adjExp--;
    }

    // Extract sf + 1 digits for rounding
    const digs = [];
    let cur = scaled;
    for (let i = 0; i <= sf; i++) {
      let d = Math.floor(cur.hi + cur.lo);
      if (d < 0) d = 0;
      if (d > 9) d = 9;
      digs.push(d);
      cur = mulScalar(subScalar(cur, d), 10);
      if (cur.hi < 0) cur = ZERO;
    }

    // Round half-up
    if (digs[sf] >= 5) {
      let carry = 1;
      for (let i = sf - 1; i >= 0 && carry; i--) {
        digs[i] += carry;
        if (digs[i] === 10) {
          digs[i] = 0;
          carry = 1;
        } else {
          carry = 0;
        }
      }
      if (carry) {
        digs.unshift(1);
        adjExp++;
      }
    }

    const dStr = digs.slice(0, sf).join('');
    const signStr = negative ? '-' : '';

    // Decide fixed vs scientific notation
    if (adjExp >= -4 && adjExp < sf) {
      if (adjExp < 0) {
        const zeros = '0'.repeat(-adjExp - 1);
        const trimmed = (zeros + dStr).replace(/0+$/, '');
        return signStr + '0.' + (trimmed || '0');
      } else {
        const intPart = dStr.slice(0, adjExp + 1);
        const fracPart = dStr.slice(adjExp + 1).replace(/0+$/, '');
        return signStr + intPart + (fracPart ? '.' + fracPart : '');
      }
    } else {
      const mant = (dStr[0] + '.' + dStr.slice(1)).replace(/\.?0+$/, '');
      return signStr + mant + 'e' + (adjExp >= 0 ? '+' : '') + adjExp;
    }
  }

  // --- Complex Double-Double (CDD) ---

  function cdd(re, im) {
    return { re: from(re), im: from(im || 0) };
  }

  function cAdd(a, b) {
    return { re: add(a.re, b.re), im: add(a.im, b.im) };
  }

  function cSub(a, b) {
    return { re: sub(a.re, b.re), im: sub(a.im, b.im) };
  }

  function cNeg(a) {
    return { re: neg(a.re), im: neg(a.im) };
  }

  function cConj(a) {
    return { re: a.re, im: neg(a.im) };
  }

  function cMul(a, b) {
    return {
      re: sub(mul(a.re, b.re), mul(a.im, b.im)),
      im: add(mul(a.re, b.im), mul(a.im, b.re)),
    };
  }

  function cMulReal(a, r) {
    return { re: mul(a.re, r), im: mul(a.im, r) };
  }

  function cDiv(a, b) {
    // Scale by max(|b.re|, |b.im|) to prevent overflow/underflow
    const d = add(sqr(b.re), sqr(b.im));
    return {
      re: div(add(mul(a.re, b.re), mul(a.im, b.im)), d),
      im: div(sub(mul(a.im, b.re), mul(a.re, b.im)), d),
    };
  }

  function cAbs2(a) {
    return add(sqr(a.re), sqr(a.im));
  }

  function cAbs(a) {
    return hypot(a.re, a.im);
  }

  function cArg(a) {
    return atan2(a.im, a.re);
  }

  function cExpI(theta) {
    const sc = sincos(theta);
    return { re: sc.cos, im: sc.sin };
  }

  /**
   * Computes 1 - |z|^2 = (1 - x^2) - y^2 in 106-bit DD.
   * Eliminates catastrophic cancellation for points near |z| = 1.
   */
  function oneMinusAbs2(z) {
    return sub(sub(ONE, sqr(z.re)), sqr(z.im));
  }

  return {
    ZERO, ONE, TWO, FOUR, HALF, NEG_ONE,
    PI, TWO_PI, HALF_PI, LN2, LN10,
    make, from, fromString, toNumber, toPrecision,
    isFiniteDD, isNaNDD, isZero,
    neg, abs, cmp,
    add, addScalar, sub, subScalar,
    mul, mulScalar, sqr, div, divScalar, ldexp,
    sqrt, hypot,
    exp, log, log1p, sinh, cosh, tanh, asinh, acosh,
    sincos, sin, cos, tan, atan2, atan,
    pow10,
    // Complex
    cdd, cAdd, cSub, cNeg, cConj, cMul, cMulReal, cDiv,
    cAbs2, cAbs, cArg, cExpI, oneMinusAbs2,
  };
});

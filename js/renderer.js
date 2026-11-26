/**
 * High-DPI Canvas Renderer for the Poincaré Disk Model H^2 = { z in C : |z| < 1 }
 * Optimized for Mac Safari & iPhone Safari (Retina scaling, CoreGraphics safe arc handling,
 * zoom/pan up to 10,000x near boundary, light/dark themes).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./hyperbolic.js'));
  } else {
    root.H2Renderer = factory(root.H2);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (H2) {
  'use strict';

  const DD = H2.DD;

  const THEMES = {
    dark: {
      canvasBg: '#0b1120',
      diskFill: '#111a2e',
      diskBorder: '#cbd5e1',
      diskBorderGlow: 'rgba(56, 189, 248, 0.22)',
      gridHyp: 'rgba(148, 163, 184, 0.16)',
      gridAxis: 'rgba(148, 163, 184, 0.22)',
      gridLabel: 'rgba(148, 163, 184, 0.65)',
      tilingStroke: 'rgba(99, 102, 241, 0.20)',
      geodesicFull: 'rgba(148, 163, 184, 0.34)',
      geodesicSeg: '#38bdf8',
      geodesicAccent: '#f59e0b',
      polyFill: 'rgba(56, 189, 248, 0.17)',
      polyStroke: '#38bdf8',
      polyImageFill: 'rgba(245, 158, 11, 0.19)',
      polyImageStroke: '#f59e0b',
      angleArc: 'rgba(251, 191, 36, 0.85)',
      angleFill: 'rgba(251, 191, 36, 0.18)',
      circleFill: 'rgba(167, 139, 250, 0.14)',
      circleStroke: '#a78bfa',
      centerMarker: '#34d399',
      midpoint: '#f472b6',
      perpLine: '#34d399',
      parallelRay: 'rgba(52, 211, 153, 0.55)',
      pointFill: '#38bdf8',
      pointSelected: '#fbbf24',
      pointImage: '#f59e0b',
      alphaFill: '#f43f5e',
      fixedPt: '#10b981',
      invariantCurve: 'rgba(16, 185, 129, 0.36)',
      axisStroke: 'rgba(16, 185, 129, 0.85)',
      pointStroke: '#0b1120',
      labelText: '#f8fafc',
      labelBg: 'rgba(15, 23, 42, 0.78)',
    },
    light: {
      canvasBg: '#f1f5f9',
      diskFill: '#ffffff',
      diskBorder: '#1e293b',
      diskBorderGlow: 'rgba(2, 132, 199, 0.12)',
      gridHyp: 'rgba(100, 116, 139, 0.18)',
      gridAxis: 'rgba(100, 116, 139, 0.26)',
      gridLabel: 'rgba(71, 85, 105, 0.75)',
      tilingStroke: 'rgba(79, 70, 229, 0.16)',
      geodesicFull: 'rgba(100, 116, 139, 0.35)',
      geodesicSeg: '#0284c7',
      geodesicAccent: '#d97706',
      polyFill: 'rgba(2, 132, 199, 0.13)',
      polyStroke: '#0284c7',
      polyImageFill: 'rgba(217, 119, 6, 0.16)',
      polyImageStroke: '#d97706',
      angleArc: 'rgba(217, 119, 6, 0.9)',
      angleFill: 'rgba(217, 119, 6, 0.16)',
      circleFill: 'rgba(124, 58, 237, 0.10)',
      circleStroke: '#7c3aed',
      centerMarker: '#059669',
      midpoint: '#db2777',
      perpLine: '#059669',
      parallelRay: 'rgba(5, 150, 105, 0.55)',
      pointFill: '#0284c7',
      pointSelected: '#d97706',
      pointImage: '#d97706',
      alphaFill: '#e11d48',
      fixedPt: '#059669',
      invariantCurve: 'rgba(5, 150, 105, 0.35)',
      axisStroke: 'rgba(5, 150, 105, 0.85)',
      pointStroke: '#ffffff',
      labelText: '#0f172a',
      labelBg: 'rgba(255, 255, 255, 0.85)',
    },
  };

  // Precompute a clean {5, 4} right-angled pentagon tiling (float64) for optional background grid
  const TILING_EDGES = (function buildRightPentagonTiling() {
    const cotPi5 = 1 / Math.tan(Math.PI / 5);
    const R = Math.acosh(cotPi5);
    const r0 = Math.tanh(R / 2);
    const basePoly = [];
    for (let k = 0; k < 5; k++) {
      const th = (2 * Math.PI * k) / 5;
      basePoly.push([r0 * Math.cos(th), r0 * Math.sin(th)]);
    }

    function circleOf(p, q) {
      const cross = p[0] * q[1] - p[1] * q[0];
      if (Math.abs(cross) < 1e-10) return { line: true, p, q };
      const s1 = 0.5 * (1 + p[0] * p[0] + p[1] * p[1]);
      const s2 = 0.5 * (1 + q[0] * q[0] + q[1] * q[1]);
      const cx = (s1 * q[1] - s2 * p[1]) / cross;
      const cy = (p[0] * s2 - q[0] * s1) / cross;
      const r2 = cx * cx + cy * cy - 1;
      return { line: false, cx, cy, r2 };
    }

    function reflectPt(pt, geo) {
      if (geo.line) {
        const dx = geo.q[0] - geo.p[0], dy = geo.q[1] - geo.p[1];
        const l2 = dx * dx + dy * dy;
        const t = ((pt[0] - geo.p[0]) * dx + (pt[1] - geo.p[1]) * dy) / l2;
        const px = geo.p[0] + t * dx, py = geo.p[1] + t * dy;
        return [2 * px - pt[0], 2 * py - pt[1]];
      }
      const dx = pt[0] - geo.cx, dy = pt[1] - geo.cy;
      const d2 = dx * dx + dy * dy;
      const f = geo.r2 / d2;
      return [geo.cx + dx * f, geo.cy + dy * f];
    }

    const seenPolys = new Set();
    const seenEdges = new Set();
    const edges = [];

    function polyKey(poly) {
      let cx = 0, cy = 0;
      for (const p of poly) { cx += p[0]; cy += p[1]; }
      return `${Math.round((cx / 5) * 200)},${Math.round((cy / 5) * 200)}`;
    }

    function edgeKey(a, b) {
      const k1 = `${Math.round(a[0] * 300)},${Math.round(a[1] * 300)}`;
      const k2 = `${Math.round(b[0] * 300)},${Math.round(b[1] * 300)}`;
      return k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
    }

    const queue = [{ poly: basePoly, depth: 0 }];
    seenPolys.add(polyKey(basePoly));

    while (queue.length > 0) {
      const { poly, depth } = queue.shift();
      for (let i = 0; i < 5; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % 5];
        const ek = edgeKey(a, b);
        if (!seenEdges.has(ek)) {
          seenEdges.add(ek);
          edges.push([a, b]);
        }
        if (depth < 3) {
          const geo = circleOf(a, b);
          const next = poly.map(p => reflectPt(p, geo));
          // Keep polygons reasonably visible (centroid r < 0.96)
          let mx = 0, my = 0;
          for (const p of next) { mx += p[0]; my += p[1]; }
          if (Math.hypot(mx / 5, my / 5) < 0.965) {
            const pk = polyKey(next);
            if (!seenPolys.has(pk)) {
              seenPolys.add(pk);
              queue.push({ poly: next, depth: depth + 1 });
            }
          }
        }
      }
    }
    return edges;
  })();

  function createRenderer(canvas) {
    const ctx = canvas.getContext('2d');
    let width = 400;
    let height = 400;
    let dpr = 1;

    // Viewport: center in disk coords (cx, cy) and zoom multiplier
    const view = {
      cx: 0,
      cy: 0,
      zoom: 1,
    };

    function baseRadius() {
      return Math.min(width, height) * 0.445;
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(100, rect.width);
      height = Math.max(100, rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 3);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function diskToScreen(x, y) {
      const R = baseRadius() * view.zoom;
      return {
        x: width * 0.5 + (x - view.cx) * R,
        y: height * 0.5 - (y - view.cy) * R,
      };
    }

    function screenToDisk(sx, sy) {
      const R = baseRadius() * view.zoom;
      return {
        x: (sx - width * 0.5) / R + view.cx,
        y: -(sy - height * 0.5) / R + view.cy,
      };
    }

    function diskScale() {
      return baseRadius() * view.zoom;
    }

    // --- Geometric Drawing Primitives (Safari CoreGraphics Safe) ---

    function sampleGeodesicPoints(pA, pB, steps) {
      // Float64 fast geodesic segment sampling (safe even for huge Euclidean radii!)
      const ax = pA.x, ay = pA.y;
      const bx = pB.x, by = pB.y;
      const cross = ax * by - ay * bx;
      const pts = [];
      const n = steps || 36;

      if (Math.abs(cross) < 1e-8) {
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          pts.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t });
        }
        return pts;
      }

      const s1 = 0.5 * (1 + ax * ax + ay * ay);
      const s2 = 0.5 * (1 + bx * bx + by * by);
      const cx = (s1 * by - s2 * ay) / cross;
      const cy = (ax * s2 - bx * s1) / cross;
      const r2 = cx * cx + cy * cy - 1;
      if (r2 <= 0 || r2 > 1e12) {
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          pts.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t });
        }
        return pts;
      }
      const r = Math.sqrt(r2);
      const a1 = Math.atan2(ay - cy, ax - cx);
      const a2 = Math.atan2(by - cy, bx - cx);
      let da = a2 - a1;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;

      for (let i = 0; i <= n; i++) {
        const ang = a1 + da * (i / n);
        pts.push({ x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang) });
      }
      return pts;
    }

    function traceGeodesicSegment(pA, pB, moveFirst) {
      const pts = sampleGeodesicPoints(pA, pB, 40);
      for (let i = 0; i < pts.length; i++) {
        const s = diskToScreen(pts[i].x, pts[i].y);
        if (i === 0 && moveFirst) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      }
    }

    function drawGeodesicSegment(A, B, color, lineWidth, dashed) {
      const pA = H2.toFloat(A);
      const pB = H2.toFloat(B);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth || 2.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (dashed) ctx.setLineDash(dashed);
      ctx.beginPath();
      traceGeodesicSegment(pA, pB, true);
      ctx.stroke();
      ctx.restore();
    }

    function drawFullGeodesic(A, B, color, lineWidth, dashed) {
      const geo = H2.geodesic(A, B);
      if (!geo.valid) return;
      const pS = H2.toFloat(geo.idealStart);
      const pE = H2.toFloat(geo.idealEnd);
      drawGeodesicSegment(
        { re: DD.from(pS.x), im: DD.from(pS.y) },
        { re: DD.from(pE.x), im: DD.from(pE.y) },
        color,
        lineWidth || 1.2,
        dashed
      );
    }

    function drawFullGeodesicFromBoundary(pStart, pEnd, color, lineWidth, dashed) {
      const s = H2.toFloat(pStart);
      const e = H2.toFloat(pEnd);
      const pts = sampleGeodesicPoints(s, e, 56);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth || 1.6;
      if (dashed) ctx.setLineDash(dashed);
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const sp = diskToScreen(pts[i].x, pts[i].y);
        if (i === 0) ctx.moveTo(sp.x, sp.y);
        else ctx.lineTo(sp.x, sp.y);
      }
      ctx.stroke();
      ctx.restore();
    }

    function drawPolygon(vertices, fillColor, strokeColor, lineWidth, dashed) {
      if (!vertices || vertices.length < 3) return;
      const fPts = vertices.map(H2.toFloat);
      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < fPts.length; i++) {
        const a = fPts[i];
        const b = fPts[(i + 1) % fPts.length];
        traceGeodesicSegment(a, b, i === 0);
      }
      ctx.closePath();
      if (fillColor) {
        ctx.fillStyle = fillColor;
        ctx.fill();
      }
      if (strokeColor) {
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = lineWidth || 2.2;
        ctx.lineJoin = 'round';
        if (dashed) ctx.setLineDash(dashed);
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawAngleArc(prevPt, vertexPt, nextPt, theme, labelText) {
      const info = H2.angleInfo(prevPt, vertexPt, nextPt);
      if (!info.reliable || info.angle.hi < 0.02) return;
      const v = H2.toFloat(vertexPt);
      const sv = diskToScreen(v.x, v.y);

      // Compute exact tangent directions at vertexPt in disk coordinates!
      // Because phi_{0, A} is conformal with positive real derivative at A:
      // phi'_{0,A}(A) = 1 / (1 - |A|^2) > 0, tangent direction at A equals direction of phi_{0,A}(B) at 0!
      const t1 = DD.toNumber(info.tangentU);
      const t2 = DD.toNumber(info.tangentV);

      // Convert disk angle to canvas screen angle (canvas y is inverted: screenAngle = -diskAngle)
      const sa1 = -t1;
      const sa2 = -t2;
      let diff = sa2 - sa1;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;

      const arcR = 22;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(sv.x, sv.y);
      ctx.arc(sv.x, sv.y, arcR, sa1, sa1 + diff, diff < 0);
      ctx.closePath();
      ctx.fillStyle = theme.angleFill;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(sv.x, sv.y, arcR, sa1, sa1 + diff, diff < 0);
      ctx.strokeStyle = theme.angleArc;
      ctx.lineWidth = 1.8;
      ctx.stroke();

      if (labelText && Math.abs(diff) > 0.14) {
        const midA = sa1 + diff * 0.5;
        const lx = sv.x + Math.cos(midA) * (arcR + 12);
        const ly = sv.y + Math.sin(midA) * (arcR + 12);
        ctx.font = 'italic 600 13px "STIX Two Math", Georgia, serif';
        ctx.fillStyle = theme.angleArc;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(labelText, lx, ly);
      }
      ctx.restore();
    }

    function drawEuclideanCircle(cx, cy, r, fillColor, strokeColor, lineWidth, dashed) {
      const s = diskToScreen(cx, cy);
      const sr = r * diskScale();
      if (sr <= 0.2 || sr > 1e6) return;
      ctx.save();
      ctx.beginPath();
      ctx.arc(s.x, s.y, sr, 0, Math.PI * 2);
      if (fillColor) {
        ctx.fillStyle = fillColor;
        ctx.fill();
      }
      if (strokeColor) {
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = lineWidth || 1.8;
        if (dashed) ctx.setLineDash(dashed);
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawPoint(pt, label, fillColor, theme, options) {
      const opts = options || {};
      const f = H2.toFloat(pt);
      const s = diskToScreen(f.x, f.y);
      const rad = opts.radius || 7;

      ctx.save();
      if (opts.halo) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, rad + 6, 0, Math.PI * 2);
        ctx.fillStyle = fillColor + '33';
        ctx.fill();
      }

      ctx.beginPath();
      if (opts.shape === 'diamond') {
        ctx.moveTo(s.x, s.y - rad);
        ctx.lineTo(s.x + rad, s.y);
        ctx.lineTo(s.x, s.y + rad);
        ctx.lineTo(s.x - rad, s.y);
        ctx.closePath();
      } else if (opts.shape === 'cross') {
        ctx.strokeStyle = fillColor;
        ctx.lineWidth = 2;
        ctx.moveTo(s.x - rad, s.y - rad);
        ctx.lineTo(s.x + rad, s.y + rad);
        ctx.moveTo(s.x + rad, s.y - rad);
        ctx.lineTo(s.x - rad, s.y + rad);
        ctx.stroke();
        ctx.restore();
        return;
      } else {
        ctx.arc(s.x, s.y, rad, 0, Math.PI * 2);
      }

      ctx.fillStyle = fillColor;
      ctx.fill();
      ctx.strokeStyle = theme.pointStroke;
      ctx.lineWidth = 2;
      ctx.stroke();

      if (label) {
        // Position label slightly outward from origin to keep figure uncluttered
        const norm = Math.hypot(f.x, f.y);
        const ox = norm > 0.05 ? (f.x / norm) * (rad + 14) : 13;
        const oy = norm > 0.05 ? (-f.y / norm) * (rad + 14) : -13;
        const lx = s.x + ox;
        const ly = s.y + oy;

        ctx.font = opts.font || '600 13px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';
        const metrics = ctx.measureText(label);
        const padX = 5;
        const bw = metrics.width + padX * 2;
        const bh = 18;
        ctx.fillStyle = theme.labelBg;
        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(lx - bw / 2, ly - bh / 2, bw, bh, 5);
        } else {
          ctx.rect(lx - bw / 2, ly - bh / 2, bw, bh);
        }
        ctx.fill();

        ctx.fillStyle = theme.labelText;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, lx, ly + 0.5);
      }
      ctx.restore();
    }

    // --- Isometry Invariant Geometry (Elliptic / Parabolic / Hyperbolic) ---

    function drawIsometryGeometry(iso, theme) {
      const info = H2.classifyIsometry(iso);
      if (!info.valid || info.type === 'identity') return;

      if (info.type === 'elliptic' && info.interiorFixed) {
        // Draw concentric invariant hyperbolic circles around interiorFixed
        for (const r of [0.45, 0.95, 1.55, 2.2]) {
          const c = H2.hyperbolicCircle(info.interiorFixed, r);
          if (c.valid) {
            const ec = H2.toFloat(c.euclidCenter);
            drawEuclideanCircle(ec.x, ec.y, DD.toNumber(c.euclidRadius), null, theme.invariantCurve, 1.2, [4, 4]);
          }
        }
        drawPoint(info.interiorFixed, '不動点', theme.fixedPt, theme, { radius: 6, shape: 'diamond' });
      } else if (info.type === 'parabolic' && info.boundaryFixed.length === 1) {
        // Draw invariant horocycles tangent to dH^2 at boundaryFixed[0]
        const bf = H2.toFloat(info.boundaryFixed[0]);
        for (const hr of [0.22, 0.42, 0.65, 0.84]) {
          const cx = bf.x * (1 - hr);
          const cy = bf.y * (1 - hr);
          drawEuclideanCircle(cx, cy, hr, null, theme.invariantCurve, 1.3, [4, 4]);
        }
        drawPoint(info.boundaryFixed[0], '放物不動点', theme.fixedPt, theme, { radius: 6, shape: 'diamond' });
      } else if (info.type === 'hyperbolic' && info.repelling && info.attracting) {
        // Draw geodesic axis connecting repelling -> attracting
        drawFullGeodesicFromBoundary(info.repelling, info.attracting, theme.axisStroke, 2.0, [7, 4]);

        // Draw equidistant curves (hypercycles = circular arcs passing through both fixed points)
        const m = H2.toFloat(info.repelling);
        const p = H2.toFloat(info.attracting);
        const mx = 0.5 * (m.x + p.x), my = 0.5 * (m.y + p.y);
        const dx = p.x - m.x, dy = p.y - m.y;
        const halfChord = 0.5 * Math.hypot(dx, dy);
        if (halfChord > 1e-4) {
          const nx = -dy / (2 * halfChord), ny = dx / (2 * halfChord);
          for (const hShift of [-1.2, -0.55, 0.55, 1.2]) {
            // Center on perpendicular bisector of chord m-p
            const cx = mx + nx * hShift;
            const cy = my + ny * hShift;
            const r = Math.hypot(m.x - cx, m.y - cy);
            drawEuclideanCircle(cx, cy, r, null, theme.invariantCurve, 1.1, [3, 4]);
          }
        }

        drawPoint(info.repelling, '反発 −', theme.fixedPt, theme, { radius: 5.5, shape: 'diamond' });
        drawPoint(info.attracting, '吸引 +', theme.fixedPt, theme, { radius: 5.5, shape: 'diamond' });
      }
    }

    // --- Main Frame Render ---

    function render(state) {
      const theme = THEMES[state.theme] || THEMES.dark;
      ctx.save();
      ctx.fillStyle = theme.canvasBg;
      ctx.fillRect(0, 0, width, height);

      const center = diskToScreen(0, 0);
      const R = diskScale();

      // Subtle outer glow around unit disk
      ctx.save();
      ctx.beginPath();
      ctx.arc(center.x, center.y, R + 3, 0, Math.PI * 2);
      ctx.strokeStyle = theme.diskBorderGlow;
      ctx.lineWidth = 6;
      ctx.stroke();
      ctx.restore();

      // Fill unit disk interior
      ctx.save();
      ctx.beginPath();
      ctx.arc(center.x, center.y, R, 0, Math.PI * 2);
      ctx.fillStyle = theme.diskFill;
      ctx.fill();
      ctx.clip();

      // 1. Optional {5,4} Hyperbolic Tiling
      if (state.showTiling) {
        ctx.save();
        ctx.strokeStyle = theme.tilingStroke;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < TILING_EDGES.length; i++) {
          const [a, b] = TILING_EDGES[i];
          traceGeodesicSegment({ x: a[0], y: a[1] }, { x: b[0], y: b[1] }, true);
        }
        ctx.stroke();
        ctx.restore();
      }

      // 2. Reference Grid (Hyperbolic distance circles + Axes)
      if (state.showGrid) {
        // Real & Imaginary axes
        ctx.save();
        ctx.strokeStyle = theme.gridAxis;
        ctx.lineWidth = 1;
        const left = diskToScreen(-1, 0), right = diskToScreen(1, 0);
        const top = diskToScreen(0, 1), bot = diskToScreen(0, -1);
        ctx.beginPath();
        ctx.moveTo(left.x, left.y); ctx.lineTo(right.x, right.y);
        ctx.moveTo(top.x, top.y); ctx.lineTo(bot.x, bot.y);
        ctx.stroke();

        // Concentric hyperbolic circles around 0: d(0, z) = 1, 2, 3, 4, 5
        ctx.strokeStyle = theme.gridHyp;
        ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillStyle = theme.gridLabel;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        for (let d = 1; d <= 5; d++) {
          const r = Math.tanh(d / 2);
          const sr = r * R;
          if (sr > 8 && sr < 1e5) {
            ctx.beginPath();
            ctx.arc(center.x, center.y, sr, 0, Math.PI * 2);
            ctx.stroke();
            if (d <= 3 || view.zoom > 1.8) {
              const lbl = diskToScreen(r * 0.7071, r * 0.7071);
              ctx.fillText(`d=${d}`, lbl.x + 3, lbl.y - 2);
            }
          }
        }
        ctx.restore();
      }

      const pts = state.points || [];
      const labels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

      // 3. Mode-Specific Geometry
      if (state.mode === 'points') {
        // Hyperbolic Circle around first point if enabled
        if (state.showCircle && pts.length >= 1) {
          const circ = H2.hyperbolicCircle(pts[0], state.circleRadius);
          if (circ.valid) {
            const ec = H2.toFloat(circ.euclidCenter);
            const er = DD.toNumber(circ.euclidRadius);
            drawEuclideanCircle(ec.x, ec.y, er, theme.circleFill, theme.circleStroke, 2);
            // Mark Euclidean center with a subtle cross to contrast with hyperbolic center
            drawPoint(circ.euclidCenter, '', theme.circleStroke, theme, { radius: 4.5, shape: 'cross' });
          }
        }

        // Geodesics between consecutive pairs (or all pairs up to 4 points)
        if (pts.length >= 2) {
          for (let i = 0; i < pts.length - 1; i++) {
            if (state.showFullGeodesics) {
              drawFullGeodesic(pts[i], pts[i + 1], theme.geodesicFull, 1.3, [5, 4]);
            }
            drawGeodesicSegment(pts[i], pts[i + 1], theme.geodesicSeg, 2.5);
          }

          // Midpoint & perpendicular bisector for A-B
          const geoAB = H2.geodesic(pts[0], pts[1]);
          if (geoAB.valid) {
            if (state.showPerpBisector) {
              const pb = H2.perpendicularBisector(pts[0], pts[1]);
              if (pb) drawFullGeodesic(pb.M, pb.P2, theme.midpoint, 1.4, [4, 4]);
            }
            if (state.showMidpoint) {
              drawPoint(geoAB.midpoint, 'M', theme.midpoint, theme, { radius: 5.5, shape: 'diamond' });
            }
          }

          // Perpendicular & Angle of Parallelism from C to geodesic AB
          if (state.showParallelism && pts.length >= 3 && geoAB.valid) {
            const perp = H2.pointToGeodesic(pts[2], pts[0], pts[1]);
            if (perp.valid) {
              drawGeodesicSegment(pts[2], perp.foot, theme.perpLine, 2.0, [5, 3]);
              drawGeodesicSegment(pts[2], geoAB.idealEnd, theme.parallelRay, 1.6, [3, 3]);
              drawGeodesicSegment(pts[2], geoAB.idealStart, theme.parallelRay, 1.6, [3, 3]);
              drawPoint(perp.foot, 'H', theme.perpLine, theme, { radius: 4.5, shape: 'diamond' });
            }
          }
        }
      } else if (state.mode === 'triangle') {
        if (pts.length >= 3) {
          if (state.showFullGeodesics) {
            for (let i = 0; i < pts.length; i++) {
              drawFullGeodesic(pts[i], pts[(i + 1) % pts.length], theme.geodesicFull, 1.1, [5, 4]);
            }
          }
          drawPolygon(pts, theme.polyFill, theme.polyStroke, 2.5);

          // Interior angle arcs
          const greek = ['α', 'β', 'γ', 'δ', 'ε', 'ζ', 'η', 'θ'];
          for (let i = 0; i < pts.length; i++) {
            const prev = pts[(i + pts.length - 1) % pts.length];
            const curr = pts[i];
            const next = pts[(i + 1) % pts.length];
            drawAngleArc(prev, curr, next, theme, pts.length <= 8 ? greek[i] : '');
          }

          // Triangle centers (incircle, circumcircle, centroid) when n === 3
          if (pts.length === 3 && state.showCenters && state.cachedTriAnalysis) {
            const tri = state.cachedTriAnalysis;
            if (tri.incircle && tri.incircle.valid) {
              const ec = H2.toFloat(tri.incircle.euclidCenter);
              drawEuclideanCircle(ec.x, ec.y, DD.toNumber(tri.incircle.euclidRadius), null, theme.centerMarker, 1.6, [4, 3]);
              drawPoint(tri.incircle.center, 'I', theme.centerMarker, theme, { radius: 4.5, shape: 'diamond' });
            }
            if (tri.circumcircle && tri.circumcircle.valid) {
              const ec = H2.toFloat(tri.circumcircle.euclidCenter);
              drawEuclideanCircle(ec.x, ec.y, DD.toNumber(tri.circumcircle.euclidRadius), null, theme.circleStroke, 1.5, [6, 4]);
              drawPoint(tri.circumcircle.center, 'O', theme.circleStroke, theme, { radius: 4.5, shape: 'diamond' });
            }
            if (tri.centroid) {
              drawPoint(tri.centroid, 'G', theme.midpoint, theme, { radius: 4.5, shape: 'diamond' });
            }
          }
        } else if (pts.length === 2) {
          drawGeodesicSegment(pts[0], pts[1], theme.geodesicSeg, 2.2);
        }
      } else if (state.mode === 'isometry') {
        const activeIso = state.animatingIso || state.isometry;

        // Invariant curves & fixed points of full target isometry
        if (state.showInvariant) {
          drawIsometryGeometry(state.isometry, theme);
        }

        // Draw original shape (muted/dashed)
        if (pts.length >= 3) {
          drawPolygon(pts, 'rgba(56, 189, 248, 0.09)', theme.geodesicSeg, 1.8, [5, 4]);
        } else if (pts.length === 2) {
          drawGeodesicSegment(pts[0], pts[1], theme.geodesicSeg, 1.8, [5, 4]);
        }

        // Draw transformed shape phi(pts)
        const imgPts = pts.map(p => H2.applyIsometry(activeIso, p));
        if (imgPts.length >= 3) {
          drawPolygon(imgPts, theme.polyImageFill, theme.polyImageStroke, 2.5);
        } else if (imgPts.length === 2) {
          drawGeodesicSegment(imgPts[0], imgPts[1], theme.polyImageStroke, 2.5);
        }

        // Optional Orbit phi^n(A) for n = -3..+3
        if (state.showOrbit && pts.length >= 1) {
          const invIso = H2.inverseIsometry(state.isometry);
          let curFwd = pts[0];
          let curBwd = pts[0];
          for (let k = 1; k <= 4; k++) {
            curFwd = H2.applyIsometry(state.isometry, curFwd);
            curBwd = H2.applyIsometry(invIso, curBwd);
            drawPoint(curFwd, `φ^${k}`, theme.polyImageStroke, theme, { radius: 4 });
            drawPoint(curBwd, `φ^−${k}`, theme.geodesicSeg, theme, { radius: 4 });
          }
        }

        // Draw transformed vertices
        for (let i = 0; i < imgPts.length; i++) {
          const lbl = `${labels[i % 26]}'`;
          drawPoint(imgPts[i], lbl, theme.pointImage, theme, { radius: 6 });
        }
      }

      // 4. Draw Primary Interactive Points (always on top inside disk)
      for (let i = 0; i < pts.length; i++) {
        const isSel = i === state.selectedIndex;
        const lbl = labels[i % 26] + (i >= 26 ? String(Math.floor(i / 26)) : '');
        drawPoint(
          pts[i],
          lbl,
          isSel ? theme.pointSelected : theme.pointFill,
          theme,
          { radius: isSel ? 8.5 : 7, halo: isSel }
        );
      }

      // Draw draggable alpha parameter in isometry mode
      if (state.mode === 'isometry' && state.isometry) {
        const isAlphaSel = state.selectedAlpha;
        drawPoint(
          state.isometry.alpha,
          'α',
          theme.alphaFill,
          theme,
          { radius: isAlphaSel ? 9 : 7.5, halo: true }
        );
      }

      ctx.restore(); // End disk clip

      // 5. Crisp Ideal Boundary Circle dH^2 = { |z| = 1 }
      ctx.save();
      ctx.beginPath();
      ctx.arc(center.x, center.y, R, 0, Math.PI * 2);
      ctx.strokeStyle = theme.diskBorder;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Subtle degree ticks on boundary (0, pi/2, pi, 3pi/2)
      ctx.font = '11px "STIX Two Math", Georgia, serif';
      ctx.fillStyle = theme.gridLabel;
      const bLabels = [
        { a: 0, text: '1', dx: 10, dy: 0 },
        { a: Math.PI / 2, text: 'i', dx: 0, dy: -11 },
        { a: Math.PI, text: '−1', dx: -14, dy: 0 },
        { a: -Math.PI / 2, text: '−i', dx: 0, dy: 12 },
      ];
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const bl of bLabels) {
        const sp = diskToScreen(Math.cos(bl.a), Math.sin(bl.a));
        if (sp.x > -20 && sp.x < width + 20 && sp.y > -20 && sp.y < height + 20) {
          ctx.fillText(bl.text, sp.x + bl.dx, sp.y + bl.dy);
        }
      }
      ctx.restore();

      ctx.restore();
    }

    function hitTest(sx, sy, state, isTouch) {
      const hitRad = isTouch ? 28 : 18;
      // Check alpha first in isometry mode
      if (state.mode === 'isometry' && state.isometry) {
        const fa = H2.toFloat(state.isometry.alpha);
        const sa = diskToScreen(fa.x, fa.y);
        if (Math.hypot(sx - sa.x, sy - sa.y) <= hitRad + 4) {
          return { type: 'alpha' };
        }
      }
      let bestIdx = -1;
      let bestDist = hitRad;
      const pts = state.points || [];
      for (let i = 0; i < pts.length; i++) {
        const f = H2.toFloat(pts[i]);
        const sp = diskToScreen(f.x, f.y);
        const d = Math.hypot(sx - sp.x, sy - sp.y);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0) return { type: 'point', index: bestIdx };
      return null;
    }

    function resetView() {
      view.cx = 0;
      view.cy = 0;
      view.zoom = 1;
    }

    function zoomAt(sx, sy, factor) {
      const before = screenToDisk(sx, sy);
      const nextZoom = Math.max(1, Math.min(10000, view.zoom * factor));
      view.zoom = nextZoom;
      if (nextZoom <= 1.001) {
        view.cx = 0;
        view.cy = 0;
      } else {
        const after = screenToDisk(sx, sy);
        view.cx += before.x - after.x;
        view.cy += before.y - after.y;
        // Clamp center inside extended disk
        const r = Math.hypot(view.cx, view.cy);
        if (r > 1.05) {
          view.cx *= 1.05 / r;
          view.cy *= 1.05 / r;
        }
      }
    }

    return {
      view,
      resize,
      render,
      diskToScreen,
      screenToDisk,
      hitTest,
      resetView,
      zoomAt,
    };
  }

  return { createRenderer };
});

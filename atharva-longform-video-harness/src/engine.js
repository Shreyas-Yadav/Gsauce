// src/engine.js — Hand-Drawn Ink, Watercolor Wash, & Sketched Doodle Engine
// Inspired by @kickingkeys (Surya), anidoodle (wren.ts, balloon.ts, pocketWatch.ts), and ClaudeAnimationBase.
// Every mark is a pure deterministic function of time t:
// - Warm toothy sketchbook paper (#FAF5E8) with faint graph lines & cold-press fibers
// - Wet watercolor washes (`wetWash`) with displaced organic edges & bottom pigment pooling
// - Crayon / pencil back-and-forth scribble & cross-hatching (`scribbleFill`)
// - Pressure-modulated, tapered fountain-pen & pencil strokes (`penStroke`) with progressive draw-on (`progress`) and 12 fps line boil (`boilN`)
// - Hand-drawn Notebook Cards with masking tape, drop-shadow hatching, and double-retraced wobbly contours

(function () {
  const W = 1920;
  const H = 1080;

  // Warm Sketchbook & Watercolor Ink Palette
  const PAL = {
    paper: "#FAF5E8",
    paperWarm: "#F3EBDC",
    paperCard: "#FFFDF7",
    paperShadow: "#E4D9C3",
    ink: "#241E28",
    inkSoft: "#4A4252",
    graphite: "#5A5360",
    biroBlue: "#264394",
    amber: "#E07A38",
    gold: "#E8A838",
    ochre: "#DF9A2F",
    teal: "#2A857E",
    tealBright: "#1F6E68",
    crimson: "#C83E37",
    crimsonBright: "#D6322A",
    rose: "#E27A88",
    sage: "#638C52",
    violet: "#6E5696",
    steel: "#7A7480",
    vellum: "#241E28",      // Primary text ink on warm paper
    vellumDim: "#5A5360"    // Secondary pencil-gray text on warm paper
  };

  // --- Deterministic PRNG (Mulberry32 + FNV-1a string hash) ---
  function hashStr(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function rngFor(key) {
    let a = typeof key === "number" ? (key >>> 0) : hashStr(String(key));
    if (a === 0) a = 0x9E3779B9;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Smooth 2D value/gradient noise for organic watercolor bleed & paper mottling
  function noise2D(seed, x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const sx = xf * xf * (3 - 2 * xf);
    const sy = yf * yf * (3 - 2 * yf);
    const h = (ix, iy) => {
      let n = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041);
      n = (n ^ (n >>> 13)) * 1274126177;
      return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
    };
    const a = h(xi, yi);
    const b = h(xi + 1, yi);
    const c = h(xi, yi + 1);
    const d = h(xi + 1, yi + 1);
    return a + sx * (b - a) + sy * (c - a + sx * (d - c - b + a));
  }

  function fractalNoise(seed, x, y, freq = 0.02, octaves = 2) {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let f = freq;
    for (let o = 0; o < octaves; o++) {
      sum += (noise2D(seed + o * 97, x * f, y * f) - 0.5) * 2 * amp;
      norm += amp;
      amp *= 0.5;
      f *= 2.05;
    }
    return sum / norm;
  }

  // --- Math & Easing Helpers ---
  const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const invLerp = (a, b, v) => clamp((v - a) / (b - a || 1e-9), 0, 1);
  const remap = (a0, a1, b0, b1, v) => lerp(b0, b1, invLerp(a0, a1, v));

  const easeOutCubic = (x) => 1 - Math.pow(1 - clamp(x), 3);
  const easeInCubic = (x) => Math.pow(clamp(x), 3);
  const easeInOutCubic = (x) => {
    x = clamp(x);
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  };
  const easeOutQuart = (x) => 1 - Math.pow(1 - clamp(x), 4);
  const easeOutBack = (x, s = 1.45) => {
    x = clamp(x);
    const c3 = s + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2);
  };
  const smoothstep = (a, b, t) => {
    const x = invLerp(a, b, t);
    return x * x * (3 - 2 * x);
  };
  const spring = (t, t0, k = 6, w = 16) => (t < t0 ? 0 : Math.exp(-k * (t - t0)) * Math.sin(w * (t - t0)));

  function windowEnv(t, start, end, fadeIn = 0.4, fadeOut = 0.4) {
    if (t <= start || t >= end) return 0;
    const uIn = fadeIn > 0 ? easeOutCubic(invLerp(start, start + fadeIn, t)) : 1;
    const uOut = fadeOut > 0 ? easeOutCubic(1 - invLerp(end - fadeOut, end, t)) : 1;
    return uIn * uOut;
  }

  function lerpColor(hexA, hexB, u) {
    u = clamp(u, 0, 1);
    const a = parseInt(hexA.slice(1), 16);
    const b = parseInt(hexB.slice(1), 16);
    const r = Math.round(lerp((a >> 16) & 255, (b >> 16) & 255, u));
    const g = Math.round(lerp((a >> 8) & 255, (b >> 8) & 255, u));
    const bl = Math.round(lerp(a & 255, b & 255, u));
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1);
  }

  // --- Pre-baked Cold-Press Watercolor Sketchbook Paper Backdrop ---
  let bgCanvas = null;
  function getStaticBackdrop() {
    if (bgCanvas) return bgCanvas;
    bgCanvas = document.createElement("canvas");
    bgCanvas.width = W;
    bgCanvas.height = H;
    const g = bgCanvas.getContext("2d");

    // 1. Warm cream sketchbook base with subtle edge darkening
    const rad = g.createRadialGradient(W * 0.5, H * 0.48, 150, W * 0.5, H * 0.5, W * 0.72);
    rad.addColorStop(0, "#FBF7EC");
    rad.addColorStop(0.7, "#F5EFE0");
    rad.addColorStop(1, "#EAE0CC");
    g.fillStyle = rad;
    g.fillRect(0, 0, W, H);

    // 2. Watercolor paper blotchy mottling (soft warm washes)
    const rng = rngFor("sketchbook-paper-1943");
    for (let i = 0; i < 140; i++) {
      const cx = rng() * W;
      const cy = rng() * H;
      const r = 60 + rng() * 180;
      const grad = g.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
      const warm = rng() < 0.55;
      grad.addColorStop(0, warm ? "rgba(218, 198, 165, 0.045)" : "rgba(255, 252, 244, 0.05)");
      grad.addColorStop(1, "rgba(245, 239, 224, 0)");
      g.fillStyle = grad;
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fill();
    }

    // 3. Faint cyanotype/notebook graph rulings (like an engineer's 1943 lab notebook)
    g.lineWidth = 1;
    for (let x = 40; x < W - 40; x += 32) {
      g.strokeStyle = (x - 40) % 160 === 0 ? "rgba(74, 114, 168, 0.12)" : "rgba(74, 114, 168, 0.055)";
      g.beginPath();
      g.moveTo(x + 0.5, 36);
      g.lineTo(x + 0.5, H - 36);
      g.stroke();
    }
    for (let y = 40; y < H - 40; y += 32) {
      g.strokeStyle = (y - 40) % 160 === 0 ? "rgba(74, 114, 168, 0.12)" : "rgba(74, 114, 168, 0.055)";
      g.beginPath();
      g.moveTo(36, y + 0.5);
      g.lineTo(W - 36, y + 0.5);
      g.stroke();
    }

    // Left red notebook margin line
    g.strokeStyle = "rgba(200, 62, 55, 0.18)";
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(76, 36);
    g.lineTo(76, H - 36);
    g.stroke();

    // 4. Cold-press paper tooth & tiny fiber flecks
    for (let i = 0; i < 8500; i++) {
      const px = rng() * W;
      const py = rng() * H;
      const sz = rng() < 0.82 ? 1.3 : 2.3;
      const a = 0.025 + rng() * 0.045;
      g.fillStyle = rng() < 0.65 ? `rgba(90, 75, 58, ${a})` : `rgba(255, 255, 255, ${a * 1.3})`;
      g.fillRect(px, py, sz, sz);
    }

    // 5. Hand-drawn outer sketchbook border (drawn twice with slight wobble)
    const borderPts = sketchyRectPts(28, 26, W - 56, H - 52, 1.4, "page-border");
    penStroke(g, borderPts, {
      closed: true,
      width: 2.0,
      color: PAL.inkSoft,
      alpha: 0.42,
      wobble: 1.2,
      retrace: true,
      seed: "page-border-s"
    });

    return bgCanvas;
  }

  // --- Geometry & Polyline Helpers ---
  function boilOffset(seedKey, t, amp = 1.8, rate = 10) {
    const tick = Math.floor(t * rate);
    const r = rngFor(`${seedKey}:${tick}`);
    return {
      dx: (r() - 0.5) * 2 * amp,
      dy: (r() - 0.5) * 2 * amp
    };
  }

  // Resample a polyline so vertices sit every `step` pixels apart
  function densify(pts, step = 6) {
    if (pts.length < 2) return pts.slice();
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const dist = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(dist / step));
      for (let k = 1; k <= n; k++) {
        const u = k / n;
        out.push([lerp(a[0], b[0], u), lerp(a[1], b[1], u)]);
      }
    }
    return out;
  }

  // Smooth Catmull-Rom spline through control points
  function smoothCurve(pts, closed = false, samplesPerSeg = 6) {
    if (pts.length < 3) return densify(pts, 6);
    const n = pts.length;
    const at = (i) => (closed ? pts[((i % n) + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
    const out = [];
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
      for (let k = 0; k < samplesPerSeg; k++) {
        const u = k / samplesPerSeg, u2 = u * u, u3 = u2 * u;
        const x = 0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * u + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * u2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * u3);
        const y = 0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * u + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * u2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * u3);
        out.push([x, y]);
      }
    }
    out.push(closed ? out[0] : pts[n - 1]);
    return out;
  }

  function sketchyRectPts(x, y, w, h, wobble = 2.0, seed = "rect") {
    const r = rngFor(seed);
    const j = () => (r() - 0.5) * 2 * wobble;
    const pts = [];
    const nx = Math.max(4, Math.min(18, Math.round(w / 70)));
    const ny = Math.max(2, Math.min(12, Math.round(h / 70)));
    for (let i = 0; i < nx; i++) {
      pts.push([x + (w * i) / nx + j() * 0.4, y + j() * 0.5]);
    }
    for (let i = 0; i < ny; i++) {
      pts.push([x + w + j() * 0.5, y + (h * i) / ny + j() * 0.4]);
    }
    for (let i = 0; i < nx; i++) {
      pts.push([x + w - (w * i) / nx + j() * 0.4, y + h + j() * 0.5]);
    }
    for (let i = 0; i < ny; i++) {
      pts.push([x + j() * 0.5, y + h - (h * i) / ny + j() * 0.4]);
    }
    return pts;
  }

  function sketchyCirclePts(cx, cy, rx, ry = rx, n = 20, wobble = 2.2, seed = "circle") {
    const r = rngFor(seed);
    const pts = [];
    const ph = r() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const dr = (r() - 0.5) * 2 * wobble + Math.sin(a * 3 + ph) * wobble * 0.45;
      pts.push([cx + Math.cos(a) * (rx + dr), cy + Math.sin(a) * (ry + dr)]);
    }
    return pts;
  }

  // --- Core Hand-Drawn Mark 1: `wetWash` (Watercolor Wash + Bottom Pigment Pooling + Rim Darkening) ---
  function wetWash(ctx, pts, color, opts = {}) {
    const {
      alpha = 0.55,
      seed = "wash",
      pool = 0.45,
      bleed = 3.5,
      rim = true,
      dx = 3,
      dy = 3
    } = opts;
    if (pts.length < 3 || alpha <= 0.01) return;

    const snum = hashStr(String(seed));
    const curve = smoothCurve(pts, true, 5);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const displaced = curve.map(([x, y], idx) => {
      const n1 = fractalNoise(snum, x + idx * 3, y, 0.025, 2) * bleed;
      const n2 = fractalNoise(snum + 71, x, y + idx * 3, 0.025, 2) * bleed;
      const px = x + dx + n1;
      const py = y + dy + n2;
      if (px < x0) x0 = px;
      if (py < y0) y0 = py;
      if (px > x1) x1 = px;
      if (py > y1) y1 = py;
      return [px, py];
    });

    ctx.save();
    ctx.beginPath();
    displaced.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();

    // Base wash fill
    ctx.fillStyle = color;
    ctx.globalAlpha *= alpha;
    ctx.fill();

    // Pigment pooling toward the bottom edge (wren.ts signature technique)
    if (pool > 0.05 && y1 > y0 + 8) {
      ctx.save();
      ctx.clip();
      const grad = ctx.createLinearGradient(0, y0 + (y1 - y0) * 0.35, 0, y1 + 4);
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(1, color);
      ctx.globalAlpha *= pool * 0.65;
      ctx.fillStyle = grad;
      ctx.fillRect(x0 - 10, y0 - 10, x1 - x0 + 20, y1 - y0 + 20);
      ctx.restore();
    }

    // Subtle crinkled pigment rim where wet watercolor dries
    if (rim) {
      ctx.strokeStyle = lerpColor(color, PAL.ink, 0.28);
      ctx.lineWidth = 1.4;
      ctx.globalAlpha *= 0.55;
      ctx.stroke();
    }
    ctx.restore();
  }

  // --- Core Hand-Drawn Mark 2: `penStroke` (Tapered, Pressure-Modulated Fountain Pen / Pencil with Boil & Retrace) ---
  function penStroke(ctx, pts, opts = {}) {
    const {
      width = 2.4,
      color = PAL.ink,
      alpha = 0.92,
      closed = false,
      wobble = 1.35,
      taper = 0.75,
      pressure = 0.45,
      retrace = true,
      progress = 1.0,
      boilTime = null, // pass `t` if you want 10fps hand-drawn line boil
      seed = "pen",
      inkBlob = false
    } = opts;

    if (pts.length < 2 || progress <= 0.005 || alpha <= 0.01) return;

    const boilTick = boilTime !== null ? Math.floor(boilTime * 10) : 0;
    const baseSeed = hashStr(`${seed}:${boilTick}`);
    const dense = smoothCurve(pts, closed, 5);
    const totalPts = progress < 1 ? Math.max(2, Math.ceil(dense.length * clamp(progress, 0, 1))) : dense.length;
    const slice = dense.slice(0, totalPts);

    function drawPass(passIdx, wScale, aScale, wobScale) {
      const r = rngFor(baseSeed + passIdx * 997);
      const ph = r() * Math.PI * 2;
      const L = [];
      const R = [];
      const n = slice.length;

      for (let i = 0; i < n; i++) {
        const u = i / Math.max(1, n - 1);
        const p = slice[i];
        const prev = slice[Math.max(0, i - 1)];
        const next = slice[Math.min(n - 1, i + 1)];
        const dx = next[0] - prev[0];
        const dy = next[1] - prev[1];
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;

        // Taper at start and end of open strokes
        const endEnv = closed ? 1.0 : Math.min(1, u / 0.12, (1 - u) / 0.14);
        const tp = 1 - taper + taper * Math.pow(Math.max(0.08, endEnv), 0.7);
        // Hand pressure swell along stroke
        const pr = 1 + pressure * (0.32 * Math.sin(u * 6.5 + ph) + 0.16 * Math.cos(u * 15 - ph));
        const halfW = (width * wScale * tp * pr) * 0.5;

        // Hand wobble normal to stroke
        const wobOffset = (Math.sin(u * 11 + ph * 1.7) * 0.65 + (r() - 0.5) * 0.75) * wobble * wobScale;
        const cx = p[0] + nx * wobOffset;
        const cy = p[1] + ny * wobOffset;

        L.push([cx + nx * halfW, cy + ny * halfW]);
        R.push([cx - nx * halfW, cy - ny * halfW]);
      }

      ctx.save();
      ctx.fillStyle = color;
      ctx.globalAlpha *= alpha * aScale;
      ctx.beginPath();
      L.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      for (let i = R.length - 1; i >= 0; i--) {
        ctx.lineTo(R[i][0], R[i][1]);
      }
      ctx.closePath();
      ctx.fill();

      // Optional ballpoint/fountain nib ink bead at stroke end
      if (inkBlob && passIdx === 0 && !closed && progress >= 0.98) {
        const last = slice[slice.length - 1];
        ctx.beginPath();
        ctx.arc(last[0], last[1], width * 0.68, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // Primary ink stroke
    drawPass(0, 1.0, 1.0, 1.0);
    // Second searching pencil/ink retrace stroke (gives the authentic @kickingkeys / anidoodle hand-drawn look)
    if (retrace) {
      drawPass(1, 0.55, 0.42, 1.55);
    }
  }

  // --- Core Hand-Drawn Mark 3: `scribbleFill` (Diagonal Crayon / Pencil Hatching across a Box or Circle) ---
  function scribbleHatchRect(ctx, x, y, w, h, opts = {}) {
    const {
      color = PAL.amber,
      alpha = 0.25,
      gap = 9,
      angle = -0.65,
      width = 1.6,
      seed = "hatch",
      cross = false
    } = opts;

    const r = rngFor(seed);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";

    const diag = Math.hypot(w, h);
    const cx = x + w / 2;
    const cy = y + h / 2;

    function pass(ang, aMul) {
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const nx = -sa, ny = ca;
      for (let d = -diag / 2; d <= diag / 2; d += gap) {
        const j = (r() - 0.5) * gap * 0.35;
        const px0 = cx + nx * (d + j) - ca * (diag / 2);
        const py0 = cy + ny * (d + j) - sa * (diag / 2);
        const px1 = cx + nx * (d + j) + ca * (diag / 2);
        const py1 = cy + ny * (d + j) + sa * (diag / 2);
        const midX = (px0 + px1) / 2 + (r() - 0.5) * 6;
        const midY = (py0 + py1) / 2 + (r() - 0.5) * 6;

        ctx.globalAlpha = alpha * aMul * (0.75 + r() * 0.4);
        ctx.beginPath();
        ctx.moveTo(px0, py0);
        ctx.quadraticCurveTo(midX, midY, px1, py1);
        ctx.stroke();
      }
    }

    pass(angle, 1.0);
    if (cross) {
      pass(angle + Math.PI * 0.48, 0.65);
    }
    ctx.restore();
  }

  function roundedRect(ctx, x, y, w, h, r = 12) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  // --- Hand-Sketched Notebook Card (Replaces Rigid Digital Panels) ---
  function drawArchivalCard(ctx, x, y, w, h, opts = {}) {
    const {
      fill = PAL.paperCard,
      stroke = PAL.ink,
      accent = PAL.amber,
      header = null,
      tape = true,
      seed = null
    } = opts;

    const cardSeed = seed || `card:${Math.round(x)}:${Math.round(y)}:${Math.round(w)}:${header || ""}`;
    const cardPts = sketchyRectPts(x, y, w, h, 1.5, cardSeed);

    ctx.save();

    // 1. Hand-hatched pencil shadow down-right
    scribbleHatchRect(ctx, x + 7, y + 7, w, h, {
      color: PAL.inkSoft,
      alpha: 0.18,
      gap: 7,
      angle: -0.7,
      width: 1.5,
      seed: cardSeed + ":sh"
    });

    // 2. Warm paper fill with subtle watercolor wash rim
    const actualFill = (fill.startsWith("rgba") || fill === "#121A2A" || fill === "#162032")
      ? PAL.paperCard
      : fill;
    wetWash(ctx, cardPts, actualFill, {
      alpha: 0.96,
      seed: cardSeed + ":wash",
      pool: 0.12,
      bleed: 2.2,
      rim: false,
      dx: 0,
      dy: 0
    });

    // 3. Header watercolor highlight strip (like a highlighter marker stroke across top of card)
    if (header) {
      const hdrPts = sketchyRectPts(x + 6, y + 6, w - 12, 38, 1.6, cardSeed + ":hdr");
      wetWash(ctx, hdrPts, accent, {
        alpha: 0.22,
        seed: cardSeed + ":hdrwash",
        pool: 0.35,
        bleed: 2.5,
        rim: true,
        dx: 1,
        dy: 1
      });

      // Hand-drawn pencil rule under header
      penStroke(ctx, [[x + 10, y + 44], [x + w / 2, y + 43.5], [x + w - 10, y + 44.5]], {
        width: 1.5,
        color: PAL.inkSoft,
        alpha: 0.45,
        wobble: 1.1,
        retrace: false,
        seed: cardSeed + ":rule"
      });

      ctx.font = "700 14px 'JetBrains Mono', 'Courier New', monospace";
      ctx.fillStyle = PAL.ink;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText("✎ " + header, x + 18, y + 25);
    }

    // 4. Double-retraced fountain pen outline around the notebook card
    const isHighlightStroke = stroke !== "rgba(243, 239, 230, 0.28)" && stroke !== "rgba(243, 239, 230, 0.22)" && stroke !== "rgba(243, 239, 230, 0.18)" && stroke !== "#D5CFC0";
    penStroke(ctx, cardPts, {
      closed: true,
      width: isHighlightStroke ? 2.8 : 2.1,
      color: isHighlightStroke ? stroke : PAL.ink,
      alpha: 0.88,
      wobble: 1.5,
      retrace: true,
      seed: cardSeed + ":outline"
    });

    // 5. Optional translucent masking tape strip at top corners
    if (tape && w > 280) {
      const r = rngFor(cardSeed + ":tape");
      const tapeX = x + w * (0.42 + r() * 0.16);
      const tapePts = sketchyRectPts(tapeX - 38, y - 9, 76, 18, 1.2, cardSeed + ":tp");
      wetWash(ctx, tapePts, "#EBDAB4", {
        alpha: 0.68,
        seed: cardSeed + ":tpw",
        pool: 0.1,
        bleed: 1.2,
        rim: true,
        dx: 0,
        dy: 0
      });
    }

    ctx.restore();
  }

  // --- Hand-Sketched Curved Axon with Ink Arrow / 1943 Inhibitory Loop & Painted Spark Pulse ---
  function evalQuad(p0, p1, p2, u) {
    const m = 1 - u;
    return {
      x: m * m * p0.x + 2 * m * u * p1.x + u * u * p2.x,
      y: m * m * p0.y + 2 * m * u * p1.y + u * u * p2.y
    };
  }

  function drawCurvedAxon(ctx, p0, p1, p2, opts = {}) {
    const {
      color = PAL.teal,
      width = 3.2,
      alpha = 0.9,
      pulseU = -1,
      pulseColor = PAL.amber,
      pulseRadius = 10,
      inhibitoryLoop = false,
      synapseArrow = true,
      progress = 1.0,
      boilTime = null
    } = opts;

    const strokeCol = color === PAL.gold ? PAL.amber : color === PAL.tealBright ? PAL.teal : color === PAL.crimsonBright ? PAL.crimson : color;
    const pts = [];
    for (let i = 0; i <= 12; i++) {
      const q = evalQuad(p0, p1, p2, i / 12);
      pts.push([q.x, q.y]);
    }

    ctx.save();
    ctx.globalAlpha *= alpha;

    // Soft watercolor highlighter halo under active axons
    if (pulseU >= 0 || width > 3.6) {
      penStroke(ctx, pts, {
        width: width * 2.6,
        color: strokeCol,
        alpha: 0.18,
        wobble: 1.8,
        retrace: false,
        progress,
        boilTime,
        seed: `axon-wash:${Math.round(p0.x)}:${Math.round(p0.y)}:${Math.round(p2.y)}`
      });
    }

    // Main hand-drawn ink axon line
    penStroke(ctx, pts, {
      width,
      color: strokeCol,
      alpha: 0.92,
      wobble: 1.35,
      retrace: true,
      progress,
      boilTime,
      seed: `axon:${Math.round(p0.x)}:${Math.round(p0.y)}:${Math.round(p2.y)}`
    });

    // Terminal marker (1943 authentic hand-drawn loop for inhibitory, sketched V-arrow for excitatory)
    if (progress > 0.9) {
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const ang = Math.atan2(dy, dx);

      if (inhibitoryLoop) {
        ctx.save();
        ctx.translate(p2.x, p2.y);
        ctx.rotate(ang);
        const loopPts = sketchyCirclePts(-9, 0, 10.5, 10.5, 14, 1.3, `inh-loop:${Math.round(p2.y)}`);
        wetWash(ctx, loopPts, PAL.paper, { alpha: 0.95, pool: 0, bleed: 1, rim: false, dx: 0, dy: 0 });
        penStroke(ctx, loopPts, {
          closed: true,
          width: width + 0.6,
          color: PAL.crimson,
          alpha: 0.95,
          wobble: 1.2,
          retrace: true,
          seed: `inh-loop-s:${Math.round(p2.y)}`
        });
        ctx.restore();
      } else if (synapseArrow) {
        ctx.save();
        ctx.translate(p2.x, p2.y);
        ctx.rotate(ang);
        penStroke(ctx, [[-13, -7.5], [2, 0], [-13, 7.5]], {
          width: width * 0.95,
          color: strokeCol,
          alpha: 0.95,
          wobble: 0.9,
          taper: 0.4,
          retrace: true,
          seed: `syn-arr:${Math.round(p2.x)}:${Math.round(p2.y)}`
        });
        ctx.restore();
      }
    }

    // Hand-painted doodle spark traveling along the axon
    if (pulseU >= 0 && pulseU <= 1) {
      const pt = evalQuad(p0, p1, p2, pulseU);
      // Watercolor wash dab + sketched 4-point star spark
      const blobPts = sketchyCirclePts(pt.x, pt.y, pulseRadius * 1.45, pulseRadius * 1.45, 12, 1.8, `pblob:${Math.floor(pulseU * 20)}`);
      wetWash(ctx, blobPts, PAL.gold, { alpha: 0.65, pool: 0.2, bleed: 2, rim: false, dx: 0, dy: 0 });

      // Hand-drawn 4-point star / spark doodle
      const sr = pulseRadius * 1.25;
      const star = [
        [pt.x, pt.y - sr], [pt.x + sr * 0.28, pt.y - sr * 0.28],
        [pt.x + sr, pt.y], [pt.x + sr * 0.28, pt.y + sr * 0.28],
        [pt.x, pt.y + sr], [pt.x - sr * 0.28, pt.y + sr * 0.28],
        [pt.x - sr, pt.y], [pt.x - sr * 0.28, pt.y - sr * 0.28]
      ];
      wetWash(ctx, star, "#FFFDF5", { alpha: 0.9, pool: 0, bleed: 0.5, rim: false, dx: 0, dy: 0 });
      penStroke(ctx, star, {
        closed: true,
        width: 1.8,
        color: PAL.amber,
        alpha: 0.95,
        wobble: 0.8,
        retrace: false,
        seed: `spark:${Math.floor(pulseU * 15)}`
      });
    }

    ctx.restore();
  }

  // --- Procedural Biological Neuron & Sketched 1943 M-P Character Node ---
  const BIO_NEURON_CACHE = new Map();
  function getBioBranches(seedKey, maxDepth = 4) {
    if (BIO_NEURON_CACHE.has(seedKey)) return BIO_NEURON_CACHE.get(seedKey);
    const rng = rngFor(seedKey);
    const branches = [];
    const numRoots = 7;
    for (let i = 0; i < numRoots; i++) {
      const baseAngle = (i / numRoots) * Math.PI * 2 + (rng() - 0.5) * 0.35;
      if (Math.abs(Math.cos(baseAngle)) > 0.88 && Math.cos(baseAngle) > 0) continue;

      function grow(x, y, ang, len, depth) {
        const nx = x + Math.cos(ang) * len;
        const ny = y + Math.sin(ang) * len;
        const ctrlX = (x + nx) / 2 + (rng() - 0.5) * len * 0.45;
        const ctrlY = (y + ny) / 2 + (rng() - 0.5) * len * 0.45;
        branches.push({ x0: x, y0: y, cx: ctrlX, cy: ctrlY, x1: nx, y1: ny, depth, maxDepth });
        if (depth < maxDepth) {
          for (let s = 0; s < 2; s++) {
            const subAng = ang + (s === 0 ? -1 : 1) * (0.28 + rng() * 0.32);
            grow(nx, ny, subAng, len * (0.68 + rng() * 0.14), depth + 1);
          }
        }
      }
      grow(0, 0, baseAngle, 42 + rng() * 18, 1);
    }
    BIO_NEURON_CACHE.set(seedKey, branches);
    return branches;
  }

  function drawMorphingNeuron(ctx, cx, cy, scale, t, opts = {}) {
    const {
      seedKey = "hero-neuron",
      morph = 0, // 0 = watercolor & ink biological cell, 1 = sketched 1943 M-P geometric node
      firing = 0,
      theta = 2,
      sumVal = null,
      vetoed = false,
      showLabel = true
    } = opts;

    const branches = getBioBranches(seedKey, 4);
    const bioAlpha = clamp(1 - morph * 1.15, 0, 1);
    const mpAlpha = clamp((morph - 0.15) / 0.85, 0, 1);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);

    // 1. Hand-drawn Botanical/Biological Dendrites (fountain pen + watercolor wash)
    if (bioAlpha > 0.01) {
      ctx.save();
      ctx.globalAlpha *= bioAlpha;
      const bOff = boilOffset(seedKey, t, 1.5, 10);
      for (let i = 0; i < branches.length; i++) {
        const b = branches[i];
        const branchFade = clamp(1 - morph * (0.6 + b.depth * 0.25), 0, 1);
        if (branchFade <= 0.01) continue;
        const drift = (1 - branchFade) * 28;
        const angOut = Math.atan2(b.y1, b.x1);
        const dx = Math.cos(angOut) * drift;
        const dy = Math.sin(angOut) * drift;

        penStroke(
          ctx,
          [
            [b.x0 + dx, b.y0 + dy],
            [b.cx + bOff.dx + dx, b.cy + bOff.dy + dy],
            [b.x1 + dx, b.y1 + dy]
          ],
          {
            width: Math.max(1.1, 4.8 - b.depth * 0.95),
            color: firing > 0.25 ? PAL.amber : PAL.teal,
            alpha: branchFade * (0.88 - b.depth * 0.1),
            wobble: 1.2,
            taper: 0.85,
            retrace: b.depth <= 2,
            seed: `${seedKey}:br:${i}`
          }
        );
      }
      ctx.restore();
    }

    // 2. Soma Body: Watercolor Wash + Crayon/Pencil Shading + Fountain Pen Contour
    const baseR = lerp(40, 62, easeInOutCubic(morph));

    // Outer watercolor splash halo when firing or vetoed
    if (firing > 0.05 && !vetoed) {
      const splashPts = sketchyCirclePts(0, 0, baseR * 1.48, baseR * 1.48, 16, 4.5, `${seedKey}:halo`);
      wetWash(ctx, splashPts, PAL.gold, { alpha: 0.35 * firing, pool: 0.3, bleed: 5, rim: true, dx: 0, dy: 0 });
      // Hand-drawn radiating action lines around firing cell
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + Math.floor(t * 8) * 0.15;
        const r0 = baseR * 1.18;
        const r1 = baseR * (1.35 + 0.22 * firing);
        penStroke(ctx, [[Math.cos(a) * r0, Math.sin(a) * r0], [Math.cos(a) * r1, Math.sin(a) * r1]], {
          width: 2.2,
          color: PAL.amber,
          alpha: 0.75 * firing,
          wobble: 0.8,
          retrace: false,
          seed: `${seedKey}:ray:${k}`
        });
      }
    } else if (vetoed) {
      const vPts = sketchyCirclePts(0, 0, baseR * 1.38, baseR * 1.38, 16, 4.0, `${seedKey}:vhalo`);
      wetWash(ctx, vPts, PAL.crimson, { alpha: 0.28, pool: 0.3, bleed: 4, rim: true, dx: 0, dy: 0 });
    }

    // Soma contour vertices
    const steps = 28;
    const somaPts = [];
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const organicWobble =
        (Math.sin(a * 3 + t * 2.2) * 5.5 +
          Math.cos(a * 5 - t * 1.7) * 3.5 +
          Math.sin(a * 7 + 1.1) * 2.0) *
        (1 - easeInOutCubic(morph));
      const r = baseR + organicWobble;
      somaPts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }

    // Paint watercolor wash inside soma
    const washColor = vetoed
      ? "#F2C6C2"
      : firing > 0.3
      ? "#FCE09B"
      : morph < 0.5
      ? "#C7E6DF"
      : "#F5EBD6";
    wetWash(ctx, somaPts, washColor, {
      alpha: 0.92,
      seed: `${seedKey}:somawash`,
      pool: 0.5,
      bleed: 2.8,
      rim: true,
      dx: 2,
      dy: 2
    });

    // Diagonal pencil hatching on the lower-right shade side of the soma
    ctx.save();
    ctx.beginPath();
    somaPts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.clip();
    scribbleHatchRect(ctx, -baseR, 0, baseR * 2, baseR, {
      color: vetoed ? PAL.crimson : firing > 0.3 ? PAL.amber : PAL.teal,
      alpha: 0.22,
      gap: 7,
      angle: -0.55,
      width: 1.5,
      seed: `${seedKey}:somahatch`
    });
    ctx.restore();

    // Double-retraced fountain pen outline of soma
    penStroke(ctx, somaPts, {
      closed: true,
      width: lerp(2.8, 3.6, morph),
      color: vetoed ? PAL.crimson : firing > 0.3 ? PAL.amber : PAL.ink,
      alpha: 0.95,
      wobble: 1.6,
      retrace: true,
      boilTime: t,
      seed: `${seedKey}:somaout`
    });

    // 3. Biological Nucleus Doodle (when morph < 0.7)
    if (bioAlpha > 0.05) {
      ctx.save();
      ctx.globalAlpha *= bioAlpha;
      const nucPts = sketchyCirclePts(0, 0, 13 + firing * 3, 12 + firing * 3, 14, 1.2, `${seedKey}:nuc`);
      wetWash(ctx, nucPts, firing > 0.3 ? PAL.gold : PAL.amber, { alpha: 0.85, pool: 0.4, bleed: 1.5, rim: false, dx: 1, dy: 1 });
      penStroke(ctx, nucPts, { closed: true, width: 2.0, color: PAL.ink, wobble: 1.0, retrace: true, seed: `${seedKey}:nucpen` });
      ctx.restore();
    }

    // 4. 1943 McCulloch-Pitts Sketched Internal Split (Σ Summation left | θ Threshold right)
    if (mpAlpha > 0.05 && showLabel) {
      ctx.save();
      ctx.globalAlpha *= mpAlpha;

      penStroke(ctx, [[0, -baseR * 0.76], [0.5, 0], [0, baseR * 0.76]], {
        width: 2.0,
        color: PAL.inkSoft,
        alpha: 0.65,
        wobble: 1.1,
        retrace: true,
        seed: `${seedKey}:div`
      });

      ctx.font = "800 21px 'JetBrains Mono', 'Courier New', monospace";
      ctx.fillStyle = vetoed ? PAL.crimson : PAL.amber;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(sumVal !== null ? `Σ=${sumVal}` : "Σ xᵢ", -baseR * 0.44, 0);

      ctx.fillStyle = PAL.ink;
      ctx.fillText(`θ=${theta}`, baseR * 0.44, 0);

      ctx.restore();
    }

    ctx.restore();
  }

  // --- Expressive Hand-Drawn Character Guide: "Professor Pitts' Sketchbook Companion" ---
  // Adds warm human/cartoon life (inspired by Clawd / anidoodle storybook characters) in a corner of the page
  function drawDoodleGuide(ctx, x, y, scale, t, mood = "curious", label = null) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);

    const bob = Math.sin(t * 3.8) * 3.5;
    const tilt = Math.sin(t * 1.9) * 0.05;
    ctx.translate(0, bob);
    ctx.rotate(tilt);

    // Little watercolor shadow under feet
    const shPts = sketchyCirclePts(0, 44, 28, 8, 12, 1.2, "guide-sh");
    wetWash(ctx, shPts, PAL.inkSoft, { alpha: 0.22, pool: 0, bleed: 1.5, rim: false, dx: 0, dy: 0 });

    // Little stubby legs
    penStroke(ctx, [[-12, 22], [-12, 42]], { width: 4.2, color: PAL.ink, wobble: 0.8, retrace: true, boilTime: t, seed: "g-legL" });
    penStroke(ctx, [[12, 22], [12, 42]], { width: 4.2, color: PAL.ink, wobble: 0.8, retrace: true, boilTime: t, seed: "g-legR" });

    // Body: cute hand-painted neuron-sprite with round glasses
    const bodyPts = sketchyCirclePts(0, 0, 30, 26, 18, 1.8, "guide-body");
    const bodyCol = mood === "excited" ? PAL.gold : mood === "shocked" ? "#F7B2AD" : "#B8E0D8";
    wetWash(ctx, bodyPts, bodyCol, { alpha: 0.92, pool: 0.45, bleed: 2.5, rim: true, dx: 2, dy: 2 });
    penStroke(ctx, bodyPts, { closed: true, width: 2.8, color: PAL.ink, wobble: 1.4, retrace: true, boilTime: t, seed: "g-body-out" });

    // 3 little antenna dendrites on top of head that wiggle on the beat
    for (let k = -1; k <= 1; k++) {
      const wag = Math.sin(t * 5 + k) * 4;
      penStroke(ctx, [[k * 10, -24], [k * 16 + wag, -40]], {
        width: 2.4,
        color: PAL.ink,
        wobble: 1.0,
        retrace: false,
        boilTime: t,
        seed: `g-ant:${k}`
      });
      const tip = sketchyCirclePts(k * 16 + wag, -42, 4, 4, 8, 0.5, `g-tip:${k}`);
      wetWash(ctx, tip, PAL.amber, { alpha: 0.9, pool: 0, bleed: 0.5, rim: false, dx: 0, dy: 0 });
    }

    // Round 1940s logician glasses
    for (const s of [-1, 1]) {
      const glPts = sketchyCirclePts(s * 11, -3, 8.5, 8.5, 12, 0.7, `g-gl:${s}`);
      wetWash(ctx, glPts, "#FFFFFF", { alpha: 0.75, pool: 0, bleed: 0.5, rim: false, dx: 0, dy: 0 });
      penStroke(ctx, glPts, { closed: true, width: 2.0, color: PAL.ink, wobble: 0.7, retrace: false, seed: `g-glp:${s}` });
      // Pupil
      ctx.fillStyle = PAL.ink;
      ctx.beginPath();
      ctx.arc(s * 11 + (mood === "curious" ? 1.5 : 0), -3, 2.8, 0, Math.PI * 2);
      ctx.fill();
    }
    // Glasses bridge
    penStroke(ctx, [[-2.5, -3], [2.5, -3]], { width: 2.0, color: PAL.ink, wobble: 0.3, retrace: false, seed: "g-br" });

    // Mouth / expression
    if (mood === "excited") {
      penStroke(ctx, [[-7, 9], [0, 15], [7, 9]], { width: 2.2, color: PAL.ink, wobble: 0.6, retrace: false, seed: "g-m1" });
    } else if (mood === "shocked") {
      const mPts = sketchyCirclePts(0, 11, 4.5, 5.5, 10, 0.5, "g-m2");
      penStroke(ctx, mPts, { closed: true, width: 2.0, color: PAL.crimson, wobble: 0.6, retrace: false, seed: "g-m2p" });
    } else {
      penStroke(ctx, [[-6, 10], [0, 12.5], [6, 9.5]], { width: 2.0, color: PAL.ink, wobble: 0.6, retrace: false, seed: "g-m3" });
    }

    // Emote doodle above head (!, ?, or lightbulb spark)
    if (label) {
      ctx.font = "800 16px 'JetBrains Mono', monospace";
      ctx.fillStyle = mood === "shocked" ? PAL.crimson : PAL.biroBlue;
      ctx.textAlign = "center";
      ctx.fillText(label, 0, -54);
    }

    ctx.restore();
  }

  // --- Top Sketchbook Margin Header & Hand-Lettered Subtitle Pill ---
  const ACT_TITLES = {
    1: "SKETCHBOOK PLATE I · 1943: THE BIOLOGICAL STORM & THE QUESTION",
    2: "SKETCHBOOK PLATE II · THE ALL-OR-NONE DOODLE ABSTRACTION",
    3: "SKETCHBOOK PLATE III · THREE RULES OF THE McCULLOCH-PITTS CELL",
    4: "SKETCHBOOK PLATE IV · BOOLEAN LOGIC GATES IN INK & WASH",
    5: "SKETCHBOOK PLATE V · THE FATAL FLAW & THE CORNERSTONE LEGACY"
  };

  function getActiveAct(t) {
    if (t < 21.0) return 1;
    if (t < 37.2) return 2;
    if (t < 70.8) return 3;
    if (t < 98.0) return 4;
    return 5;
  }

  function drawTopHUD(ctx, t, duration) {
    const act = getActiveAct(t);
    ctx.save();

    // Hand-drawn watercolor banner across the top notebook margin
    const topPts = sketchyRectPts(36, 26, W - 72, 46, 1.5, "top-hud-bar");
    wetWash(ctx, topPts, "#EFE5CE", { alpha: 0.9, pool: 0.25, bleed: 2, rim: false, dx: 0, dy: 0 });
    penStroke(ctx, [[36, 72], [W / 2, 71], [W - 36, 72.5]], {
      width: 2.0,
      color: PAL.ink,
      alpha: 0.75,
      wobble: 1.4,
      retrace: true,
      seed: "top-hud-line"
    });

    // Little painted orange tab
    const tabPts = sketchyRectPts(52, 36, 16, 26, 1.2, "top-tab");
    wetWash(ctx, tabPts, PAL.amber, { alpha: 0.9, pool: 0.3, bleed: 1, rim: true, dx: 0, dy: 0 });
    penStroke(ctx, tabPts, { closed: true, width: 1.8, color: PAL.ink, wobble: 0.8, retrace: false, seed: "top-tab-p" });

    ctx.font = "800 15px 'JetBrains Mono', 'Courier New', monospace";
    ctx.fillStyle = PAL.ink;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(ACT_TITLES[act], 80, 49);

    ctx.font = "700 14px 'JetBrains Mono', monospace";
    ctx.fillStyle = PAL.biroBlue;
    ctx.textAlign = "right";
    const mins = Math.floor(t / 60);
    const secs = (t % 60).toFixed(1).padStart(4, "0");
    ctx.fillText(`FIG. 1943 · McCULLOCH & PITTS  ·  T+${mins}:${secs}s`, W - 54, 49);

    // Hand-drawn pencil progress stroke along the bottom of the header
    const prog = clamp(t / duration, 0, 1);
    if (prog > 0.005) {
      penStroke(ctx, [[36, 72], [36 + (W - 72) * prog, 72]], {
        width: 3.6,
        color: PAL.amber,
        alpha: 0.9,
        wobble: 0.9,
        retrace: false,
        seed: "hud-prog"
      });
    }

    ctx.restore();
  }

  // Hand-drawn paper strip subtitle bar with active word highlighter wash
  function drawSubtitles(ctx, t, subtitles) {
    if (!subtitles) return;
    let activeCue = null;
    for (let i = 0; i < subtitles.length; i++) {
      const c = subtitles[i];
      if (t >= c.start - 0.05 && t <= c.end + 0.08) {
        activeCue = c;
        break;
      }
    }
    if (!activeCue) return;

    const env = windowEnv(t, activeCue.start - 0.05, activeCue.end + 0.08, 0.08, 0.10);
    if (env <= 0.01) return;

    ctx.save();
    ctx.globalAlpha = env;
    ctx.font = "700 24px 'Inter', 'Georgia', serif";
    ctx.textBaseline = "middle";

    const words = activeCue.words || [];
    const spaceW = ctx.measureText(" ").width;
    const wordWidths = words.map((w) => ctx.measureText(w.display || w.word).width);
    const totalW = wordWidths.reduce((a, b) => a + b, 0) + Math.max(0, words.length - 1) * spaceW;

    const padX = 30;
    const boxW = Math.max(320, totalW + padX * 2);
    const boxH = 54;
    const boxX = (W - boxW) / 2;
    const boxY = H - 88;

    // Sketched cream note-strip with ink border
    const subPts = sketchyRectPts(boxX, boxY, boxW, boxH, 1.8, `sub:${activeCue.start}`);
    wetWash(ctx, subPts, "#FFFDF7", { alpha: 0.95, pool: 0.15, bleed: 2, rim: false, dx: 2, dy: 2 });
    penStroke(ctx, subPts, {
      closed: true,
      width: 2.2,
      color: PAL.ink,
      alpha: 0.9,
      wobble: 1.2,
      retrace: true,
      seed: `sub-pen:${activeCue.start}`
    });

    let curX = (W - totalW) / 2;
    const centerY = boxY + boxH / 2 + 1;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const txt = w.display || w.word;
      const isSpoken = t >= w.start - 0.04 && t <= w.end + 0.08;
      const isPast = t > w.end + 0.08;

      if (isSpoken) {
        // Yellow/amber watercolor highlighter swipe behind the spoken word!
        const hlPts = sketchyRectPts(curX - 4, centerY - 16, wordWidths[i] + 8, 32, 1.2, `hl:${i}`);
        wetWash(ctx, hlPts, PAL.gold, { alpha: 0.55, pool: 0.2, bleed: 1.5, rim: false, dx: 0, dy: 0 });
        ctx.fillStyle = PAL.crimson;
      } else if (isPast) {
        ctx.fillStyle = PAL.ink;
      } else {
        ctx.fillStyle = PAL.inkSoft;
      }
      ctx.textAlign = "left";
      ctx.fillText(txt, curX, centerY);
      curX += wordWidths[i] + spaceW;
    }

    ctx.restore();
  }

  // Hand-painted Brush Wipe Transition across Scene Cuts (inspired by ClaudeAnimationBase brushWipe)
  function drawBrushWipe(ctx, progress) {
    if (progress <= 0 || progress >= 1) return;
    const cols = [PAL.amber, PAL.teal, PAL.paperWarm, PAL.gold, PAL.biroBlue];
    const nStrips = 5;
    const stripH = (H + 200) / nStrips;

    ctx.save();
    for (let i = 0; i < nStrips; i++) {
      const delay = [0, 0.12, 0.05, 0.16, 0.08][i];
      const p = progress < 0.5
        ? easeOutCubic(clamp((progress * 2 - delay) / (1 - delay), 0, 1))
        : easeInOutCubic(clamp(((progress - 0.5) * 2 - delay) / (1 - delay), 0, 1));
      const x0 = progress < 0.5 ? -150 : lerp(-150, W + 150, p);
      const x1 = progress < 0.5 ? lerp(-150, W + 150, p) : W + 150;
      if (x1 - x0 < 30) continue;

      const y0 = -60 + i * stripH;
      const pts = sketchyRectPts(x0, y0, x1 - x0, stripH + 25, 8.0, `wipe:${i}`);
      wetWash(ctx, pts, cols[i % cols.length], {
        alpha: 0.88,
        pool: 0.4,
        bleed: 6,
        rim: true,
        dx: 0,
        dy: 0,
        seed: `wipe-w:${i}`
      });
      penStroke(ctx, pts, {
        closed: true,
        width: 3.0,
        color: PAL.ink,
        alpha: 0.7,
        wobble: 3.0,
        retrace: true,
        seed: `wipe-p:${i}`
      });
    }
    ctx.restore();
  }

  window.ENG = {
    W,
    H,
    PAL,
    hashStr,
    rngFor,
    noise2D,
    fractalNoise,
    clamp,
    lerp,
    invLerp,
    remap,
    easeOutCubic,
    easeInCubic,
    easeInOutCubic,
    easeOutQuart,
    easeOutBack,
    smoothstep,
    spring,
    windowEnv,
    getStaticBackdrop,
    boilOffset,
    densify,
    smoothCurve,
    sketchyRectPts,
    sketchyCirclePts,
    wetWash,
    penStroke,
    scribbleHatchRect,
    roundedRect,
    drawArchivalCard,
    drawCurvedAxon,
    drawMorphingNeuron,
    drawDoodleGuide,
    lerpColor,
    drawTopHUD,
    drawSubtitles,
    drawBrushWipe,
    drawBurnedSubtitles(ctx, t, cues, { width = 1080, height = 1920, safeBottom = null } = {}) {
      if (!cues || !cues.length) return;
      const active = cues.find(c => t >= c.start - 0.05 && t <= c.end + 0.08);
      if (!active) return;

      const words = active.words || [];
      ctx.save();
      ctx.font = "700 32px 'Trebuchet MS', 'Arial', sans-serif";
      ctx.textBaseline = "middle";

      const spaceW = ctx.measureText(" ").width;
      const wordWidths = words.map(w => ctx.measureText(w.word).width);
      const totalW = wordWidths.reduce((a, b) => a + b, 0) + Math.max(0, words.length - 1) * spaceW;

      const padX = 28;
      const boxW = Math.min(width - 64, Math.max(280, totalW + padX * 2));
      const boxH = 58;
      const boxX = (width - boxW) / 2;
      const maxBottom = Number.isFinite(safeBottom) ? safeBottom : height - 48;
      const boxY = maxBottom - boxH - 12;

      // Soft pill backdrop
      ctx.fillStyle = "rgba(27, 23, 30, 0.88)";
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(boxX, boxY, boxW, boxH, 16) : ctx.rect(boxX, boxY, boxW, boxH);
      ctx.fill();

      let curX = (width - Math.min(totalW, boxW - padX * 2)) / 2;
      const centerY = boxY + boxH / 2;
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const isSpoken = t >= w.start && t <= w.end;
        ctx.fillStyle = isSpoken ? "#E8A838" : "#FFFFFF";
        ctx.textAlign = "left";
        ctx.fillText(w.word, curX, centerY);
        curX += wordWidths[i] + spaceW;
      }
      ctx.restore();
    }
  };
})();

// src/scenes/act1_2.js — Acts I & II (0.00s – 37.20s)
// Hand-drawn Sketchbook, Fountain Pen & Watercolor Wash Style
// Act I: The Biological Storm (86 Billion Neurons) & The 1943 Question (McCulloch & Pitts)
// Act II: The All-or-None Doodle Abstraction & Discrete Binary Clock (0 vs 1)

(function () {
  const {
    W, H, PAL, rngFor, clamp, lerp, invLerp,
    easeOutCubic, easeInOutCubic, easeOutBack,
    windowEnv, sketchyRectPts, sketchyCirclePts,
    wetWash, penStroke, scribbleHatchRect,
    drawArchivalCard, drawCurvedAxon, drawMorphingNeuron,
    drawDoodleGuide, lerpColor
  } = window.ENG;

  let STORM_NET = null;
  function getStormNet() {
    if (STORM_NET) return STORM_NET;
    const rng = rngFor("cortical-storm-sketch-1943");
    const nodes = [];
    for (let i = 0; i < 48; i++) {
      const layer = rng() < 0.35 ? 0 : rng() < 0.7 ? 1 : 2;
      nodes.push({
        x: 110 + rng() * (W - 220),
        y: 110 + rng() * (H - 360),
        r: layer === 0 ? 5 + rng() * 3 : layer === 1 ? 8 + rng() * 4 : 12 + rng() * 5,
        layer,
        phase: rng() * Math.PI * 2,
        freq: 0.7 + rng() * 1.4
      });
    }
    const edges = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        const dist = Math.hypot(dx, dy);
        if (dist > 85 && dist < 255 && rng() < 0.25) {
          edges.push({
            a: i,
            b: j,
            cx: (nodes[i].x + nodes[j].x) / 2 + (rng() - 0.5) * 60,
            cy: (nodes[i].y + nodes[j].y) / 2 + (rng() - 0.5) * 60,
            speed: 0.55 + rng() * 0.85,
            offset: rng() * 10
          });
        }
      }
    }
    STORM_NET = { nodes, edges };
    return STORM_NET;
  }

  function renderAct1_2(ctx, t) {
    // =========================================================================
    // SHOT 1.1 (0.00s – 8.20s): THE STORM OF 86 BILLION NEURONS (INK & WASH)
    // =========================================================================
    const env11 = windowEnv(t, 0.0, 8.3, 0.5, 0.65);
    if (env11 > 0.001) {
      ctx.save();
      ctx.globalAlpha = env11;
      const net = getStormNet();

      const camZoom = lerp(0.96, 1.04, clamp(t / 8.0, 0, 1));
      ctx.save();
      ctx.translate(W / 2, H * 0.43);
      ctx.scale(camZoom, camZoom);
      ctx.translate(-W / 2, -H * 0.43);

      // Soft botanical watercolor wash behind central neuron cluster
      const bgSplash = sketchyCirclePts(W * 0.5, H * 0.42, 260, 210, 18, 12, "storm-bg-splash");
      wetWash(ctx, bgSplash, "#D9EDE8", { alpha: 0.55, pool: 0.35, bleed: 8, rim: true, dx: 0, dy: 0 });

      const stormAct = smoothstep(1.8, 4.6, t);

      // Hand-drawn fountain-pen cortical axons & racing painted sparks
      for (let i = 0; i < net.edges.length; i++) {
        const e = net.edges[i];
        const na = net.nodes[e.a];
        const nb = net.nodes[e.b];
        const pulsePhase = (t * e.speed + e.offset) % 2.4;
        const pulseU = t > 1.2 && pulsePhase < 1.0 ? pulsePhase : -1;

        penStroke(ctx, [[na.x, na.y], [e.cx, e.cy], [nb.x, nb.y]], {
          width: na.layer === 2 ? 1.8 : 1.1,
          color: na.layer === 2 ? PAL.teal : PAL.inkSoft,
          alpha: na.layer === 2 ? 0.35 : 0.22,
          wobble: 1.1,
          retrace: false,
          seed: `storm-edge:${i}`
        });

        if (pulseU >= 0 && (i % 2 === 0 || stormAct > 0.4)) {
          const m = 1 - pulseU;
          const px = m * m * na.x + 2 * m * pulseU * e.cx + pulseU * pulseU * nb.x;
          const py = m * m * na.y + 2 * m * pulseU * e.cy + pulseU * pulseU * nb.y;
          const spPts = sketchyCirclePts(px, py, na.layer === 2 ? 6.5 : 4.5, na.layer === 2 ? 6.5 : 4.5, 8, 1.0, `sp:${i}`);
          wetWash(ctx, spPts, PAL.amber, { alpha: 0.85, pool: 0.2, bleed: 1.5, rim: false, dx: 0, dy: 0 });
        }
      }

      // Hand-painted watercolor & ink cortical cell bodies
      for (let i = 0; i < net.nodes.length; i++) {
        const n = net.nodes[i];
        const fire = Math.max(0, Math.sin(t * n.freq * 2.5 + n.phase));
        const isFiring = fire > 0.72 && t > 1.0;

        const cPts = sketchyCirclePts(n.x, n.y, n.r, n.r, 10, 1.2, `snode:${i}`);
        wetWash(ctx, cPts, isFiring ? PAL.gold : n.layer === 2 ? "#8FD1C8" : "#C5DED9", {
          alpha: n.layer === 0 ? 0.45 : 0.85,
          pool: 0.3,
          bleed: 1.5,
          rim: false,
          dx: 1,
          dy: 1
        });
        if (n.layer >= 1) {
          penStroke(ctx, cPts, {
            closed: true,
            width: isFiring ? 2.0 : 1.3,
            color: isFiring ? PAL.amber : PAL.inkSoft,
            alpha: n.layer === 2 ? 0.75 : 0.45,
            wobble: 0.9,
            retrace: false,
            seed: `snode-p:${i}`
          });
        }
      }

      // Central Hero Hand-Painted Biological Neuron
      const heroFire = t > 4.2 ? 0.5 + 0.45 * Math.sin((t - 4.2) * 6.0) : 0.2;
      drawMorphingNeuron(ctx, W * 0.5, H * 0.42, 1.48, t, {
        seedKey: "hero-cell-1943",
        morph: 0,
        firing: clamp(heroFire, 0, 1),
        showLabel: false
      });

      ctx.restore();

      // Top-left Sketched Note Card at t >= 2.2s ("86 billion neurons")
      if (t >= 2.2) {
        const cEnv = easeOutBack(invLerp(2.2, 2.8, t));
        ctx.save();
        ctx.translate(64, 96 + (1 - cEnv) * 20);
        ctx.globalAlpha = env11 * clamp(cEnv, 0, 1);
        drawArchivalCard(ctx, 0, 0, 455, 124, {
          header: "FIELD NOTE · HUMAN CORTEX SCALE",
          accent: PAL.amber
        });
        const countProg = easeOutCubic(invLerp(2.4, 3.8, t));
        const numB = (countProg * 86).toFixed(0);
        ctx.font = "800 38px 'JetBrains Mono', 'Courier New', monospace";
        ctx.fillStyle = PAL.crimson;
        ctx.fillText(`${numB},000,000,000`, 22, 78);
        ctx.font = "600 15px 'Georgia', serif";
        ctx.fillStyle = PAL.inkSoft;
        ctx.fillText("Living cells firing in an electro-chemical storm", 22, 106);
        ctx.restore();
      }

      // Doodle Guide Character in top-right observing the storm
      drawDoodleGuide(ctx, W - 135, 165, 1.05, t, t > 4.2 ? "excited" : "curious", t > 4.2 ? "⚡ STORM!" : "86B?!");

      // Bottom Sketched Paper Strip Oscilloscope at t >= 4.0s
      if (t >= 4.0) {
        const oEnv = easeOutCubic(invLerp(4.0, 4.7, t));
        ctx.save();
        ctx.globalAlpha = env11 * oEnv;
        const ox = 64, oy = H - 238, ow = W - 128, oh = 124;
        drawArchivalCard(ctx, ox, oy, ow, oh, {
          header: "INK RECORDING · CONTINUOUS ELECTRO-CHEMICAL POTENTIAL V(t) [mV]",
          accent: PAL.teal
        });

        const wavePts = [];
        for (let px = 0; px <= ow - 50; px += 8) {
          const u = px / (ow - 50);
          const phase = u * 18 - t * 5.5;
          const noise = Math.sin(phase * 2.3) * 6 + Math.cos(phase * 5.7) * 4 + Math.sin(phase * 11.3) * 2.5;
          const spikeWave = Math.pow(Math.max(0, Math.sin(phase * 0.9)), 14) * 42;
          wavePts.push([ox + 25 + px, oy + 92 + noise - spikeWave]);
        }
        penStroke(ctx, wavePts, {
          width: 2.6,
          color: PAL.crimson,
          alpha: 0.9,
          wobble: 0.8,
          retrace: true,
          seed: "storm-wave"
        });
        ctx.restore();
      }

      ctx.restore();
    }

    // =========================================================================
    // SHOT 1.2 (7.70s – 21.30s): 1943 — McCULLOCH & PITTS SKETCHBOOK PAGE
    // =========================================================================
    const env12 = windowEnv(t, 7.7, 21.3, 0.55, 0.55);
    if (env12 > 0.001) {
      ctx.save();
      ctx.globalAlpha = env12;

      const cellX = 470;
      const cellY = 465;
      const cellPulse = 0.25 + 0.35 * Math.max(0, Math.sin(t * 3.2));

      // Hand-drawn compass circle & tick marks around the specimen neuron
      const compassPts = sketchyCirclePts(cellX, cellY, 208, 208, 28, 2.2, "compass-ring");
      wetWash(ctx, compassPts, "#E6EFEA", { alpha: 0.55, pool: 0.2, bleed: 4, rim: true, dx: 0, dy: 0 });
      penStroke(ctx, compassPts, {
        closed: true,
        width: 1.6,
        color: PAL.biroBlue,
        alpha: 0.45,
        wobble: 1.5,
        retrace: true,
        seed: "compass-pen"
      });

      // Incoming axons to the biological cell
      for (let k = -1; k <= 1; k++) {
        const p0 = { x: 95, y: cellY + k * 110 };
        const p1 = { x: 245, y: cellY + k * 65 };
        const p2 = { x: cellX - 75, y: cellY + k * 32 };
        const pU = (t * 0.9 + (k + 1) * 0.33) % 1.4;
        drawCurvedAxon(ctx, p0, p1, p2, {
          color: PAL.teal,
          width: 2.8,
          pulseU: pU <= 1 ? pU : -1,
          pulseColor: PAL.amber,
          synapseArrow: false,
          boilTime: t
        });
      }

      // Outgoing axon
      drawCurvedAxon(
        ctx,
        { x: cellX + 45, y: cellY },
        { x: cellX + 145, y: cellY - 18 },
        { x: cellX + 255, y: cellY + 8 },
        {
          color: PAL.amber,
          width: 3.5,
          pulseU: (t * 0.9 + 0.5) % 1.4 <= 1 ? (t * 0.9 + 0.5) % 1.4 : -1,
          pulseColor: PAL.gold,
          boilTime: t
        }
      );

      drawMorphingNeuron(ctx, cellX, cellY, 1.35, t, {
        seedKey: "hero-cell-1943",
        morph: 0,
        firing: cellPulse,
        showLabel: false
      });

      // Hand-drawn anatomical callouts at t >= 15.0s ("beneath all that messy biology, what is a single neuron actually doing?")
      if (t >= 15.0) {
        const qEnv = easeOutCubic(invLerp(15.0, 15.8, t));
        ctx.save();
        ctx.globalAlpha = env12 * qEnv;

        const tags = [
          { lx: cellX - 185, ly: cellY - 158, tx: cellX - 55, ty: cellY - 55, label: "✎ DENDRITES (INPUTS?)" },
          { lx: cellX - 190, ly: cellY + 168, tx: cellX - 20, ty: cellY + 35, label: "✎ SOMA (THRESHOLD?)" },
          { lx: cellX + 95, ly: cellY - 148, tx: cellX + 155, ty: cellY - 12, label: "✎ AXON (0 OR 1?)" }
        ];
        ctx.font = "700 14px 'JetBrains Mono', monospace";
        tags.forEach((tg, idx) => {
          penStroke(ctx, [[tg.lx, tg.ly], [tg.tx, tg.ty]], {
            width: 1.8,
            color: PAL.crimson,
            alpha: 0.85,
            wobble: 1.0,
            retrace: false,
            seed: `callout:${idx}`
          });
          // Highlighter wash under label
          const lblPts = sketchyRectPts(tg.lx - 24, tg.ly - 26, 205, 24, 1.2, `lblw:${idx}`);
          wetWash(ctx, lblPts, PAL.gold, { alpha: 0.35, pool: 0.1, bleed: 1, rim: false, dx: 0, dy: 0 });
          ctx.fillStyle = PAL.ink;
          ctx.textAlign = "left";
          ctx.fillText(tg.label, tg.lx - 18, tg.ly - 11);
        });

        // Bottom-left Question Note Card
        drawArchivalCard(ctx, 85, 728, 765, 134, {
          header: "THE RADICAL 1943 QUESTION",
          accent: PAL.crimson
        });
        ctx.font = "italic 600 23px 'Georgia', serif";
        ctx.fillStyle = PAL.ink;
        ctx.fillText("“Beneath all that messy biology,", 112, 792);
        ctx.font = "bold 24px 'Georgia', serif";
        ctx.fillStyle = PAL.crimson;
        ctx.fillText("what is a single neuron actually doing?”", 112, 828);

        drawDoodleGuide(ctx, 785, 795, 0.85, t, "curious", "???");
        ctx.restore();
      }

      // Right Stage: 1943 Journal Clipping & Sketched Pioneer Portrait Cards (x = 910..1830)
      const rx = 910;
      const rw = 930;

      const p1Env = easeOutBack(invLerp(7.9, 8.7, t));
      ctx.save();
      ctx.globalAlpha = env12 * clamp(p1Env, 0, 1);
      ctx.translate(0, (1 - p1Env) * 24);
      drawArchivalCard(ctx, rx, 102, rw, 178, {
        fill: "#F7EFE0",
        stroke: PAL.ink,
        accent: PAL.amber
      });

      // Hand-painted red stamp for "1943"
      const stampPts = sketchyRectPts(rx + 26, 152, 118, 48, 1.8, "stamp-1943");
      wetWash(ctx, stampPts, PAL.crimson, { alpha: 0.88, pool: 0.3, bleed: 2, rim: true, dx: 1, dy: 1 });
      penStroke(ctx, stampPts, { closed: true, width: 2.2, color: PAL.ink, wobble: 1.2, retrace: true, seed: "st-p" });
      ctx.font = "800 27px 'JetBrains Mono', monospace";
      ctx.fillStyle = "#FFFDF7";
      ctx.textAlign = "center";
      ctx.fillText("1943", rx + 85, 183);

      ctx.textAlign = "left";
      ctx.font = "700 14px 'JetBrains Mono', monospace";
      ctx.fillStyle = PAL.biroBlue;
      ctx.fillText("BULLETIN OF MATHEMATICAL BIOPHYSICS · VOL. 5, PP. 115–133", rx + 162, 164);

      ctx.font = "bold italic 24px 'Georgia', serif";
      ctx.fillStyle = PAL.ink;
      ctx.fillText("“A Logical Calculus of the Ideas", rx + 162, 198);
      ctx.fillText("Immanent in Nervous Activity”", rx + 162, 228);

      ctx.font = "600 15px 'Georgia', serif";
      ctx.fillStyle = PAL.inkSoft;
      ctx.fillText("First mathematical paper modeling brain cells as binary logic gates", rx + 28, 260);
      ctx.restore();

      // Pioneer Card 1: Warren McCulloch (t >= 9.3s)
      if (t >= 9.3) {
        const mcEnv = easeOutBack(invLerp(9.3, 10.1, t));
        ctx.save();
        ctx.globalAlpha = env12 * clamp(mcEnv, 0, 1);
        ctx.translate((1 - mcEnv) * 35, 0);
        drawArchivalCard(ctx, rx, 308, rw, 238, {
          header: "PIONEER I · NEUROPHYSIOLOGY & CYBERNETICS",
          accent: PAL.teal
        });

        const ix = rx + 95, iy = 442;
        const emb1 = sketchyCirclePts(ix, iy, 56, 56, 18, 1.8, "mc-emb");
        wetWash(ctx, emb1, "#D6ECE6", { alpha: 0.85, pool: 0.35, bleed: 2.5, rim: true, dx: 1, dy: 1 });
        penStroke(ctx, emb1, { closed: true, width: 2.4, color: PAL.ink, wobble: 1.3, retrace: true, seed: "mc-emb-p" });
        drawMorphingNeuron(ctx, ix, iy, 0.62, t, {
          seedKey: "mcculloch-icon",
          morph: 0.1,
          firing: 0.6,
          showLabel: false
        });

        ctx.textAlign = "left";
        ctx.font = "bold 28px 'Georgia', serif";
        ctx.fillStyle = PAL.ink;
        ctx.fillText("Warren S. McCulloch", rx + 178, 386);

        ctx.font = "700 14px 'JetBrains Mono', monospace";
        ctx.fillStyle = PAL.teal;
        ctx.fillText("NEUROPHYSIOLOGIST & PSYCHIATRIST (UNIV. OF ILLINOIS)", rx + 178, 418);

        ctx.font = "400 18px 'Georgia', serif";
        ctx.fillStyle = PAL.inkSoft;
        ctx.fillText("• Investigated how neural circuits encode “ideas” and sensations", rx + 178, 458);
        ctx.fillText("• Brought empirical discoveries of synaptic delay & all-or-none spikes", rx + 178, 492);
        ctx.restore();
      }

      // Pioneer Card 2: Walter Pitts (t >= 11.5s)
      if (t >= 11.5) {
        const wpEnv = easeOutBack(invLerp(11.5, 12.3, t));
        ctx.save();
        ctx.globalAlpha = env12 * clamp(wpEnv, 0, 1);
        ctx.translate((1 - wpEnv) * 35, 0);
        drawArchivalCard(ctx, rx, 574, rw, 258, {
          header: "PIONEER II · FORMAL SYMBOLIC LOGIC",
          accent: PAL.amber
        });

        const ix = rx + 95, iy = 716;
        const emb2 = sketchyCirclePts(ix, iy, 58, 58, 18, 1.8, "wp-emb");
        wetWash(ctx, emb2, "#FCE3B8", { alpha: 0.88, pool: 0.35, bleed: 2.5, rim: true, dx: 1, dy: 1 });
        penStroke(ctx, emb2, { closed: true, width: 2.4, color: PAL.ink, wobble: 1.3, retrace: true, seed: "wp-emb-p" });

        ctx.font = "800 22px 'JetBrains Mono', monospace";
        ctx.fillStyle = PAL.crimson;
        ctx.textAlign = "center";
        ctx.fillText("⊢ P ∧ Q", ix, iy - 6);
        ctx.font = "700 15px 'JetBrains Mono', monospace";
        ctx.fillStyle = PAL.ink;
        ctx.fillText("N₁(t) → N₂", ix, iy + 20);

        ctx.textAlign = "left";
        ctx.font = "bold 28px 'Georgia', serif";
        ctx.fillStyle = PAL.ink;
        ctx.fillText("Walter Pitts", rx + 178, 650);

        ctx.font = "700 14px 'JetBrains Mono', monospace";
        ctx.fillStyle = PAL.amber;
        ctx.fillText("18-YEAR-OLD SELF-TAUGHT PRODIGY & LOGICIAN (CHICAGO)", rx + 178, 682);

        ctx.font = "400 18px 'Georgia', serif";
        ctx.fillStyle = PAL.inkSoft;
        ctx.fillText("• Mastered Russell & Whitehead's Principia Mathematica as a teenager", rx + 178, 722);
        ctx.fillText("• Translated firing chains into time-indexed propositional logic", rx + 178, 754);
        ctx.fillText("• Formalized:  Nᵢ(t+1)  ≡  S { Excitatory ≥ θ  ∧  ¬Inhibitory }", rx + 178, 788);
        ctx.restore();
      }

      ctx.restore();
    }

    // =========================================================================
    // SHOT 2.1 (20.90s – 31.10s): STRIPPING CHEMISTRY -> ALL-OR-NONE SKETCH MORPH
    // =========================================================================
    const env21 = windowEnv(t, 20.9, 31.1, 0.5, 0.5);
    if (env21 > 0.001) {
      ctx.save();
      ctx.globalAlpha = env21;

      const morphU = easeInOutCubic(invLerp(24.2, 27.8, t));
      const allOrNoneU = easeOutCubic(invLerp(28.0, 29.8, t));

      drawArchivalCard(ctx, 110, 92, W - 220, 92, {
        header: "ABSTRACTION STEP 1 · STRIPPING AWAY MESSY BIOCHEMISTRY INTO PURE GEOMETRY",
        accent: PAL.amber
      });
      ctx.font = "bold 24px 'Georgia', serif";
      ctx.fillStyle = PAL.ink;
      ctx.textAlign = "left";
      ctx.fillText(
        morphU < 0.45
          ? "Biological Cell: Tangled Dendrites, Chemical Vesicles & Graded Potentials"
          : "McCulloch-Pitts Doodle: A Clean All-or-None Threshold Node (Σ xᵢ vs θ)",
        134,
        158
      );

      const cx = W * 0.5;
      const cy = 425;

      // Left Input Axons
      const inLabels = ["x₁(t)", "x₂(t)", "x₃(t)"];
      for (let i = 0; i < 3; i++) {
        const k = i - 1;
        const startX = lerp(380, 320, morphU);
        const startY = cy + k * lerp(130, 105, morphU);
        const ctrlX = lerp(680, 620, morphU);
        const ctrlY = cy + k * lerp(45, 105, morphU);
        const endX = cx - lerp(65, 115, morphU);
        const endY = cy + k * lerp(28, 42, morphU);

        const pulseCycle = ((t - 21.0) * 0.85 + i * 0.25) % 1.5;
        drawCurvedAxon(
          ctx,
          { x: startX, y: startY },
          { x: ctrlX, y: ctrlY },
          { x: endX, y: endY },
          {
            color: lerpColor(PAL.teal, PAL.amber, morphU),
            width: lerp(2.6, 3.6, morphU),
            pulseU: pulseCycle <= 1.0 ? pulseCycle : -1,
            pulseColor: PAL.gold,
            synapseArrow: morphU > 0.35,
            boilTime: t
          }
        );

        if (morphU > 0.25) {
          ctx.save();
          ctx.globalAlpha = env21 * morphU;
          const bPts = sketchyRectPts(startX - 102, startY - 22, 88, 44, 1.5, `inb:${i}`);
          wetWash(ctx, bPts, "#FCE6B8", { alpha: 0.9, pool: 0.25, bleed: 1.5, rim: true, dx: 1, dy: 1 });
          penStroke(ctx, bPts, { closed: true, width: 2.2, color: PAL.ink, wobble: 1.1, retrace: true, seed: `inbp:${i}` });
          ctx.font = "800 18px 'JetBrains Mono', monospace";
          ctx.fillStyle = PAL.ink;
          ctx.textAlign = "center";
          ctx.fillText(inLabels[i], startX - 58, startY + 6);
          ctx.restore();
        }
      }

      // Right Output Axon
      const outStartX = cx + lerp(55, 115, morphU);
      const outEndX = lerp(1440, 1530, morphU);
      const outPulse = ((t - 21.3) * 0.85) % 1.5;
      drawCurvedAxon(
        ctx,
        { x: outStartX, y: cy },
        { x: (outStartX + outEndX) / 2, y: cy - lerp(28, 0, morphU) },
        { x: outEndX, y: cy },
        {
          color: PAL.amber,
          width: 4.0,
          pulseU: outPulse <= 1.0 ? outPulse : -1,
          pulseColor: PAL.gold,
          synapseArrow: true,
          boilTime: t
        }
      );

      if (morphU > 0.25) {
        ctx.save();
        ctx.globalAlpha = env21 * morphU;
        const oPts = sketchyRectPts(outEndX + 14, cy - 24, 182, 48, 1.6, "out-b21");
        wetWash(ctx, oPts, "#FCE09B", { alpha: 0.92, pool: 0.3, bleed: 2, rim: true, dx: 1, dy: 1 });
        penStroke(ctx, oPts, { closed: true, width: 2.2, color: PAL.ink, wobble: 1.2, retrace: true, seed: "out-b21p" });
        ctx.font = "800 17px 'JetBrains Mono', monospace";
        ctx.fillStyle = PAL.ink;
        ctx.textAlign = "center";
        ctx.fillText("y(t+1) ∈ {0,1}", outEndX + 105, cy + 6);
        ctx.restore();
      }

      // Sketched pencil shavings / chemical droplets peeling off during morph
      if (morphU > 0.02 && morphU < 0.98) {
        const rng = rngFor("peel-particles");
        ctx.save();
        for (let p = 0; p < 32; p++) {
          const ang = rng() * Math.PI * 2;
          const baseDist = 55 + rng() * 90;
          const dist = baseDist + morphU * (120 + rng() * 110);
          const px = cx + Math.cos(ang) * dist;
          const py = cy + Math.sin(ang) * dist;
          const pAlpha = Math.sin(morphU * Math.PI) * 0.8;
          ctx.globalAlpha = env21 * pAlpha;
          const dPts = sketchyCirclePts(px, py, 4 + rng() * 4, 4 + rng() * 4, 8, 1.0, `peel:${p}`);
          wetWash(ctx, dPts, p % 2 === 0 ? PAL.teal : PAL.amber, { alpha: 0.75, pool: 0, bleed: 1, rim: false, dx: 0, dy: 0 });
        }
        ctx.restore();
      }

      // Hero Morphing Neuron
      const isFiring = outPulse < 0.35 ? 1 - outPulse / 0.35 : 0.15;
      drawMorphingNeuron(ctx, cx, cy, 1.85, t, {
        seedKey: "hero-cell-1943",
        morph: morphU,
        firing: isFiring,
        theta: 2,
        sumVal: null,
        showLabel: true
      });

      // Bottom Comparison Card: Analog Wave vs. Hand-Drawn Square Step Wave
      const bx = 110, by = 660, bw = W - 220, bh = 242;
      drawArchivalCard(ctx, bx, by, bw, bh, {
        header: "THE ALL-OR-NONE LAW · ANALOG VOLTAGE  →  DISCRETE BINARY STEP WAVE",
        accent: allOrNoneU > 0.3 ? PAL.amber : PAL.teal
      });

      const yZero = by + 196;
      const yOne = by + 100;

      // Dashed pencil guides for STATE 1 and STATE 0
      penStroke(ctx, [[bx + 130, yOne], [bx + bw - 45, yOne]], {
        width: 1.2, color: PAL.inkSoft, alpha: 0.35, wobble: 0.8, retrace: false, seed: "g-one"
      });
      penStroke(ctx, [[bx + 130, yZero], [bx + bw - 45, yZero]], {
        width: 1.2, color: PAL.inkSoft, alpha: 0.35, wobble: 0.8, retrace: false, seed: "g-zero"
      });

      ctx.font = "800 15px 'JetBrains Mono', monospace";
      ctx.fillStyle = PAL.ink;
      ctx.textAlign = "right";
      ctx.fillText("STATE 1", bx + 116, yOne + 5);
      ctx.fillText("STATE 0", bx + 116, yZero + 5);

      const plotW = bw - 180;
      const wavePts = [];
      for (let px = 0; px <= plotW; px += 6) {
        const u = px / plotW;
        const cycle = u * 5.0 - (t - 21.0) * 0.45;
        const frac = ((cycle % 1) + 1) % 1;

        const analogVal =
          0.12 * Math.sin(u * 45 - t * 6) +
          0.08 * Math.cos(u * 95 + t * 4) +
          Math.pow(Math.max(0, Math.sin(frac * Math.PI)), 8) * 0.95;

        const binaryVal = frac > 0.32 && frac < 0.62 ? 1.0 : 0.0;
        const val = lerp(analogVal, binaryVal, allOrNoneU);
        wavePts.push([bx + 130 + px, lerp(yZero, yOne, val)]);
      }

      penStroke(ctx, wavePts, {
        width: 3.4,
        color: lerpColor(PAL.teal, PAL.crimson, allOrNoneU),
        alpha: 0.92,
        wobble: 1.1,
        retrace: true,
        seed: "aon-wave"
      });

      if (allOrNoneU > 0.05) {
        ctx.save();
        ctx.globalAlpha = env21 * allOrNoneU;
        const aonPts = sketchyRectPts(bx + bw - 365, by + 56, 325, 42, 1.5, "aon-badge");
        wetWash(ctx, aonPts, PAL.gold, { alpha: 0.92, pool: 0.3, bleed: 2, rim: true, dx: 1, dy: 1 });
        penStroke(ctx, aonPts, { closed: true, width: 2.2, color: PAL.ink, wobble: 1.0, retrace: true, seed: "aon-bp" });
        ctx.font = "800 17px 'JetBrains Mono', monospace";
        ctx.fillStyle = PAL.ink;
        ctx.textAlign = "center";
        ctx.fillText("ALL-OR-NONE:  y ∈ { 0, 1 }", bx + bw - 202, by + 82);
        ctx.restore();
      }

      ctx.restore();
    }

    // =========================================================================
    // SHOT 2.2 (30.70s – 37.50s): DISCRETE TIME CLOCK & BINARY STATES (0 vs 1)
    // =========================================================================
    const env22 = windowEnv(t, 30.7, 37.5, 0.45, 0.5);
    if (env22 > 0.001) {
      ctx.save();
      ctx.globalAlpha = env22;

      const tx = 100, ty = 94, tw = W - 200, th = 148;
      drawArchivalCard(ctx, tx, ty, tw, th, {
        header: "DISCRETE SYNAPTIC CLOCK · t = 1, 2, 3, 4 … (1 TICK = 1 SYNAPTIC DELAY)",
        accent: PAL.teal
      });

      const tickRate = 1.6;
      const tickFloat = (t - 31.0) * tickRate;
      const activeTick = Math.floor(tickFloat);

      const nSlots = 8;
      const slotW = (tw - 100) / nSlots;
      for (let s = 0; s < nSlots; s++) {
        const sx = tx + 50 + s * slotW;
        const sy = ty + 62;
        const isCur = s === ((activeTick % nSlots) + nSlots) % nSlots;

        const slPts = sketchyRectPts(sx + 8, sy, slotW - 16, 62, 1.5, `slot:${s}`);
        wetWash(ctx, slPts, isCur ? PAL.gold : "#F2EAD9", {
          alpha: isCur ? 0.88 : 0.65,
          pool: 0.25,
          bleed: 1.5,
          rim: isCur,
          dx: 1,
          dy: 1
        });
        penStroke(ctx, slPts, {
          closed: true,
          width: isCur ? 2.6 : 1.5,
          color: isCur ? PAL.crimson : PAL.inkSoft,
          wobble: 1.1,
          retrace: isCur,
          seed: `slot-p:${s}`
        });

        ctx.font = "800 19px 'JetBrains Mono', monospace";
        ctx.fillStyle = isCur ? PAL.ink : PAL.inkSoft;
        ctx.textAlign = "center";
        ctx.fillText(`t = ${s + 1}`, sx + slotW / 2, sy + 37);
      }

      // Left Panel: STATE 0 (SILENT)
      const silentHighlight = smoothstep(32.6, 33.4, t);
      const lx = 100, ly = 272, pw = 820, ph = 630;
      drawArchivalCard(ctx, lx, ly, pw, ph, {
        header: "BINARY STATE 0 · QUIESCENT / SILENT CELL",
        accent: silentHighlight > 0.5 ? PAL.teal : PAL.steel,
        stroke: silentHighlight > 0.5 ? PAL.teal : PAL.ink
      });

      const lcx = lx + pw * 0.46, lcy = ly + 245;
      for (let k = -1; k <= 1; k += 2) {
        drawCurvedAxon(
          ctx,
          { x: lx + 70, y: lcy + k * 70 },
          { x: lx + 180, y: lcy + k * 50 },
          { x: lcx - 95, y: lcy + k * 28 },
          { color: PAL.steel, width: 2.8, pulseU: -1, boilTime: t }
        );
      }
      drawCurvedAxon(
        ctx,
        { x: lcx + 95, y: lcy },
        { x: lcx + 190, y: lcy },
        { x: lx + pw - 90, y: lcy },
        { color: PAL.steel, width: 3.2, pulseU: -1, boilTime: t }
      );
      drawMorphingNeuron(ctx, lcx, lcy, 1.45, t, {
        seedKey: "silent-node",
        morph: 1,
        firing: 0,
        theta: 2,
        sumVal: 0
      });

      if (t >= 33.2) {
        const zEnv = easeOutBack(invLerp(33.2, 34.0, t));
        ctx.save();
        ctx.globalAlpha = env22 * clamp(zEnv, 0, 1);
        const zPts = sketchyRectPts(lx + 55, ly + 425, pw - 110, 155, 2.0, "zero-card");
        wetWash(ctx, zPts, "#DCEEEB", { alpha: 0.92, pool: 0.3, bleed: 2.5, rim: true, dx: 2, dy: 2 });
        penStroke(ctx, zPts, { closed: true, width: 2.6, color: PAL.teal, wobble: 1.4, retrace: true, seed: "zero-cp" });

        ctx.font = "800 84px 'JetBrains Mono', monospace";
        ctx.fillStyle = PAL.teal;
        ctx.textAlign = "left";
        ctx.fillText("0", lx + 98, ly + 530);

        ctx.font = "bold 24px 'Georgia', serif";
        ctx.fillStyle = PAL.ink;
        ctx.fillText("SILENT  ·  Nᵢ(t) = 0", lx + 198, ly + 488);
        ctx.font = "400 18px 'Georgia', serif";
        ctx.fillStyle = PAL.inkSoft;
        ctx.fillText("Excitation below threshold: the cell stays quiet", lx + 198, ly + 528);
        ctx.restore();
      }

      // Right Panel: STATE 1 (FIRING)
      const fireHighlight = smoothstep(35.4, 36.0, t);
      const rx = 1000, ry = 272;
      drawArchivalCard(ctx, rx, ry, pw, ph, {
        header: "BINARY STATE 1 · ACTIVE / FIRING IMPULSE",
        accent: fireHighlight > 0.2 ? PAL.amber : PAL.steel,
        stroke: fireHighlight > 0.2 ? PAL.amber : PAL.ink
      });

      const rcx = rx + pw * 0.44, rcy = ry + 245;
      const inPulseU = fireHighlight > 0.05 ? ((t - 35.4) * 1.4) % 1.0 : -1;
      for (let k = -1; k <= 1; k += 2) {
        drawCurvedAxon(
          ctx,
          { x: rx + 70, y: rcy + k * 70 },
          { x: rx + 180, y: rcy + k * 50 },
          { x: rcx - 95, y: rcy + k * 28 },
          {
            color: fireHighlight > 0.2 ? PAL.amber : PAL.steel,
            width: 3.5,
            pulseU: inPulseU,
            pulseColor: PAL.gold,
            boilTime: t
          }
        );
      }
      const outPulseU = fireHighlight > 0.1 ? clamp(((t - 35.75) * 1.3) % 1.1, 0, 1) : -1;
      drawCurvedAxon(
        ctx,
        { x: rcx + 95, y: rcy },
        { x: rcx + 195, y: rcy },
        { x: rx + pw - 75, y: rcy },
        {
          color: fireHighlight > 0.2 ? PAL.amber : PAL.steel,
          width: 4.4,
          pulseU: outPulseU,
          pulseColor: PAL.gold,
          pulseRadius: 11,
          boilTime: t
        }
      );

      drawMorphingNeuron(ctx, rcx, rcy, 1.45, t, {
        seedKey: "firing-node",
        morph: 1,
        firing: fireHighlight,
        theta: 2,
        sumVal: fireHighlight > 0.2 ? 2 : 0
      });

      if (t >= 35.5) {
        const oEnv = easeOutBack(invLerp(35.5, 36.2, t));
        ctx.save();
        ctx.globalAlpha = env22 * clamp(oEnv, 0, 1);
        const oPts = sketchyRectPts(rx + 55, ry + 425, pw - 110, 155, 2.0, "one-card");
        wetWash(ctx, oPts, "#FCE2A6", { alpha: 0.94, pool: 0.35, bleed: 2.5, rim: true, dx: 2, dy: 2 });
        penStroke(ctx, oPts, { closed: true, width: 2.6, color: PAL.crimson, wobble: 1.4, retrace: true, seed: "one-cp" });

        ctx.font = "800 84px 'JetBrains Mono', monospace";
        ctx.fillStyle = PAL.crimson;
        ctx.textAlign = "left";
        ctx.fillText("1", rx + 98, ry + 530);

        ctx.font = "bold 24px 'Georgia', serif";
        ctx.fillStyle = PAL.ink;
        ctx.fillText("FIRING PULSE  ·  Nᵢ(t) = 1", rx + 198, ry + 488);
        ctx.font = "600 18px 'Georgia', serif";
        ctx.fillStyle = PAL.crimson;
        ctx.fillText("Threshold reached: asserts logical truth (1) down the axon!", rx + 198, ry + 528);
        ctx.restore();
      }

      ctx.restore();
    }
  }

  function smoothstep(a, b, t) {
    const x = clamp((t - a) / (b - a || 1e-9), 0, 1);
    return x * x * (3 - 2 * x);
  }

  window.ACT1_2 = { renderAct1_2 };
})();

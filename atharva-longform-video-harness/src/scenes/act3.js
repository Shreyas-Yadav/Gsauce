// src/scenes/act3.js — Act III: The Three Strict Rules (37.20s – 70.80s)
// Hand-drawn Sketchbook, Fountain Pen & Watercolor Wash Style
// Rule 1: Excitatory Summation (37.2s - 48.2s)
// Rule 2: Fixed Threshold θ & Next-Step Firing (48.2s - 56.4s)
// Rule 3: Inhibitory Loop Veto (56.4s - 70.8s)

(function () {
  const {
    W, H, PAL, clamp, lerp, invLerp,
    easeOutCubic, easeInOutCubic, easeOutBack,
    windowEnv, sketchyRectPts, sketchyCirclePts,
    wetWash, penStroke, scribbleHatchRect,
    drawArchivalCard, drawCurvedAxon, drawMorphingNeuron,
    drawDoodleGuide, lerpColor
  } = window.ENG;

  function renderAct3(ctx, t) {
    const env3 = windowEnv(t, 37.1, 71.1, 0.5, 0.55);
    if (env3 <= 0.001) return;

    ctx.save();
    ctx.globalAlpha = env3;

    const ruleIdx = t < 48.2 ? 1 : t < 56.4 ? 2 : 3;

    // -------------------------------------------------------------------------
    // 1. TOP SKETCHED RULE LEDGER TABS (Rule I, Rule II, Rule III)
    // -------------------------------------------------------------------------
    const tabs = [
      { id: 1, title: "RULE I · EXCITATORY SUMMATION", formula: "g(x) = Σ xᵢ", color: PAL.amber, wash: "#FCE5B8", appear: 39.2 },
      { id: 2, title: "RULE II · FIXED THRESHOLD (θ)", formula: "Fire if  g(x) ≥ θ", color: PAL.teal, wash: "#D5EDE8", appear: 48.2 },
      { id: 3, title: "RULE III · INHIBITORY VETO (○)", formula: "If any zⱼ = 1  ⇒  y = 0", color: PAL.crimson, wash: "#F7CBC7", appear: 56.4 }
    ];

    const tabW = 540;
    const tabGap = 30;
    const startX = (W - (tabW * 3 + tabGap * 2)) / 2;

    for (let i = 0; i < tabs.length; i++) {
      const tb = tabs[i];
      const tx = startX + i * (tabW + tabGap);
      const ty = 90;
      const isCurrent = ruleIdx === tb.id;
      const isUnlocked = t >= tb.appear;

      ctx.save();
      const tPts = sketchyRectPts(tx, ty, tabW, 92, 1.8, `rtab:${i}`);
      wetWash(ctx, tPts, isCurrent ? tb.wash : isUnlocked ? "#FBF6E9" : "#EFE8D8", {
        alpha: isCurrent ? 0.95 : 0.78,
        pool: 0.25,
        bleed: 2,
        rim: isCurrent,
        dx: 1,
        dy: 1
      });
      penStroke(ctx, tPts, {
        closed: true,
        width: isCurrent ? 2.8 : 1.7,
        color: isCurrent ? tb.color : PAL.inkSoft,
        alpha: isUnlocked ? 0.92 : 0.45,
        wobble: 1.4,
        retrace: isCurrent,
        seed: `rtab-p:${i}`
      });

      // Left painted ribbon bar
      const barPts = sketchyRectPts(tx + 12, ty + 14, 10, 64, 1.0, `rbar:${i}`);
      wetWash(ctx, barPts, isUnlocked ? tb.color : PAL.steel, { alpha: 0.85, pool: 0, bleed: 1, rim: false, dx: 0, dy: 0 });

      ctx.font = "800 15px 'JetBrains Mono', monospace";
      ctx.fillStyle = isCurrent ? tb.color : isUnlocked ? PAL.ink : PAL.steel;
      ctx.textAlign = "left";
      ctx.fillText(tb.title, tx + 34, ty + 35);

      ctx.font = "800 22px 'JetBrains Mono', monospace";
      ctx.fillStyle = isUnlocked ? PAL.ink : "rgba(90, 83, 96, 0.4)";
      ctx.fillText(isUnlocked ? tb.formula : "✎ AWAITING RULE...", tx + 34, ty + 68);
      ctx.restore();
    }

    // -------------------------------------------------------------------------
    // 2. MAIN INTERACTIVE McCULLOCH-PITTS SKETCHBOOK WORKBENCH (y = 206 .. 905)
    // -------------------------------------------------------------------------
    const wx = 86, wy = 206, ww = 1144, wh = 696;
    drawArchivalCard(ctx, wx, wy, ww, wh, {
      header:
        ruleIdx === 1
          ? "FIG. 3A · SPATIAL SUMMATION OF EXCITATORY AFFERENTS (+1 EACH)"
          : ruleIdx === 2
          ? "FIG. 3B · ALL-OR-NONE THRESHOLD WATERLINE (θ = 2) AT THE SOMA"
          : "FIG. 3C · 1943 APICAL INHIBITORY LOOP (○) & ABSOLUTE VETO",
      accent: ruleIdx === 3 ? PAL.crimson : ruleIdx === 2 ? PAL.teal : PAL.amber
    });

    const somaX = wx + 615;
    const somaY = wy + 345;
    const somaR = 128;

    let x1 = 0, x2 = 0, x3 = 0, z1 = 0;
    let p1U = -1, p2U = -1, p3U = -1, pzU = -1, outU = -1;
    let currentSum = 0;
    const theta = 2;
    let isFiring = 0;
    let isVetoed = false;

    if (t < 48.2) {
      if (t >= 43.6) {
        x1 = 1;
        p1U = clamp((t - 43.6) / 1.3, 0, 1);
      }
      if (t >= 44.3) {
        x2 = 1;
        p2U = clamp((t - 44.3) / 1.3, 0, 1);
      }
      if (t >= 44.8 && p1U >= 0.95) currentSum = 1;
      if (t >= 45.5 && p2U >= 0.95) currentSum = 2;
    } else if (t < 56.4) {
      x1 = 1;
      x2 = 1;
      if (t < 51.5) {
        currentSum = 1;
      } else {
        p1U = clamp((t - 51.5) / 1.0, 0, 1);
        p2U = clamp((t - 51.65) / 1.0, 0, 1);
        currentSum = t >= 52.4 ? 2 : 1;
      }
      if (t >= 54.1) {
        isFiring = easeOutCubic(invLerp(54.1, 54.5, t));
        outU = clamp((t - 54.2) / 1.1, 0, 1);
      }
    } else {
      if (t >= 63.5) {
        x1 = 1;
        x2 = 1;
        x3 = t >= 68.0 ? 1 : 0;
        z1 = 1;
        p1U = ((t - 63.5) * 1.1) % 1.0;
        p2U = ((t - 63.65) * 1.1) % 1.0;
        if (x3) p3U = ((t - 68.0) * 1.2) % 1.0;
        pzU = clamp((t - 63.8) / 1.1, 0, 1);
        currentSum = x1 + x2 + x3;
        if (t >= 64.7) {
          isVetoed = true;
        }
      } else {
        x1 = 1;
        x2 = 1;
        currentSum = 2;
      }
    }

    // Draw Excitatory Input Channels (x₁, x₂, x₃)
    const exInputs = [
      { label: "x₁(t)", val: x1, pU: p1U, yOff: -145 },
      { label: "x₂(t)", val: x2, pU: p2U, yOff: 0 },
      { label: "x₃(t)", val: x3, pU: p3U, yOff: 145 }
    ];

    for (let i = 0; i < exInputs.length; i++) {
      const inp = exInputs[i];
      const inX = wx + 135;
      const inY = somaY + inp.yOff;
      const termX = somaX - Math.cos((i - 1) * 0.42) * (somaR + 6);
      const termY = somaY + Math.sin((i - 1) * 0.42) * (somaR + 6);

      drawCurvedAxon(
        ctx,
        { x: inX + 75, y: inY },
        { x: (inX + termX) / 2, y: inY },
        { x: termX, y: termY },
        {
          color: inp.val ? PAL.amber : PAL.steel,
          width: inp.val ? 4.0 : 2.4,
          pulseU: inp.pU,
          pulseColor: PAL.gold,
          synapseArrow: true,
          boilTime: t
        }
      );

      // Sketched Input Tag
      const ibPts = sketchyRectPts(inX - 55, inY - 26, 132, 52, 1.6, `ex-in:${i}`);
      wetWash(ctx, ibPts, inp.val ? "#FCE2A6" : "#EFE8D8", {
        alpha: 0.92,
        pool: 0.25,
        bleed: 1.5,
        rim: !!inp.val,
        dx: 1,
        dy: 1
      });
      penStroke(ctx, ibPts, {
        closed: true,
        width: inp.val ? 2.5 : 1.7,
        color: inp.val ? PAL.amber : PAL.inkSoft,
        wobble: 1.2,
        retrace: !!inp.val,
        seed: `ex-inp:${i}`
      });

      ctx.font = "800 20px 'JetBrains Mono', monospace";
      ctx.fillStyle = inp.val ? PAL.ink : PAL.inkSoft;
      ctx.textAlign = "center";
      ctx.fillText(`${inp.label} = ${inp.val}`, inX + 11, inY + 7);

      if (inp.val) {
        ctx.font = "700 13px 'JetBrains Mono', monospace";
        ctx.fillStyle = PAL.crimson;
        ctx.fillText("+1 EXCITATORY", (inX + termX) / 2 + 8, inY - 14);
      }
    }

    // Draw Inhibitory Input Channel (z₁) with 1943 Apical Loop (appears in Rule 3 at t >= 57.0s)
    if (t >= 57.0) {
      const inhEnv = easeOutCubic(invLerp(57.0, 58.2, t));
      const loopDrawEnv = easeOutBack(invLerp(60.8, 62.2, t));
      ctx.save();
      ctx.globalAlpha = env3 * inhEnv;

      const zx = wx + 280;
      const zy = wy + wh - 76;
      const loopX = somaX;
      const loopY = somaY - somaR - 14;

      // Sample Bezier curve for hand-drawn inhibitory axon
      const p0 = { x: zx + 92, y: zy };
      const p1 = { x: zx + 210, y: zy };
      const p2 = { x: somaX - 180, y: somaY - 230 };
      const p3 = { x: loopX - 18, y: loopY };
      const bezPts = [];
      for (let k = 0; k <= 16; k++) {
        const u = k / 16, m = 1 - u;
        bezPts.push([
          m*m*m*p0.x + 3*m*m*u*p1.x + 3*m*u*u*p2.x + u*u*u*p3.x,
          m*m*m*p0.y + 3*m*m*u*p1.y + 3*m*u*u*p2.y + u*u*u*p3.y
        ]);
      }

      penStroke(ctx, bezPts, {
        width: z1 ? 4.2 : 3.0,
        color: PAL.crimson,
        alpha: 0.92,
        wobble: 1.5,
        retrace: true,
        boilTime: t,
        seed: "inh-axon-curve"
      });

      // Animated 1943 Apical Loop (○) around top of soma
      if (loopDrawEnv > 0.01) {
        ctx.save();
        ctx.translate(loopX, loopY + 8);
        ctx.scale(loopDrawEnv, loopDrawEnv);
        const lpPts = sketchyCirclePts(0, 0, 21, 21, 16, 1.5, "apical-loop");
        wetWash(ctx, lpPts, z1 ? "#F7B2AD" : PAL.paperCard, { alpha: 0.9, pool: 0.3, bleed: 2, rim: true, dx: 0, dy: 0 });
        penStroke(ctx, lpPts, { closed: true, width: 3.8, color: PAL.crimson, wobble: 1.3, retrace: true, seed: "apical-lp" });

        ctx.font = "800 14px 'JetBrains Mono', monospace";
        ctx.fillStyle = PAL.crimson;
        ctx.textAlign = "center";
        ctx.fillText("✎ 1943 INHIBITORY LOOP (○)", 0, -32);
        ctx.restore();
      }

      if (pzU >= 0 && pzU <= 1) {
        const u = pzU, m = 1 - u;
        const px = m*m*m*p0.x + 3*m*m*u*p1.x + 3*m*u*u*p2.x + u*u*u*p3.x;
        const py = m*m*m*p0.y + 3*m*m*u*p1.y + 3*m*u*u*p2.y + u*u*u*p3.y;
        const pPts = sketchyCirclePts(px, py, 12, 12, 10, 1.4, "inh-pulse");
        wetWash(ctx, pPts, PAL.crimson, { alpha: 0.85, pool: 0.2, bleed: 1.5, rim: true, dx: 0, dy: 0 });
      }

      const zbPts = sketchyRectPts(zx - 92, zy - 26, 184, 52, 1.6, "inh-badge");
      wetWash(ctx, zbPts, z1 ? "#F7B2AD" : "#F5EFE0", { alpha: 0.94, pool: 0.25, bleed: 2, rim: true, dx: 1, dy: 1 });
      penStroke(ctx, zbPts, { closed: true, width: 2.5, color: PAL.crimson, wobble: 1.2, retrace: true, seed: "inh-bp" });

      ctx.font = "800 19px 'JetBrains Mono', monospace";
      ctx.fillStyle = PAL.crimson;
      ctx.textAlign = "center";
      ctx.fillText(`INHIBIT z₁ = ${z1}`, zx, zy + 7);
      ctx.restore();
    }

    // -------------------------------------------------------------------------
    // 3. LARGE CENTRAL SOMA WATERCOLOR GAUGE (Shows Σ xᵢ filling up toward θ = 2)
    // -------------------------------------------------------------------------
    ctx.save();
    ctx.translate(somaX, somaY);

    const somaPts = sketchyCirclePts(0, 0, somaR, somaR, 28, 2.4, "act3-soma");

    // Outer firing / vetoed watercolor splash
    if (isFiring > 0.05 && !isVetoed) {
      const spPts = sketchyCirclePts(0, 0, somaR * 1.32, somaR * 1.32, 20, 4.5, "act3-fire-sp");
      wetWash(ctx, spPts, PAL.gold, { alpha: 0.42 * isFiring, pool: 0.3, bleed: 5, rim: true, dx: 0, dy: 0 });
    } else if (isVetoed) {
      const vpPts = sketchyCirclePts(0, 0, somaR * 1.28, somaR * 1.28, 20, 4.0, "act3-veto-sp");
      wetWash(ctx, vpPts, PAL.crimson, { alpha: 0.28, pool: 0.3, bleed: 4, rim: true, dx: 0, dy: 0 });
    }

    // Soma base paper wash
    wetWash(ctx, somaPts, isVetoed ? "#F9DFDD" : "#FFFDF7", {
      alpha: 0.96, pool: 0.15, bleed: 2, rim: false, dx: 0, dy: 0
    });

    // Clip inside soma to draw rising watercolor & crayon hatch fill
    ctx.save();
    ctx.beginPath();
    somaPts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.clip();

    const targetFillRatio = clamp(currentSum / 3.0, 0, 1);
    const fillH = somaR * 2 * targetFillRatio;
    const fillY = somaR - fillH;
    if (fillH > 2) {
      const fillColor = isVetoed ? "#E89B96" : currentSum >= theta ? "#FAD37A" : "#F7C58E";
      ctx.fillStyle = fillColor;
      ctx.globalAlpha = env3 * 0.72;
      ctx.fillRect(-somaR, fillY, somaR * 2, fillH);
      ctx.globalAlpha = env3;

      scribbleHatchRect(ctx, -somaR, fillY, somaR * 2, fillH, {
        color: isVetoed ? PAL.crimson : PAL.amber,
        alpha: 0.28,
        gap: 8,
        angle: -0.5,
        width: 1.8,
        seed: "soma-gauge-hatch",
        cross: currentSum >= theta
      });

      // Wavy hand-drawn meniscus line at top of liquid fill
      penStroke(ctx, [[-somaR, fillY], [0, fillY + Math.sin(t * 4) * 3], [somaR, fillY]], {
        width: 2.2,
        color: isVetoed ? PAL.crimson : PAL.amber,
        alpha: 0.85,
        wobble: 1.5,
        retrace: false,
        seed: "meniscus"
      });
    }

    // Horizontal Sketched Threshold Line θ = 2
    if (t >= 48.2) {
      const thEnv = easeOutCubic(invLerp(48.2, 49.2, t));
      const thY = somaR - somaR * 2 * (2.0 / 3.0);
      ctx.save();
      ctx.globalAlpha = env3 * thEnv;
      penStroke(ctx, [[-somaR, thY], [0, thY], [somaR, thY]], {
        width: 3.0,
        color: PAL.teal,
        alpha: 0.95,
        wobble: 1.2,
        retrace: true,
        seed: "th-line"
      });

      const thPill = sketchyRectPts(-72, thY - 30, 144, 26, 1.2, "th-pill");
      wetWash(ctx, thPill, "#D2EDE6", { alpha: 0.95, pool: 0.2, bleed: 1, rim: true, dx: 0, dy: 0 });
      penStroke(ctx, thPill, { closed: true, width: 1.8, color: PAL.ink, wobble: 0.8, retrace: false, seed: "th-pp" });

      ctx.font = "800 13px 'JetBrains Mono', monospace";
      ctx.fillStyle = PAL.ink;
      ctx.textAlign = "center";
      ctx.fillText("THRESHOLD θ = 2", 0, thY - 13);
      ctx.restore();
    }

    ctx.restore(); // end clip

    // Soma Double-Retraced Fountain Pen Outline
    penStroke(ctx, somaPts, {
      closed: true,
      width: 4.0,
      color: isVetoed ? PAL.crimson : isFiring > 0.2 ? PAL.amber : PAL.ink,
      alpha: 0.95,
      wobble: 1.8,
      retrace: true,
      boilTime: t,
      seed: "act3-soma-out"
    });

    // Soma Internal Readout Text
    ctx.textAlign = "center";
    ctx.font = "700 14px 'JetBrains Mono', monospace";
    ctx.fillStyle = PAL.inkSoft;
    ctx.fillText("EXCITATORY SUM", 0, -4);

    ctx.font = "800 42px 'JetBrains Mono', monospace";
    ctx.fillStyle = isVetoed ? PAL.crimson : PAL.ink;
    ctx.fillText(`Σ xᵢ = ${currentSum}`, 0, 40);

    if (isVetoed) {
      ctx.save();
      ctx.rotate(-0.12);
      const vStamp = sketchyRectPts(-106, 58, 212, 38, 1.6, "veto-stamp");
      wetWash(ctx, vStamp, PAL.crimson, { alpha: 0.92, pool: 0.2, bleed: 1.5, rim: true, dx: 1, dy: 1 });
      penStroke(ctx, vStamp, { closed: true, width: 2.2, color: PAL.ink, wobble: 1.0, retrace: true, seed: "vs-p" });
      ctx.font = "800 17px 'JetBrains Mono', monospace";
      ctx.fillStyle = "#FFFDF7";
      ctx.fillText("VETOED · SILENCED", 0, 82);
      ctx.restore();
    } else {
      ctx.font = "800 16px 'JetBrains Mono', monospace";
      ctx.fillStyle = currentSum >= theta ? PAL.teal : PAL.inkSoft;
      ctx.fillText(currentSum >= theta ? `Σ (${currentSum}) ≥ θ (${theta})  ✓` : `Σ (${currentSum}) < θ (${theta})`, 0, 82);
    }

    ctx.restore();

    // -------------------------------------------------------------------------
    // 4. OUTPUT AXON & NEXT-STEP y(t+1) READOUT
    // -------------------------------------------------------------------------
    const outStartX = somaX + somaR + 6;
    const outEndX = wx + ww - 208;
    drawCurvedAxon(
      ctx,
      { x: outStartX, y: somaY },
      { x: (outStartX + outEndX) / 2, y: somaY },
      { x: outEndX, y: somaY },
      {
        color: isVetoed ? PAL.crimson : isFiring > 0.2 ? PAL.amber : PAL.steel,
        width: isFiring > 0.2 ? 4.8 : 3.0,
        pulseU: isVetoed ? -1 : outU,
        pulseColor: PAL.gold,
        pulseRadius: 12,
        boilTime: t
      }
    );

    const outVal = !isVetoed && isFiring > 0.3 ? 1 : 0;
    const obPts = sketchyRectPts(outEndX + 12, somaY - 38, 174, 76, 1.8, "act3-out-b");
    wetWash(ctx, obPts, outVal ? "#FCE2A6" : isVetoed ? "#F7CBC7" : "#EFE8D8", {
      alpha: 0.94, pool: 0.3, bleed: 2, rim: true, dx: 1, dy: 1
    });
    penStroke(ctx, obPts, {
      closed: true,
      width: 2.5,
      color: outVal ? PAL.amber : isVetoed ? PAL.crimson : PAL.inkSoft,
      wobble: 1.3,
      retrace: true,
      seed: "act3-out-bp"
    });

    ctx.font = "700 13px 'JetBrains Mono', monospace";
    ctx.fillStyle = PAL.inkSoft;
    ctx.textAlign = "center";
    ctx.fillText("NEXT STEP OUTPUT", outEndX + 99, somaY - 12);

    ctx.font = "800 27px 'JetBrains Mono', monospace";
    ctx.fillStyle = outVal ? PAL.crimson : isVetoed ? PAL.crimson : PAL.ink;
    ctx.fillText(`y(t+1) = ${outVal}`, outEndX + 99, somaY + 22);

    // Doodle Guide Character in bottom-right corner of workbench reacting to Firing / Veto!
    drawDoodleGuide(
      ctx,
      wx + ww - 95,
      wy + wh - 88,
      0.92,
      t,
      isVetoed ? "shocked" : isFiring > 0.2 ? "excited" : "curious",
      isVetoed ? "VETO!" : isFiring > 0.2 ? "FIRE!" : "Σ xᵢ"
    );

    // -------------------------------------------------------------------------
    // 5. RIGHT-HAND SKETCHBOOK MARGIN NOTES PANEL (x = 1258..1834)
    // -------------------------------------------------------------------------
    const mx = 1258, my = 206, mw = 576, mh = 696;
    drawArchivalCard(ctx, mx, my, mw, mh, {
      header: "NOTEBOOK MARGIN · 1943 FORMAL CALCULUS",
      accent: PAL.biroBlue
    });

    ctx.textAlign = "left";
    const blocks = [
      {
        idx: 1,
        y: my + 62,
        h: 175,
        wash: "#FCE8C2",
        col: PAL.amber,
        title: "1. SPATIAL SUMMATION OF EXCITATORY INPUTS",
        eq: `g(x) = Σᵢ xᵢ(t) = ${x1} + ${x2} + ${x3} = ${currentSum}`,
        d1: "All excitatory inputs carry equal unit weight (+1).",
        d2: "No learned synaptic weights exist in the 1943 paper."
      },
      {
        idx: 2,
        y: my + 258,
        h: 185,
        wash: "#D6EDE8",
        col: PAL.teal,
        title: "2. THRESHOLD STEP FUNCTION & SYNAPTIC DELAY",
        eq: "y(t+1) = 1   iff   g(x) ≥ θ",
        d1: "If excitation reaches θ within the period of latent",
        d2: "addition, the cell emits an impulse at time t + 1."
      },
      {
        idx: 3,
        y: my + 464,
        h: 206,
        wash: "#F7D3CF",
        col: PAL.crimson,
        title: "3. ABSOLUTE INHIBITORY VETO (COMPLETE LAW)",
        eq: "y(t+1) = 1  ⇔  (Σ xᵢ ≥ θ) ∧ (∀j, zⱼ = 0)",
        d1: "Any active inhibitory synapse (zⱼ = 1) acts as an",
        d2: "absolute veto, preventing firing regardless of Σ xᵢ."
      }
    ];

    blocks.forEach((b) => {
      const isAct = ruleIdx === b.idx;
      const bPts = sketchyRectPts(mx + 22, b.y, mw - 44, b.h, 1.6, `mblk:${b.idx}`);
      wetWash(ctx, bPts, isAct ? b.wash : "#F7F1E3", {
        alpha: isAct ? 0.92 : 0.65,
        pool: 0.25,
        bleed: 2,
        rim: isAct,
        dx: 1,
        dy: 1
      });
      penStroke(ctx, bPts, {
        closed: true,
        width: isAct ? 2.4 : 1.4,
        color: isAct ? b.col : PAL.inkSoft,
        wobble: 1.2,
        retrace: isAct,
        seed: `mblk-p:${b.idx}`
      });

      ctx.font = "800 14px 'JetBrains Mono', monospace";
      ctx.fillStyle = b.col;
      ctx.fillText(b.title, mx + 40, b.y + 32);

      ctx.font = b.idx === 3 ? "800 19px 'JetBrains Mono', monospace" : "800 23px 'JetBrains Mono', monospace";
      ctx.fillStyle = PAL.ink;
      ctx.fillText(b.eq, mx + 40, b.y + 76);

      ctx.font = "400 16px 'Georgia', serif";
      ctx.fillStyle = PAL.inkSoft;
      ctx.fillText(b.d1, mx + 40, b.y + 114);
      ctx.fillText(b.d2, mx + 40, b.y + 140);

      if (b.idx === 3) {
        ctx.font = "800 15px 'JetBrains Mono', monospace";
        ctx.fillStyle = isVetoed ? PAL.crimson : PAL.teal;
        ctx.fillText(
          isVetoed
            ? `STATUS: VETO ACTIVE (z₁=1 overrides Σ=${currentSum})`
            : `STATUS: NO INHIBITION (z₁=0)`,
          mx + 40,
          b.y + 178
        );
      }
    });

    ctx.restore();
  }

  window.ACT3 = { renderAct3 };
})();

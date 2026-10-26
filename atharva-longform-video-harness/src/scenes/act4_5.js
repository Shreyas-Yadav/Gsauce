// src/scenes/act4_5.js — Acts IV & V (70.80s – 122.77s)
// Hand-drawn Sketchbook, Fountain Pen & Watercolor Wash Style
// Act IV: Universal Logic Gates (OR θ=1, AND θ=2, NOT Veto) & Logical Networks (70.8s - 98.0s)
// Act V: Fatal Flaw (Equal Strength, No Learning, XOR Failure) & Legacy Timeline (98.0s - 122.77s)

(function () {
  const {
    W, H, PAL, clamp, lerp, invLerp,
    easeOutCubic, easeInOutCubic, easeOutBack,
    windowEnv, sketchyRectPts, sketchyCirclePts,
    wetWash, penStroke, scribbleHatchRect,
    drawArchivalCard, drawCurvedAxon, drawMorphingNeuron,
    drawDoodleGuide, lerpColor
  } = window.ENG;

  function drawGateBay(ctx, x, y, w, h, t, cfg) {
    const {
      title,
      symbol,
      thetaLabel,
      activeHighlight,
      accent,
      inputs,
      inhibitory = false,
      sumText,
      outVal,
      rows,
      activeRowIdx
    } = cfg;

    drawArchivalCard(ctx, x, y, w, h, {
      header: title,
      accent: activeHighlight > 0.2 ? accent : PAL.steel,
      stroke: activeHighlight > 0.2 ? accent : PAL.ink
    });

    // Gate Logic Symbol & Hand-Highlighted θ Pill
    ctx.textAlign = "left";
    ctx.font = "bold 28px 'Georgia', serif";
    ctx.fillStyle = activeHighlight > 0.2 ? accent : PAL.ink;
    ctx.fillText(symbol, x + 26, y + 84);

    const thPts = sketchyRectPts(x + w - 135, y + 56, 110, 36, 1.4, `thb:${title}`);
    wetWash(ctx, thPts, "#FCE2A6", { alpha: 0.9, pool: 0.25, bleed: 1.5, rim: true, dx: 1, dy: 1 });
    penStroke(ctx, thPts, { closed: true, width: 2.0, color: PAL.ink, wobble: 1.0, retrace: false, seed: `thbp:${title}` });
    ctx.textAlign = "center";
    ctx.font = "800 18px 'JetBrains Mono', monospace";
    ctx.fillStyle = PAL.ink;
    ctx.fillText(thetaLabel, x + w - 80, y + 79);

    // Mini Sketched Neuron Diagram inside Bay
    const ncx = x + w * 0.52;
    const ncy = y + 210;
    const pulseU = activeHighlight > 0.2 ? (t * 1.45) % 1.0 : -1;

    if (inputs.length === 2 && !inhibitory) {
      for (let i = 0; i < 2; i++) {
        const iy = ncy + (i === 0 ? -48 : 48);
        const isOn = inputs[i].val === 1;
        drawCurvedAxon(
          ctx,
          { x: x + 98, y: iy },
          { x: x + 165, y: iy },
          { x: ncx - 60, y: ncy + (i === 0 ? -22 : 22) },
          {
            color: isOn ? PAL.amber : PAL.steel,
            width: isOn ? 3.5 : 2.2,
            pulseU: isOn ? pulseU : -1,
            pulseColor: PAL.gold,
            boilTime: t
          }
        );
        ctx.font = "800 16px 'JetBrains Mono', monospace";
        ctx.fillStyle = isOn ? PAL.crimson : PAL.inkSoft;
        ctx.textAlign = "left";
        ctx.fillText(`${inputs[i].label}=${inputs[i].val}`, x + 22, iy + 5);
      }
    } else if (inhibitory) {
      drawCurvedAxon(
        ctx,
        { x: x + 98, y: ncy - 38 },
        { x: x + 165, y: ncy - 38 },
        { x: ncx - 60, y: ncy - 16 },
        {
          color: PAL.amber,
          width: 3.4,
          pulseU: pulseU,
          pulseColor: PAL.gold,
          boilTime: t
        }
      );
      ctx.font = "800 15px 'JetBrains Mono', monospace";
      ctx.fillStyle = PAL.amber;
      ctx.textAlign = "left";
      ctx.fillText("DRIVE=1", x + 18, ncy - 33);

      const zVal = inputs[0].val;
      drawCurvedAxon(
        ctx,
        { x: x + 98, y: ncy + 48 },
        { x: x + 165, y: ncy + 48 },
        { x: ncx - 48, y: ncy + 34 },
        {
          color: zVal ? PAL.crimson : PAL.steel,
          width: zVal ? 3.8 : 2.4,
          pulseU: zVal ? pulseU : -1,
          pulseColor: PAL.crimson,
          inhibitoryLoop: true,
          boilTime: t
        }
      );
      ctx.fillStyle = zVal ? PAL.crimson : PAL.inkSoft;
      ctx.fillText(`z₁ = ${zVal}`, x + 22, ncy + 53);
    }

    // Output axon
    drawCurvedAxon(
      ctx,
      { x: ncx + 60, y: ncy },
      { x: ncx + 115, y: ncy },
      { x: x + w - 95, y: ncy },
      {
        color: outVal ? PAL.amber : PAL.steel,
        width: outVal ? 4.2 : 2.5,
        pulseU: outVal ? pulseU : -1,
        pulseColor: PAL.gold,
        boilTime: t
      }
    );
    ctx.font = "800 20px 'JetBrains Mono', monospace";
    ctx.fillStyle = outVal ? PAL.crimson : PAL.inkSoft;
    ctx.textAlign = "right";
    ctx.fillText(`y=${outVal}`, x + w - 22, ncy + 7);

    // Draw Soma
    drawMorphingNeuron(ctx, ncx, ncy, 0.92, t, {
      seedKey: title,
      morph: 1,
      firing: outVal ? 0.85 : 0,
      theta: thetaLabel.includes("2") ? 2 : 1,
      sumVal: sumText,
      vetoed: inhibitory && inputs[0].val === 1
    });

    // Hand-drawn Truth Table at bottom of Bay
    const tty = y + 325;
    const rowH = 44;
    ctx.font = "800 15px 'JetBrains Mono', monospace";
    ctx.fillStyle = PAL.biroBlue;
    ctx.textAlign = "center";

    const headers = rows[0];
    const colW = (w - 52) / headers.length;
    for (let c = 0; c < headers.length; c++) {
      ctx.fillText(headers[c], x + 26 + colW * (c + 0.5), tty);
    }

    for (let r = 1; r < rows.length; r++) {
      const ry = tty + 16 + (r - 1) * (rowH + 6);
      const isAct = r - 1 === activeRowIdx && activeHighlight > 0.1;
      const rowData = rows[r];
      const rowOut = rowData[rowData.length - 1] === "1";

      const rPts = sketchyRectPts(x + 26, ry, w - 52, rowH, 1.3, `ttr:${title}:${r}`);
      wetWash(
        ctx,
        rPts,
        isAct ? (rowOut ? "#FCE09B" : "#F7CBC7") : "#F5EFE0",
        { alpha: isAct ? 0.92 : 0.65, pool: 0.2, bleed: 1.5, rim: isAct, dx: 1, dy: 1 }
      );
      penStroke(ctx, rPts, {
        closed: true,
        width: isAct ? 2.2 : 1.2,
        color: isAct ? (rowOut ? PAL.amber : PAL.crimson) : PAL.inkSoft,
        alpha: isAct ? 0.92 : 0.45,
        wobble: 1.0,
        retrace: isAct,
        seed: `ttrp:${title}:${r}`
      });

      ctx.font = isAct ? "800 18px 'JetBrains Mono', monospace" : "600 17px 'JetBrains Mono', monospace";
      for (let c = 0; c < rowData.length; c++) {
        if (c === rowData.length - 1) {
          ctx.fillStyle = rowData[c] === "1" ? PAL.crimson : PAL.inkSoft;
        } else {
          ctx.fillStyle = isAct ? PAL.ink : PAL.inkSoft;
        }
        ctx.fillText(rowData[c], x + 26 + colW * (c + 0.5), ry + 27);
      }
    }
  }

  function renderAct4_5(ctx, t) {
    // =========================================================================
    // SHOT 4.1 & 4.2 (70.80s – 92.60s): THREE LOGIC GATES WORKBENCH (OR, AND, NOT)
    // =========================================================================
    const env41 = windowEnv(t, 70.7, 92.9, 0.5, 0.55);
    if (env41 > 0.001) {
      ctx.save();
      ctx.globalAlpha = env41;

      drawArchivalCard(ctx, 76, 88, W - 152, 92, {
        header: "PROPOSITIONAL LOGIC CALCULUS · TUNING THRESHOLD θ CREATES BOOLEAN GATES",
        accent: PAL.amber
      });
      ctx.font = "bold 24px 'Georgia', serif";
      ctx.fillStyle = PAL.ink;
      ctx.textAlign = "left";
      ctx.fillText(
        "One Sketched Neuron Model  →  Three Fundamental Boolean Operations (∨, ∧, ¬)",
        102,
        152
      );

      const isOverview = t < 77.8;
      const orHigh = isOverview ? 0.5 : t >= 77.8 && t < 83.9 ? 1.0 : 0.15;
      const andHigh = isOverview ? 0.5 : t >= 83.9 && t < 89.6 ? 1.0 : 0.15;
      const notHigh = isOverview ? 0.5 : t >= 89.6 ? 1.0 : 0.15;

      const orRow = t < 79.5 ? 1 : t < 81.2 ? 2 : 3;
      const orPairs = [[0, 0], [0, 1], [1, 0], [1, 1]][orRow];
      const orSum = orPairs[0] + orPairs[1];

      const andRow = t < 86.6 ? 2 : 3;
      const andPairs = [[0, 0], [0, 1], [1, 0], [1, 1]][andRow];
      const andSum = andPairs[0] + andPairs[1];

      const notRow = ((Math.floor((t - 89.5) * 1.1) % 2) + 2) % 2;
      const notIn = notRow;

      const bayW = 564;
      const bayGap = 36;
      const startX = (W - (bayW * 3 + bayGap * 2)) / 2;
      const bayY = 202;
      const bayH = 688;

      drawGateBay(ctx, startX, bayY, bayW, bayH, t, {
        title: "GATE I · LOGICAL DISJUNCTION (OR)",
        symbol: "OR:  x₁ ∨ x₂",
        thetaLabel: "θ = 1",
        activeHighlight: orHigh,
        accent: PAL.amber,
        inputs: [
          { label: "x₁", val: orPairs[0] },
          { label: "x₂", val: orPairs[1] }
        ],
        sumText: orSum,
        outVal: orSum >= 1 ? 1 : 0,
        rows: [
          ["x₁", "x₂", "Σ xᵢ", "y (θ=1)"],
          ["0", "0", "0", "0"],
          ["0", "1", "1 ≥ 1", "1"],
          ["1", "0", "1 ≥ 1", "1"],
          ["1", "1", "2 ≥ 1", "1"]
        ],
        activeRowIdx: orRow
      });

      drawGateBay(ctx, startX + bayW + bayGap, bayY, bayW, bayH, t, {
        title: "GATE II · LOGICAL CONJUNCTION (AND)",
        symbol: "AND:  x₁ ∧ x₂",
        thetaLabel: "θ = 2",
        activeHighlight: andHigh,
        accent: PAL.teal,
        inputs: [
          { label: "x₁", val: andPairs[0] },
          { label: "x₂", val: andPairs[1] }
        ],
        sumText: andSum,
        outVal: andSum >= 2 ? 1 : 0,
        rows: [
          ["x₁", "x₂", "Σ xᵢ", "y (θ=2)"],
          ["0", "0", "0", "0"],
          ["0", "1", "1 < 2", "0"],
          ["1", "0", "1 < 2", "0"],
          ["1", "1", "2 ≥ 2", "1"]
        ],
        activeRowIdx: andRow
      });

      drawGateBay(ctx, startX + (bayW + bayGap) * 2, bayY, bayW, bayH, t, {
        title: "GATE III · LOGICAL NEGATION (NOT)",
        symbol: "NOT:  ¬ z₁",
        thetaLabel: "θ = 1 + ○",
        activeHighlight: notHigh,
        accent: PAL.crimson,
        inputs: [{ label: "z₁", val: notIn }],
        inhibitory: true,
        sumText: 1,
        outVal: notIn === 0 ? 1 : 0,
        rows: [
          ["DRIVE", "INHIBIT z₁", "RULE", "y = ¬z₁"],
          ["1", "0", "1 ≥ 1", "1"],
          ["1", "1", "VETO ○", "0"]
        ],
        activeRowIdx: notRow
      });

      ctx.restore();
    }

    // =========================================================================
    // SHOT 4.3 (92.50s – 98.30s): CHAINING CELLS INTO A LOGICAL NETWORK
    // =========================================================================
    const env43 = windowEnv(t, 92.5, 98.3, 0.45, 0.5);
    if (env43 > 0.001) {
      ctx.save();
      ctx.globalAlpha = env43;

      drawArchivalCard(ctx, 84, 90, W - 168, 815, {
        header: "COMPOSITE NEURAL LOGIC NETWORK · COMPUTING ANY PROPOSITIONAL FORMULA",
        accent: PAL.teal
      });

      ctx.font = "bold 25px 'Georgia', serif";
      ctx.fillStyle = PAL.ink;
      ctx.textAlign = "left";
      ctx.fillText(
        "Chaining McCulloch-Pitts Cells in Time:   y(t+2)  ≡  ( x₁(t) ∨ x₂(t) )  ∧  x₃(t)  ∧  ¬z₁(t+1)",
        118,
        156
      );

      const inNodes = [
        { x: 265, y: 310, label: "x₁(t) = 1", wash: "#FCE2A6", color: PAL.amber },
        { x: 265, y: 460, label: "x₂(t) = 0", wash: "#EFE8D8", color: PAL.steel },
        { x: 265, y: 630, label: "x₃(t) = 1", wash: "#FCE2A6", color: PAL.amber },
        { x: 265, y: 780, label: "z₁(t) = 0", wash: "#D5EDE8", color: PAL.teal }
      ];

      const midNodes = [
        { x: 820, y: 385, label: "N₁: OR GATE (θ=1)", theta: 1, sum: 1, fire: 1 },
        { x: 820, y: 685, label: "N₂: AND+¬ GATE (θ=1)", theta: 1, sum: 1, fire: 1 }
      ];

      const finalNode = { x: 1410, y: 535, label: "N₃: CONJUNCTION (θ=2)", theta: 2, sum: 2, fire: 1 };

      const wave1 = clamp((t - 93.0) / 1.4, 0, 1);
      const wave2 = clamp((t - 94.3) / 1.4, 0, 1);
      const wave3 = clamp((t - 95.5) / 1.2, 0, 1);

      drawCurvedAxon(ctx, inNodes[0], { x: 540, y: 320 }, { x: midNodes[0].x - 85, y: midNodes[0].y - 25 }, {
        color: PAL.amber, width: 3.8, pulseU: wave1 < 1 ? wave1 : (t * 1.1) % 1, boilTime: t
      });
      drawCurvedAxon(ctx, inNodes[1], { x: 540, y: 450 }, { x: midNodes[0].x - 85, y: midNodes[0].y + 25 }, {
        color: PAL.steel, width: 2.5, pulseU: -1, boilTime: t
      });
      drawCurvedAxon(ctx, inNodes[2], { x: 540, y: 640 }, { x: midNodes[1].x - 85, y: midNodes[1].y - 20 }, {
        color: PAL.amber, width: 3.8, pulseU: wave1 < 1 ? wave1 : (t * 1.1 + 0.2) % 1, boilTime: t
      });
      drawCurvedAxon(ctx, inNodes[3], { x: 540, y: 770 }, { x: midNodes[1].x - 75, y: midNodes[1].y + 38 }, {
        color: PAL.crimson, width: 2.8, pulseU: -1, inhibitoryLoop: true, boilTime: t
      });

      drawCurvedAxon(ctx, { x: midNodes[0].x + 85, y: midNodes[0].y }, { x: 1120, y: 420 }, { x: finalNode.x - 95, y: finalNode.y - 30 }, {
        color: PAL.amber, width: 4.2, pulseU: t >= 94.2 ? (wave2 < 1 ? wave2 : (t * 1.1 + 0.5) % 1) : -1, boilTime: t
      });
      drawCurvedAxon(ctx, { x: midNodes[1].x + 85, y: midNodes[1].y }, { x: 1120, y: 650 }, { x: finalNode.x - 95, y: finalNode.y + 30 }, {
        color: PAL.amber, width: 4.2, pulseU: t >= 94.2 ? (wave2 < 1 ? wave2 : (t * 1.1 + 0.5) % 1) : -1, boilTime: t
      });

      drawCurvedAxon(ctx, { x: finalNode.x + 95, y: finalNode.y }, { x: 1580, y: finalNode.y }, { x: 1675, y: finalNode.y }, {
        color: PAL.amber, width: 4.8, pulseU: t >= 95.3 ? (wave3 < 1 ? wave3 : (t * 1.2) % 1) : -1, boilTime: t
      });

      inNodes.forEach((nd, idx) => {
        const bPts = sketchyRectPts(nd.x - 140, nd.y - 26, 140, 52, 1.5, `net-in:${idx}`);
        wetWash(ctx, bPts, nd.wash, { alpha: 0.92, pool: 0.25, bleed: 1.5, rim: true, dx: 1, dy: 1 });
        penStroke(ctx, bPts, { closed: true, width: 2.2, color: nd.color, wobble: 1.2, retrace: true, seed: `net-inp:${idx}` });
        ctx.font = "800 18px 'JetBrains Mono', monospace";
        ctx.fillStyle = PAL.ink;
        ctx.textAlign = "center";
        ctx.fillText(nd.label, nd.x - 70, nd.y + 6);
      });

      midNodes.forEach((mn, idx) => {
        drawMorphingNeuron(ctx, mn.x, mn.y, 1.25, t, {
          seedKey: `net-mid-${idx}`,
          morph: 1,
          firing: t >= 94.0 ? 0.85 : 0.1,
          theta: mn.theta,
          sumVal: t >= 94.0 ? mn.sum : 0
        });
        ctx.font = "800 15px 'JetBrains Mono', monospace";
        ctx.fillStyle = PAL.teal;
        ctx.textAlign = "center";
        ctx.fillText(mn.label, mn.x, mn.y - 98);
      });

      drawMorphingNeuron(ctx, finalNode.x, finalNode.y, 1.45, t, {
        seedKey: "net-final",
        morph: 1,
        firing: t >= 95.2 ? 0.95 : 0.1,
        theta: finalNode.theta,
        sumVal: t >= 95.2 ? 2 : 0
      });
      ctx.font = "800 16px 'JetBrains Mono', monospace";
      ctx.fillStyle = PAL.crimson;
      ctx.textAlign = "center";
      ctx.fillText(finalNode.label, finalNode.x, finalNode.y - 110);

      if (t >= 95.2) {
        const trPts = sketchyRectPts(1682, finalNode.y - 36, 124, 72, 1.6, "true-badge");
        wetWash(ctx, trPts, PAL.gold, { alpha: 0.95, pool: 0.3, bleed: 2, rim: true, dx: 1, dy: 1 });
        penStroke(ctx, trPts, { closed: true, width: 2.5, color: PAL.ink, wobble: 1.2, retrace: true, seed: "true-bp" });
        ctx.font = "800 22px 'JetBrains Mono', monospace";
        ctx.fillStyle = PAL.ink;
        ctx.fillText("TRUE!", 1744, finalNode.y - 4);
        ctx.font = "800 16px 'JetBrains Mono', monospace";
        ctx.fillStyle = PAL.crimson;
        ctx.fillText("y = 1", 1744, finalNode.y + 20);
      }

      drawDoodleGuide(ctx, 1680, 275, 0.95, t, "excited", "⊢ TRUE!");
      ctx.restore();
    }

    // =========================================================================
    // SHOT 5.1 (98.00s – 109.90s): THE FATAL FLAW (FIXED WEIGHTS, NO LEARNING)
    // =========================================================================
    const env51 = windowEnv(t, 98.0, 109.9, 0.5, 0.55);
    if (env51 > 0.001) {
      ctx.save();
      ctx.globalAlpha = env51;

      drawArchivalCard(ctx, 84, 90, W - 168, 92, {
        header: "CRITICAL LIMITATION OF THE 1943 MODEL · FIXED ARCHITECTURE & NO LEARNING RULE",
        accent: PAL.crimson
      });
      ctx.font = "bold 24px 'Georgia', serif";
      ctx.fillStyle = PAL.ink;
      ctx.textAlign = "left";
      ctx.fillText(
        "Why McCulloch-Pitts Neurons Could Compute Logic, Yet Could Never Learn From Experience",
        112,
        152
      );

      // Left Panel: Rigid Hand-Wired Neuron (x = 84..1080)
      const lx = 84, ly = 206, lw = 990, lh = 694;
      drawArchivalCard(ctx, lx, ly, lw, lh, {
        header: "FLAW I & II · UNWEIGHTED INPUTS (w = 1) & HAND-WIRED THRESHOLD (θ)",
        accent: PAL.crimson
      });

      const ncx = lx + 545, ncy = ly + 290;
      const clampEnv = easeOutBack(invLerp(100.2, 101.4, t));
      const handEnv = easeOutBack(invLerp(103.0, 104.2, t));

      for (let i = 0; i < 2; i++) {
        const iy = ncy + (i === 0 ? -95 : 95);
        drawCurvedAxon(
          ctx,
          { x: lx + 115, y: iy },
          { x: lx + 280, y: iy },
          { x: ncx - 95, y: ncy + (i === 0 ? -35 : 35) },
          { color: PAL.steel, width: 3.6, pulseU: -1, boilTime: t }
        );

        if (clampEnv > 0.01) {
          ctx.save();
          ctx.translate(lx + 275, iy);
          ctx.scale(clampEnv, clampEnv);
          const clPts = sketchyRectPts(-120, -26, 240, 52, 1.6, `lock-w:${i}`);
          wetWash(ctx, clPts, "#F7CBC7", { alpha: 0.94, pool: 0.3, bleed: 2, rim: true, dx: 1, dy: 1 });
          penStroke(ctx, clPts, { closed: true, width: 2.5, color: PAL.crimson, wobble: 1.2, retrace: true, seed: `lock-wp:${i}` });
          ctx.font = "800 15px 'JetBrains Mono', monospace";
          ctx.fillStyle = PAL.crimson;
          ctx.textAlign = "center";
          ctx.fillText("FIXED w = 1.0 [LOCKED]", 0, 6);
          ctx.restore();
        }
      }

      drawMorphingNeuron(ctx, ncx, ncy, 1.5, t, {
        seedKey: "flaw-neuron",
        morph: 1,
        firing: 0,
        theta: 2,
        sumVal: null
      });

      if (handEnv > 0.01) {
        ctx.save();
        ctx.translate(ncx + 150, ncy - 95);
        ctx.scale(handEnv, handEnv);
        const hPts = sketchyRectPts(-128, -30, 256, 60, 1.6, "hand-wired");
        wetWash(ctx, hPts, "#FCE2A6", { alpha: 0.94, pool: 0.3, bleed: 2, rim: true, dx: 1, dy: 1 });
        penStroke(ctx, hPts, { closed: true, width: 2.4, color: PAL.amber, wobble: 1.2, retrace: true, seed: "hand-wp" });
        ctx.font = "800 15px 'JetBrains Mono', monospace";
        ctx.fillStyle = PAL.ink;
        ctx.textAlign = "center";
        ctx.fillText("HAND-WIRED θ (STATIC)", 0, -5);
        ctx.font = "700 13px 'JetBrains Mono', monospace";
        ctx.fillStyle = PAL.crimson;
        ctx.fillText("NO GRADIENT / NO PLASTICITY", 0, 18);
        ctx.restore();
      }

      if (t >= 105.6) {
        const vEnv = easeOutCubic(invLerp(105.6, 106.5, t));
        ctx.save();
        ctx.globalAlpha = env51 * vEnv;

        const yesPts = sketchyRectPts(lx + 40, ly + 505, 435, 142, 1.8, "comp-yes");
        wetWash(ctx, yesPts, "#D6EDE8", { alpha: 0.92, pool: 0.25, bleed: 2, rim: true, dx: 1, dy: 1 });
        penStroke(ctx, yesPts, { closed: true, width: 2.4, color: PAL.teal, wobble: 1.3, retrace: true, seed: "comp-yp" });
        ctx.font = "800 21px 'JetBrains Mono', monospace";
        ctx.fillStyle = PAL.teal;
        ctx.textAlign = "left";
        ctx.fillText("✓ SYMBOLIC COMPUTATION", lx + 64, ly + 552);
        ctx.font = "400 17px 'Georgia', serif";
        ctx.fillStyle = PAL.ink;
        ctx.fillText("Can execute any pre-wired Boolean circuit", lx + 64, ly + 590);
        ctx.fillText("or finite-state logical automaton.", lx + 64, ly + 616);

        const noPts = sketchyRectPts(lx + 505, ly + 505, 445, 142, 1.8, "learn-no");
        wetWash(ctx, noPts, "#F7CBC7", { alpha: 0.92, pool: 0.25, bleed: 2, rim: true, dx: 1, dy: 1 });
        penStroke(ctx, noPts, { closed: true, width: 2.4, color: PAL.crimson, wobble: 1.3, retrace: true, seed: "learn-np" });
        ctx.font = "800 21px 'JetBrains Mono', monospace";
        ctx.fillStyle = PAL.crimson;
        ctx.fillText("✗ BIOLOGICAL / DATA LEARNING", lx + 528, ly + 552);
        ctx.font = "400 17px 'Georgia', serif";
        ctx.fillStyle = PAL.ink;
        ctx.fillText("Cannot adjust synaptic weights from error", lx + 528, ly + 590);
        ctx.fillText("or adapt automatically to experience.", lx + 528, ly + 616);

        ctx.restore();
      }

      // Right Panel: Geometric Consequence & Single-Cell Linear Separability Limit
      const rx = 1104, ry = 206, rw = 732, rh = 694;
      drawArchivalCard(ctx, rx, ry, rw, rh, {
        header: "GEOMETRIC LIMIT · RIGID −45° HYPERPLANE & NON-LINEAR XOR",
        accent: PAL.amber
      });

      const px0 = rx + 145, py0 = ry + 470, pSize = 305;
      penStroke(ctx, [[px0, py0 - pSize - 30], [px0, py0 + 20]], { width: 2.2, color: PAL.ink, wobble: 1.0, retrace: true, seed: "xor-y" });
      penStroke(ctx, [[px0 - 20, py0], [px0 + pSize + 40, py0]], { width: 2.2, color: PAL.ink, wobble: 1.0, retrace: true, seed: "xor-x" });

      ctx.font = "800 16px 'JetBrains Mono', monospace";
      ctx.fillStyle = PAL.inkSoft;
      ctx.textAlign = "center";
      ctx.fillText("x₁ = 0", px0, py0 + 38);
      ctx.fillText("x₁ = 1", px0 + pSize, py0 + 38);
      ctx.textAlign = "right";
      ctx.fillText("x₂ = 0", px0 - 24, py0 + 5);
      ctx.fillText("x₂ = 1", px0 - 24, py0 - pSize + 5);

      // Fixed 45-degree hyperplane line trying in vain to separate XOR
      const shift = Math.sin(t * 1.8) * 35;
      penStroke(
        ctx,
        [
          [px0 - 20, py0 - pSize * 0.65 + shift],
          [px0 + pSize * 0.85, py0 + 30 + shift]
        ],
        { width: 3.2, color: PAL.crimson, wobble: 1.2, retrace: true, seed: "xor-line" }
      );

      const pts = [
        { x: px0, y: py0, label: "(0,0) → 0", dx: 26, dy: -18, cls: 0 },
        { x: px0 + pSize, y: py0, label: "(1,0) → 1", dx: 26, dy: -8, cls: 1 },
        { x: px0, y: py0 - pSize, label: "(0,1) → 1", dx: 26, dy: 6, cls: 1 },
        { x: px0 + pSize, y: py0 - pSize, label: "(1,1) → 0", dx: 26, dy: 6, cls: 0 }
      ];
      pts.forEach((pt, idx) => {
        const cPts = sketchyCirclePts(pt.x, pt.y, 16, 16, 14, 1.2, `xor-pt:${idx}`);
        wetWash(ctx, cPts, pt.cls === 1 ? PAL.gold : "#D5EDE8", { alpha: 0.92, pool: 0.25, bleed: 1.5, rim: true, dx: 1, dy: 1 });
        penStroke(ctx, cPts, { closed: true, width: 2.5, color: PAL.ink, wobble: 1.0, retrace: true, seed: `xor-ptp:${idx}` });
        ctx.font = "800 15px 'JetBrains Mono', monospace";
        ctx.fillStyle = pt.cls === 1 ? PAL.crimson : PAL.ink;
        ctx.textAlign = "left";
        ctx.fillText(pt.label, pt.x + pt.dx, pt.y + pt.dy);
      });

      ctx.textAlign = "left";
      ctx.font = "800 17px 'JetBrains Mono', monospace";
      ctx.fillStyle = PAL.crimson;
      ctx.fillText("WHY EQUAL WEIGHTS RESTRICT A SINGLE CELL:", rx + 44, ry + 560);
      ctx.font = "400 17px 'Georgia', serif";
      ctx.fillStyle = PAL.inkSoft;
      ctx.fillText("• Because w₁ = w₂ = 1, the decision boundary slope is", rx + 44, ry + 595);
      ctx.fillText("  frozen at −45° (x₁ + x₂ = θ) and cannot rotate.", rx + 44, ry + 622);
      ctx.fillText("• Non-linearly separable functions like XOR require", rx + 44, ry + 654);
      ctx.fillText("  multi-layer networks and learnable continuous weights.", rx + 44, ry + 680);

      drawDoodleGuide(ctx, rx + rw - 88, ry + 145, 0.9, t, "shocked", "STUCK!");
      ctx.restore();
    }

    // =========================================================================
    // SHOT 5.2 (109.60s – 122.77s): THE CORNERSTONE LEGACY & END CARD
    // =========================================================================
    const env52 = windowEnv(t, 109.6, 122.77, 0.55, 0.4);
    if (env52 > 0.001) {
      ctx.save();
      ctx.globalAlpha = env52;

      drawArchivalCard(ctx, 84, 90, W - 168, 92, {
        header: "HISTORICAL LEGACY · FROM 1943 BINARY LOGIC TO MODERN DEEP LEARNING",
        accent: PAL.amber
      });
      ctx.font = "bold 24px 'Georgia', serif";
      ctx.fillStyle = PAL.ink;
      ctx.textAlign = "left";
      ctx.fillText(
        "Translating Living Cells into Pure Mathematics Laid the Cornerstone of Artificial Intelligence",
        112,
        152
      );

      const eras = [
        {
          year: "1943",
          title: "McCulloch-Pitts Neuron",
          sub: "W. McCulloch & W. Pitts",
          eq: "y = 𝟙( Σ xᵢ ≥ θ ∧ ¬z )",
          desc1: "Binary inputs & threshold logic.",
          desc2: "Proved neural nets can compute",
          desc3: "any logical proposition.",
          accent: PAL.amber,
          wash: "#FCE4B4",
          appear: 110.2
        },
        {
          year: "1958",
          title: "The Perceptron",
          sub: "Frank Rosenblatt",
          eq: "y = 𝟙( Σ wᵢ·xᵢ + b ≥ 0 )",
          desc1: "Introduced continuous weights wᵢ",
          desc2: "and an automatic learning rule",
          desc3: "that adapts from training data.",
          accent: PAL.teal,
          wash: "#D4ECE6",
          appear: 115.2
        },
        {
          year: "1986 → TODAY",
          title: "Deep Neural Networks",
          sub: "Backpropagation & Transformers",
          eq: "h⁽ˡ⁾ = σ( W⁽ˡ⁾ h⁽ˡ⁻¹⁾ + b )",
          desc1: "Smooth activation functions &",
          desc2: "billions of learned parameters",
          desc3: "descended from the 1943 node.",
          accent: PAL.crimson,
          wash: "#F7D3CF",
          appear: 118.2
        }
      ];

      const cardW = 540;
      const gap = 56;
      const startX = (W - (cardW * 3 + gap * 2)) / 2;
      const cardY = 208;
      const cardH = 445;

      for (let i = 0; i < eras.length; i++) {
        const er = eras[i];
        const eProg = easeOutBack(invLerp(er.appear, er.appear + 0.9, t));
        if (eProg <= 0.01) continue;

        const cx = startX + i * (cardW + gap);
        ctx.save();
        ctx.globalAlpha = env52 * clamp(eProg, 0, 1);
        ctx.translate(0, (1 - eProg) * 28);

        drawArchivalCard(ctx, cx, cardY, cardW, cardH, {
          header: `MILESTONE 0${i + 1} · ${er.year}`,
          accent: er.accent,
          stroke: er.accent
        });

        if (i > 0) {
          drawCurvedAxon(
            ctx,
            { x: cx - gap + 8, y: cardY + cardH / 2 },
            { x: cx - gap / 2, y: cardY + cardH / 2 - 8 },
            { x: cx - 10, y: cardY + cardH / 2 },
            { color: er.accent, width: 3.6, pulseU: (t * 1.2 + i * 0.3) % 1, boilTime: t }
          );
        }

        ctx.font = "800 34px 'JetBrains Mono', monospace";
        ctx.fillStyle = er.accent;
        ctx.textAlign = "left";
        ctx.fillText(er.year, cx + 28, cardY + 92);

        ctx.font = "bold 26px 'Georgia', serif";
        ctx.fillStyle = PAL.ink;
        ctx.fillText(er.title, cx + 28, cardY + 134);

        ctx.font = "700 15px 'JetBrains Mono', monospace";
        ctx.fillStyle = PAL.inkSoft;
        ctx.fillText(er.sub, cx + 28, cardY + 164);

        const eqPts = sketchyRectPts(cx + 28, cardY + 190, cardW - 56, 76, 1.6, `era-eq:${i}`);
        wetWash(ctx, eqPts, er.wash, { alpha: 0.9, pool: 0.25, bleed: 2, rim: true, dx: 1, dy: 1 });
        penStroke(ctx, eqPts, { closed: true, width: 2.2, color: PAL.ink, wobble: 1.1, retrace: true, seed: `era-eqp:${i}` });

        ctx.font = "800 21px 'JetBrains Mono', monospace";
        ctx.fillStyle = PAL.ink;
        ctx.textAlign = "center";
        ctx.fillText(er.eq, cx + cardW / 2, cardY + 235);

        ctx.textAlign = "left";
        ctx.font = "400 18px 'Georgia', serif";
        ctx.fillStyle = PAL.ink;
        ctx.fillText(er.desc1, cx + 28, cardY + 316);
        ctx.fillText(er.desc2, cx + 28, cardY + 346);
        ctx.fillText(er.desc3, cx + 28, cardY + 376);

        ctx.restore();
      }

      // Bottom Resolving Sketchbook Colophon Banner (y = 682..902)
      const endEnv = easeOutCubic(invLerp(113.5, 115.0, t));
      if (endEnv > 0.01) {
        ctx.save();
        ctx.globalAlpha = env52 * endEnv;
        drawArchivalCard(ctx, 84, 680, W - 168, 214, {
          header: "LOST IN TRANSLATION · EXPERIMENT 001 · HAND-DRAWN PROCEDURAL FILM",
          accent: PAL.amber,
          stroke: PAL.ink
        });

        drawMorphingNeuron(ctx, 235, 800, 1.0, t, {
          seedKey: "finale-emblem",
          morph: 1,
          firing: 0.85,
          theta: 2,
          sumVal: 2
        });

        ctx.textAlign = "left";
        ctx.font = "bold 32px 'Georgia', serif";
        ctx.fillStyle = PAL.ink;
        ctx.fillText("The McCulloch-Pitts Neuron (1943)", 355, 776);

        ctx.font = "italic 600 19px 'Georgia', serif";
        ctx.fillStyle = PAL.crimson;
        ctx.fillText(
          "“Because of the all-or-none character of nervous activity, neural events can be treated by propositional logic.”",
          355,
          816
        );

        ctx.font = "600 15px 'JetBrains Mono', monospace";
        ctx.fillStyle = PAL.inkSoft;
        ctx.fillText(
          "Warren S. McCulloch & Walter Pitts · Bulletin of Mathematical Biophysics, Vol. 5, pp. 115–133 (1943)",
          355,
          854
        );

        drawDoodleGuide(ctx, W - 185, 800, 0.95, t, "excited", "♥ 1943");
        ctx.restore();
      }

      ctx.restore();
    }
  }

  window.ACT4_5 = { renderAct4_5 };
})();

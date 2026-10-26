// Hand-authored plumbing fixture, not presented as an Argon-generated result.
const brief = Object.freeze({
  topic: "Why averaging reduces a spike", audience: "First-time learners", duration: 12, style: "line",
  takeaway: "A three-point mean spreads one isolated spike over its neighbors.",
  facts: ["Input [0,0,9,0,0].", "At the center, (0+9+0)/3 = 3.", "With zero padding the output is [0,3,3,3,0]."],
  sources: ["Explicit arithmetic test fixture; no external factual claims."]
});

const source = `return {
  duration: 12,
  draw(ctx, t, kit) {
    const { PAL } = kit;
    kit.label("One spike. Three neighbors.", 540, 275, {size:48});
    const xs = [200,370,540,710,880];
    const input = [0,0,9,0,0];
    const output = [0,3,3,3,0];
    const active = Math.min(3, 1+Math.floor(Math.max(0,t-5)/1.5));
    for (let i=0;i<5;i++) {
      const x=xs[i];
      kit.stroke([[x-55,700],[x-55,700-input[i]*30],[x+55,700-input[i]*30],[x+55,700]], {seed:'input'+i,width:5});
      kit.label(input[i],x,770,{size:44});
      if (t>3 && Math.abs(i-active)<=1) kit.circle(x,800,64,{color:PAL.accent,seed:'window'+i,width:4});
      if (t>6) {
        const height=output[i]*55*kit.ease(kit.clamp((t-6-i*.25)/1.5));
        kit.stroke([[x-55,1270],[x-55,1270-height],[x+55,1270-height],[x+55,1270]], {seed:'out'+i,width:5,color:PAL.accent});
        kit.label(output[i],x,1340,{size:44,color:PAL.accent});
      }
    }
    kit.label("Input",540,355,{size:42});
    if(t>4) kit.label("(0 + 9 + 0) / 3 = 3",540,1020,{size:48});
    if(t>6) kit.label("Three-point mean",540,1510,{size:42,color:PAL.accent});
  }
};`;

module.exports = { brief, source };

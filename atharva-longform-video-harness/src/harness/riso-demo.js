// Hand-authored art-direction preview; the live production agent still authors its own scene.
const source = `return { duration:12, draw(ctx,t,kit) {
  const R=kit.riso, W=kit.W;
  function disc(ink,x,y,r,screen=false,tone=1){const g=R.plate(ink,screen?'screen':'solid');g.fillStyle=R.tone(tone);g.beginPath();g.arc(x,y,r,0,Math.PI*2);g.fill();}
  function clearDisc(x,y,r){R.knockout(g=>{g.beginPath();g.arc(x,y,r,0,Math.PI*2);g.fill();});}
  const sky=R.plate('blue','screen');sky.fillStyle=R.tone(.22);sky.fillRect(0,460,W,930);
  disc('yellow',540,670,205);
  disc('pink',575,690,165,true,.33);
  const orbit=R.plate('navy');orbit.strokeStyle=R.tone(.65);orbit.lineWidth=4;
  orbit.beginPath();orbit.ellipse(540,675,350,105,-.2,0,Math.PI*2);orbit.stroke();
  for(let i=0;i<3;i++){const x=240+i*300;clearDisc(x,1280,118);disc('yellow',x,1280,118);disc('blue',x+15,1300,100,true,.35);}
  for(let i=0;i<9;i++){
    const group=Math.floor(i/3), n=i%3, u=kit.ease(kit.clamp((t-2.6-group*1.1)/3));
    const sx=480+(i%3)*60, sy=610+Math.floor(i/3)*60;
    const ex=240+group*300+(n-1)*48, ey=1270+(n===1?42:-8);
    const x=kit.lerp(sx,ex,u)+Math.sin(u*Math.PI)*(group-1)*110, y=kit.lerp(sy,ey,u);
    disc('navy',x+5,y+8,27);disc('pink',x,y,27);
    disc('yellow',x-7,y-9,8);
  }
  kit.label('SMOOTH THE SPIKE',540,235,{size:68});
  kit.label('ONE BURST. THREE SHARES.',540,310,{size:32});
  kit.label('9',540,425,{size:100,color:'pink'});
  if(t>6)for(let i=0;i<3;i++)kit.label('3',240+i*300,1490,{size:90,color:'blue'});
  if(t>9)kit.label('9 ÷ 3 = 3',540,1620,{size:56});
}};`;

module.exports = { source };

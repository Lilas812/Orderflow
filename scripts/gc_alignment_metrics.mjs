/** Pure research metrics. No network, market-data writes, or secret access. */
export function paired(a, b, indices, shift, step = 1, changes = false) {
  let n=0, sx=0, sy=0, xx=0, yy=0, xy=0, abs=0, equal=0;
  for(let k=0;k<indices.length;k+=step) {
    const i=indices[k], j=i+shift;
    if(j<1||j>=b.length||!b[j]||!a[i]||(changes&&(!a[i-1]||!b[j-1]))) continue;
    const x=changes?a[i]-a[i-1]:a[i]-40000;
    const y=changes?b[j]-b[j-1]:b[j]-40000;
    n++;sx+=x;sy+=y;xx+=x*x;yy+=y*y;xy+=x*y;abs+=Math.abs(x-y);equal+=x===y?1:0;
  }
  const vx=xx-sx*sx/n, vy=yy-sy*sy/n, cov=xy-sx*sy/n;
  return {shift, pairs:n, correlation:n>1&&vx>0&&vy>0?cov/Math.sqrt(vx*vy):null,
    maeTicks:n?abs/n:null, equalRate:n?equal/n:null,
    slopeAppVsReference:vy>0?cov/vy:null,
    interceptTicks:vy>0?(changes?sx/n-(cov/vy)*sy/n:40000+sx/n-(cov/vy)*(40000+sy/n)):null};
}
export function searchLag(a,b,indices) {
  const coarse=[];
  for(let lag=-7200;lag<=7200;lag+=60) coarse.push(paired(a,b,indices,lag,30));
  const rank=rows=>rows.filter(r=>r.pairs>=Math.max(20,indices.length/100)&&r.correlation!==null)
    .sort((a,b)=>b.correlation-a.correlation);
  const peaks=rank(coarse).slice(0,3);
  const refine=new Map();
  for(const p of peaks) for(let lag=Math.max(-7200,p.shift-60);lag<=Math.min(7200,p.shift+60);lag++)
    if(!refine.has(lag))refine.set(lag,paired(a,b,indices,lag,5));
  const best=rank([...refine.values()])[0];
  const full=[];
  for(const lag of new Set([0,-3600,3600,-7200,7200,...(best?Array.from({length:11},(_,i)=>best.shift+i-5).filter(x=>Math.abs(x)<=7200):[])]))
    full.push({...paired(a,b,indices,lag),changes:paired(a,b,indices,lag,1,true)});
  return {convention:"app(t) versus reference(t + shift), seconds",coarse,refined:[...refine.values()],
    full, best:rank(full)[0]??null};
}
export function frequency(bid,ask,indices) {
  let adjacent=0,changed=0,run=0,maxUnchangedTransitions=0,over10=0,previous=-2;
  for(const i of indices) {
    if(previous===i-1&&bid[i-1]&&ask[i-1]) {
      adjacent++;
      if(bid[i]!==bid[i-1]||ask[i]!==ask[i-1]) {changed++;run=0;}
      else {run++;maxUnchangedTransitions=Math.max(maxUnchangedTransitions,run);if(run===10)over10++;}
    } else run=0;
    previous=i;
  }
  return {adjacent,changed,changeRate:adjacent?changed/adjacent:null,maxUnchangedSeconds:maxUnchangedTransitions+1,
    unchangedRunsAtLeast11Seconds:over10};
}

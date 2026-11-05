/** Pure research helpers; coverage is half-open UTC seconds, never event presence. */
export function covered(ranges, sec) {
  let lo=0,hi=ranges.length;
  while(lo<hi){const m=(lo+hi)>>>1;if(ranges[m][1]<=sec)lo=m+1;else hi=m;}
  return lo<ranges.length&&ranges[lo][0]<=sec;
}
export function sideOf(side) {
  return side==="B"||side==="buy"?"buy":side==="A"||side==="sell"?"sell":"unknown";
}
export function empty(){return {count:0,size:0,buy:0,sell:0,unknown:0,pv:0};}
export function add(s,t){s.count++;s.size+=t.size;s[sideOf(t.side)]+=t.size;s.pv+=t.price*t.size;}
export function compareCells(a,b) {
  let overlap=0,missing=0,extra=0,countL1=0;
  for(const k of new Set([...a.keys(),...b.keys()])){
    const av=a.get(k)??{size:0,count:0},bv=b.get(k)??{size:0,count:0};
    overlap+=Math.min(av.size,bv.size);missing+=Math.max(0,bv.size-av.size);
    extra+=Math.max(0,av.size-bv.size);countL1+=Math.abs(av.count-bv.count);
  }
  return {overlap,missing,extra,countL1};
}

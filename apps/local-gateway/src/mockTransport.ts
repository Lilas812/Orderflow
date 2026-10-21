/** Count AND byte credits cover every unacknowledged IPC delivery, not only the local queue. */
export function ipcBatch(id: number, events: readonly unknown[], submittedMonoNs="0") {
  const message={kind:"batch",id,events,submittedMonoNs,bytes:0};
  for(let i=0;i<8;i++) {
    const bytes=Buffer.byteLength(JSON.stringify(message),"utf8");
    if(bytes===message.bytes) return message;
    message.bytes=bytes;
  }
  throw new Error("IPC serialized byte size did not converge");
}
export class IpcCredits {
  readonly pending = new Map<number,{ count:number; bytes:number; received:boolean }>();
  peakCount=0; peakBytes=0; pauseRequests=0;
  paused=false;
  constructor(readonly maxCount=2048, readonly maxBytes=8*1024*1024) {
    if(!Number.isSafeInteger(maxCount)||maxCount<1||!Number.isSafeInteger(maxBytes)||maxBytes<1)
      throw new TypeError("Finite positive IPC credit limits required");
  }
  get count(): number { return [...this.pending.values()].reduce((n,p)=>n+p.count,0); }
  get bytes(): number { return [...this.pending.values()].reduce((n,p)=>n+p.bytes,0); }
  reserve(id:number,count:number,bytes:number): boolean {
    if (!Number.isSafeInteger(count) || count<1 || !Number.isSafeInteger(bytes) || bytes<1 || this.pending.has(id))
      throw new TypeError("Invalid IPC credit");
    if (this.paused || this.count+count>this.maxCount || this.bytes+bytes>this.maxBytes) return false;
    this.pending.set(id,{count,bytes,received:false});
    this.peakCount=Math.max(this.peakCount,this.count); this.peakBytes=Math.max(this.peakBytes,this.bytes);
    if (Math.max(this.count/this.maxCount,this.bytes/this.maxBytes)>=.75) { this.paused=true; this.pauseRequests++; }
    return true;
  }
  received(id:number): void {
    const item=this.pending.get(id); if (!item || item.received) throw new Error("Unknown/duplicate receipt acknowledgement");
    item.received=true;
  }
  committed(id:number): void {
    const item=this.pending.get(id); if (!item?.received) throw new Error("Commit acknowledgement without receipt");
    this.pending.delete(id);
    if (this.paused && this.count<=this.maxCount*.5 && this.bytes<=this.maxBytes*.5) this.paused=false;
  }
  snapshot() {
    const unconfirmed=[...this.pending.values()].filter(p=>!p.received);
    return { outstandingEvents:this.count, outstandingBytes:this.bytes,
      unconfirmedSendEvents:unconfirmed.reduce((n,p)=>n+p.count,0),
      unconfirmedSendBytes:unconfirmed.reduce((n,p)=>n+p.bytes,0),
      peakOutstandingEvents:this.peakCount, peakOutstandingBytes:this.peakBytes, pauseRequests:this.pauseRequests };
  }
}

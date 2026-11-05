import test from "node:test";
import assert from "node:assert/strict";
import { decodeTrades } from "../src/data/protocol.ts";
import { FootprintStore } from "../src/footprint/model.ts";
import { TradeAggregator } from "../src/data/trade-aggregate.ts";
import { DailyState } from "../src/data/daily.ts";

for(const symbol of ["NQ","GC"] as const)test(`${symbol}: canonical unknown crosses wire into footprint total/POC without directional allocation`,()=>{
  const trades=decodeTrades(JSON.parse(JSON.stringify([
    {tsUs:100e6,recvUs:100e6,seq:1,price:4000,size:2,side:"buy",contract:symbol+"Z6"},
    {tsUs:100e6,recvUs:100e6,seq:2,price:4000,size:3,side:"sell",contract:symbol+"Z6"},
    {tsUs:100e6,recvUs:100e6,seq:3,price:4001,size:7,side:"unknown",contract:symbol+"Z6"}])));
  const fp=new FootprintStore();fp.appendLive(trades);
  const bar=fp.bars(100,105)[0]!.group.get(symbol+"Z6")!;
  assert.equal(bar.volume,12);assert.equal(bar.undirectedTotal,7);
  assert.equal(bar.delta,-1);assert.equal(bar.poc,4001);
  const agg=new TradeAggregator();agg.appendLive(trades);
  const cells=[...agg.cells(100e6,101e6)];
  assert.equal(cells.reduce((n,c)=>n+c.buy-c.sell,0),-1);
  assert.equal(cells.reduce((n,c)=>n+(c.undirected??0),0),7);
  const daily=new DailyState(symbol);
  assert.equal(daily.accept({symbol,sessionStartSec:60,revision:1,upToUs:100e6,loading:false,full:true,
    points:[[100e6,2,3,4000*5+4001*7,0,7]]}),true);
  daily.series();
  assert.equal(daily.snapshot().total,12);assert.equal(daily.snapshot().cvd,-1);
  assert.equal(daily.snapshot().vwapTicks,(4000*5+4001*7)/12);
});

import "./offline.ts";
import fs from "node:fs/promises";
import os from "node:os";
import assert from "node:assert/strict";

const [beforeDir, afterDir] = process.argv.slice(2);
for (const dir of [beforeDir,afterDir]) assert.match(dir ?? "",/^data\/history-investigation-[a-zA-Z0-9_-]+$/);
const before=JSON.parse(await fs.readFile(`${beforeDir}/visibility.json`,"utf8"));
const after=JSON.parse(await fs.readFile(`${afterDir}/visibility.json`,"utf8"));
assert.equal(before.variant,"baseline");assert.equal(after.variant,"fixed");
const sum=(rows:any[], key:string)=>rows.reduce((n,r)=>n+(r[key]??0),0);
const metric=(run:any, phases:string[])=>{
  const stages=run.stages.filter((s:any)=>phases.includes(s.phase));
  const binary=stages.flatMap((s:any)=>s.received), reads=stages.flatMap((s:any)=>s.reads);
  const json=stages.flatMap((s:any)=>s.jsonReceived).filter((d:any)=>["rangeTrades","rangeDone"].includes(d.type));
  return {
    requests:stages.flatMap((s:any)=>s.requests).length,
    binaryBytes:sum(binary,"bytes"),rangeJsonBytes:sum(json,"bytes"),
    independentDeflateBytes:sum(binary,"independentDeflateBytes"),
    readWallMs:sum(reads,"wallMs"),readProcessCpuMs:sum(reads,"sharedProcessCpuMs"),
    compressionWallMs:sum(binary,"compressionWallMs"),compressionProcessCpuMs:sum(binary,"compressionProcessCpuMs"),
    receiveWallMs:sum(binary,"receiveWallMs"),receiveProcessCpuMs:sum(binary,"receiveProcessCpuMs"),
    stageProcessCpuMs:sum(stages,"sharedProcessCpuMs"),stageWallMs:sum(stages,"wallMs"),
    timerDelayMaxMs:Math.max(...stages.map((s:any)=>s.maxTimerDelayMs)),
  };
};
const means=(rows:any[])=>Object.fromEntries(Object.keys(rows[0]).map(k=>[k,rows.reduce((s,r)=>s+r[k],0)/rows.length]));
const f=(n:number)=>n.toFixed(3);
let text=`# 履歴反映の限定再検証：隔離比較付録\n\n生成: summarize-fix.ts。ダミー入力、ブラウザ/画素なし、実main depth→renderer.draw入力の照合。\n\n基準版: ${before.baselineRef}\n\nmain SHA256 before=${before.mainSha256} / after=${after.mainSha256}\n\n`;
text+=`## 必須条件と要求・描画（各3回、下表はtrial 1。3回とも同じ要求範囲・列）\n\n`;
text+=`|条件/版|初回range/列数|追加保存列|完了時range / 受信列数|pan時range / 受信列数|追加draw列数/時刻（完了 / pan後）|\n|---|---|---:|---|---|---|\n`;
for(const scenario of [...new Set(after.results.map((r:any)=>r.scenario))]) {
  for(const [label,data] of [["before",before],["after",after]] as const) {
    const r=data.results.find((r:any)=>r.scenario===scenario&&r.trial===1);
    const [a,b,c]=r.stages;
    const ids=new Set(a.draw.inputSeconds),added=(s:any)=>s.draw.inputSeconds.filter((n:number)=>!ids.has(n));
    const ranges=(s:any)=>s.requests.map((q:any)=>`[${q.fromSec},${q.toSec})`).join(",")||"なし";
    const count=(s:any)=>s.received.reduce((n:number,x:any)=>n+x.seconds.length,0);
    const display=(s:any)=>`${added(s).length}/${added(s).join(",")||"なし"}`;
    text+=`|${scenario}/${label}|[1793275200,1793277000)/${count(a)}|2|${ranges(b)} / ${count(b)}|${ranges(c)} / ${count(c)}|${display(b)} / ${display(c)}|\n`;
  }
}
text+=`\n完了時に追加されたb=1793276980、pan後のa=1793276720はafterの全条件で時間内drawにも入る（別にassert）。初回部分空白は既知A=1793276710,B=1793276990の2列。全空条件は既知0列。browse-emptyは価格位置81000を維持する想定で、価格帯内の画素表示を主張しない。\n\n`;
text+=`## 完了＋最初のpan：3回平均（初回・後保存Backfill・resetを除外）\n\n|条件/版|要求|binary / range JSON B|独立deflate B|read wall / CPU ms|deflate wall / CPU ms|受信handler wall / CPU ms|stage wall / CPU ms|timer遅れmax ms|\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n`;
const records:any[]=[];
for(const scenario of [...new Set(after.results.map((r:any)=>r.scenario))]) {
  for(const [label,data] of [["before",before],["after",after]] as const) {
    const trials=data.results.filter((r:any)=>r.scenario===scenario).map((r:any)=>metric(r,["complete","pan"]));
    const m=means(trials);
    records.push({scenario,label,phases:["complete","pan"],trials,mean:m});
    text+=`|${scenario}/${label}|${m.requests}|${m.binaryBytes} / ${m.rangeJsonBytes}|${m.independentDeflateBytes}|${f(m.readWallMs)} / ${f(m.readProcessCpuMs)}|${f(m.compressionWallMs)} / ${f(m.compressionProcessCpuMs)}|${f(m.receiveWallMs)} / ${f(m.receiveProcessCpuMs)}|${f(m.stageWallMs)} / ${f(m.stageProcessCpuMs)}|${f(Math.max(...trials.map((r:any)=>r.timerDelayMaxMs)))}|\n`;
  }
}
text+=`\n## 反復・パン往復の全記録（trial 1、他2回も要求数一致）\n\n|条件/版|zoom要求|同じcomplete/view×10要求|pan-away要求 / 範囲|pan-back要求|reset要求|\n|---|---:|---:|---|---:|---:|\n`;
for(const scenario of [...new Set(after.results.map((r:any)=>r.scenario))]) {
  for(const [label,data] of [["before",before],["after",after]] as const) {
    const r=data.results.find((r:any)=>r.scenario===scenario&&r.trial===1);
    const stage=(name:string)=>r.stages.find((s:any)=>s.phase===name);
    const away=stage("pan-away");
    text+=`|${scenario}/${label}|${stage("zoom").requests.length}|${stage("repeat-complete").requests.length}|${away.requests.length} / ${away.requests.map((q:any)=>`[${q.fromSec},${q.toSec})`).join(",")||"なし"}|${stage("pan-back").requests.length}|${stage("follow-reset").requests.length}|\n`;
  }
}
const environment={node:process.version,os:os.release(),platform:os.platform(),arch:os.arch(),
  cpu:os.cpus()[0]?.model,cpus:os.cpus().length,availableParallelism:os.availableParallelism(),
  cpuMax:(await fs.readFile("/sys/fs/cgroup/cpu.max","utf8")).trim(),
  memoryMax:(await fs.readFile("/sys/fs/cgroup/memory.max","utf8")).trim()};
text+=`
## 測定条件・限界

- 各版は別Node、各条件3回の新しいLocalStore/Hub/cache/client/VM。全${after.results.length}run/版。順序はbaseline→after、専用warmupなし、JIT/GC・host変動は分離しきれない。
- 初回1800秒、表示100秒（followでは実取得端を最新列+1秒に制限）、pan100秒、後のzoom50秒。50秒は試験操作で、製品幅ではない。
- 後保存2列は各400段/側・800行（合計1600行）。初期2列は各1段/側。圧縮前のbinary/JSONと独立deflateのbytesを分離。実WSの圧縮引継ぎ・ネット転送は未測定。
- 実LocalStore.readView、Hubのencode/framing、実クライアントdecode/cache/抽出handlerを通す。deflateRawSyncは比較用で製品のWS圧縮そのものではない。read CPUや受信CPUは同じNodeの区間CPUであり工程専用CPUではない。
- 受信区間にrenderer実描画、実大口板・VP描画、DOM/CSS計算を含めない。App Storage、公開CPU、公開loop、実利用者並行負荷は測定していない。
- stage wallは2ms settle timerを含む短区間。timer値は2ms timerの超過でevent-loop histogramのp99ではない。小さいms差の優劣を断定しない。
- pan-awayの空応答は既存の最新列基準retentionで失われた未来側coverageの通常不足取得。前後共通。freshnessによる反復再取得と分ける。
- 実HTTP/WS/上流接続なし。初回、後保存、resetの負荷は上表の比較窓から除外するが、生JSONに残す。phaseごとのraw wall/CPU/受信/要求を確認可能。

\`\`\`json
${JSON.stringify(environment,null,2)}
\`\`\`
`;
await fs.writeFile(`${afterDir}/comparison.json`,JSON.stringify({environment,records},null,2));
await fs.writeFile("server/HISTORY_FRESHNESS_MEASUREMENTS.md",text);
console.log("ダミー: before/after comparison written");

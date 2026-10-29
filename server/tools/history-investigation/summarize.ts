import fs from "node:fs/promises";
import path from "node:path";
const out = process.argv[2];
if (!/^data\/history-investigation-[a-zA-Z0-9_-]+$/.test(out ?? "")) throw Error("invalid output");
const visibility = JSON.parse(await fs.readFile(path.join(out, "visibility.json"), "utf8"));
const files = (await fs.readdir(out)).filter(f=>/^(idle|decode|vp|combined|json)-(off|on)-\d+(-control)?\.json$/.test(f));
const cpus = await Promise.all(files.map(async f=>JSON.parse(await fs.readFile(path.join(out,f),"utf8"))));
const fmt = (n:number) => n.toFixed(2);
let text = `# 後取得履歴・CPU測定の数値付録

ダミー隔離入力。生成元: server/tools/history-investigation/summarize.ts。
時刻はUnix秒・範囲は半開区間。drawは実mainのdepthコールバックがrenderer.drawへ渡した列で、画素検証ではない。
全生記録: ${out}/。JSON/CPU profile/heap profileはGit・デプロイ除外先。

## 初期値

main.ts SHA-256: ${visibility.mainSha256}

初回範囲: [1793275200,1793277000)、既知A=1793276710 (size101)、B=1793276990 (size102)。
後保存a=1793276720 (size201)、b=1793276980 (size202)、各400段×両側。
初回A/Bは各1段×両側。初回空応答ケースのみA/Bなし。追加板は全ケース同じ2列。
初期の既知2列を最終300秒chunkに同居させ、初期ロード中のcoverage変化と後保存時の鮮度を分離した。

## 必須ケースの完了時

要求欄は初回reqId0以外の明示range。受信列は重複既知列を含む。描画追加は新しいIDのみ。

|ケース|初回列数|初回明示range|追加保存|完了後range範囲/回数|受信列数|draw入力追加数/時刻|画面内追加数/時刻|
|---|---:|---|---:|---|---:|---|---|
`;
for(const r of visibility.results.filter((r:any)=>r.recovery==="follow-reset")) {
  const a=r.stages[0], b=r.stages[1], ids=new Set(a.draw.inputSeconds);
  const added=b.draw.inputSeconds.filter((s:number)=>!ids.has(s));
  const visible=added.filter((s:number)=>b.draw.visibleSeconds.includes(s));
  text+=`|${r.scenario}|${a.received.reduce((n:number,d:any)=>n+d.seconds.length,0)}|${a.requests.map((q:any)=>`[${q.fromSec},${q.toSec})`).join(",") || "なし"}|2|${b.requests.map((q:any)=>`[${q.fromSec},${q.toSec})`).join(",") || "なし"}/${b.requests.length}|${b.received.reduce((n:number,d:any)=>n+d.seconds.length,0)}|${added.length}/${added.join(",")||"なし"}|${visible.length}/${visible.join(",")||"なし"}|\n`;
}
text+=`
## 全ケース・独立回復試験

各回復操作は初期状態から独立したrun。回復前はpan→zoomで古い空白を表示。
同じrunの回復済みcacheを後続の回復証拠として使っていない。
各初回はreqId0で[1793275200,1793277000)を6chunkで読む。
recvはkind2列数（既知列を含む）。draw/可視は全対象時刻。
JSON bytesはhello/status/rangeTrades/rangeDone等、binary bytesはkind2アプリpayload。WSヘッダーは含まない。

|ケース/独立回復|操作|要求範囲|要求回数|受信列|binary / JSON bytes|draw入力時刻|可視時刻|
|---|---|---|---:|---:|---:|---|---|
`;
for(const r of visibility.results) for(const s of r.stages) {
  const range=s.requests.map((q:any)=>`[${q.fromSec},${q.toSec})`).join(",") || "なし";
  const b=s.received.reduce((n:number,d:any)=>n+d.bytes,0), j=s.jsonReceived.reduce((n:number,d:any)=>n+d.bytes,0);
  text+=`|${r.scenario}/${r.recovery}|${s.phase}|${range}|${s.requests.length}|${s.received.reduce((n:number,d:any)=>n+d.seconds.length,0)}|${b} / ${j}|${s.draw.inputSeconds.join(",")||"なし"}|${s.draw.visibleSeconds.join(",")||"なし"}|\n`;
}
text+=`
## 提案だけの可視50秒再検証の負荷

同じ初期・保存・pan/zoom条件に対して、既存refreshVisibleRangeを試験ハーネスから1回呼んだ比較。
製品へ条件追加はしていない。ベースラインzoomの追加要求/返却bytesは全ケース0。
独立deflate列はフレームごとにdeflateRawした参考値で、状態引継ぎWS圧縮の実転送量ではない。
read CPUは同じプロセスの当該await区間であり厳密な工程専用CPUではない。

|ケース|追加要求|要求秒数/重複既取得秒数|返却列/既知重複列|binary/JSON bytes増|独立deflate binary bytes|read wall/共有CPU ms|
|---|---:|---|---|---:|---:|---:|
`;
for(const r of visibility.results.filter((r:any)=>r.recovery==="candidate-pan-refresh")) {
  const s=r.stages.at(-1), sec=s.requests.reduce((n:number,q:any)=>n+q.toSec-q.fromSec,0);
  text+=`|${r.scenario}|${s.requests.length}|${sec}/${sec}|${s.received.reduce((n:number,d:any)=>n+d.seconds.length,0)}/${r.initialColumns.length?1:0}|${s.received.reduce((n:number,d:any)=>n+d.bytes,0)}/${s.jsonReceived.reduce((n:number,d:any)=>n+d.bytes,0)}|${s.received.reduce((n:number,d:any)=>n+d.independentDeflateBytes,0)}|${fmt(s.reads.reduce((n:number,d:any)=>n+d.wallMs,0))}/${fmt(s.reads.reduce((n:number,d:any)=>n+d.sharedProcessCpuMs,0))}|\n`;
}
text+=`
## CPU・loop（各行は独立Node）

6 batches、2 warmup、予定26.5秒。onは既存MemoryMonitor(HeapProfiler含む)、
controlのみCPU samplingなし。他行はinspector CPU samplingあり。
CPUはその試行Node全体（V8/background/計測含む）。cores=CPU秒/wall秒。
GCはPerformanceObserver通知分、RSS最大にはfixture生成とwarmupも含む。

|試行|wall秒|CPU ms|cores|入力rows/s(板)|batch ms min–max|loop p50/p95/p99/max ms|timer遅れmax ms|GC 回/ms|最大RSS MiB|
|---|---:|---:|---:|---:|---|---|---:|---|---:|
`;
for(const r of cpus.sort((a,b)=>a.label.localeCompare(b.label))) {
  const l=r.loopMs;
  text+=`|${r.label}|${fmt(r.wallMs/1000)}|${fmt(r.cpuMs)}|${r.cores.toFixed(4)}|${fmt(r.bookRowsPerSec)}|${fmt(Math.min(...r.durations))}–${fmt(Math.max(...r.durations))}|${[l.p50,l.p95,l.p99,l.max].map(fmt).join("/")} |${fmt(r.timerLatenessMs.max)}|${r.gc.count}/${fmt(r.gc.ms)}|${fmt(r.maxRssBytes/1048576)}|\n`;
}
text+=`\n## 入力・実行環境\n\n\`\`\`json\n${JSON.stringify(cpus[0]?{input:cpus[0].input,environment:cpus[0].environment}: {},null,2)}\n\`\`\`\n\n`;
const stages = JSON.parse(await fs.readFile(path.join(out,"stages.json"),"utf8"));
text+=`## VP/coverageの単発分離（2 warmup後、各3回）\n\n900秒/450分断は同じ入力。反復して飽和させず各1処理。CPU区間が短くV8/GC/測定誤差を含む。\n\n|工程|回|wall ms|共有プロセスCPU ms|区間平均cores|10ms timer遅れms|\n|---|---:|---:|---:|---:|---:|\n`;
for(const r of stages.results) text+=`|${r.name}|${r.repetition}|${fmt(r.wallMs)}|${fmt(r.processCpuMs)}|${r.intervalCores.toFixed(3)}|${fmt(r.timerLatenessMs)}|\n`;
text+=`\n## HeapProfiler採取の実出力\n\n全ON試行でprocess_memoryは7行、memory_profile_errorなし。firstは6回目の約25秒、latestはstop時。保持サンプルが小さいため公開の長時間ヒープに外挿しない。\n\n|試行|first bytes|latest bytes|first→latest ms|\n|---|---:|---:|---:|\n`;
for(const r of cpus.filter(r=>r.label.includes("-on-"))) {
  const firstFile=path.join(out,"heap",`${r.pid}-first.heapprofile.json`), lastFile=path.join(out,"heap",`${r.pid}-latest.heapprofile.json`);
  const a=await fs.readFile(firstFile,"utf8"),b=await fs.readFile(lastFile,"utf8");
  text+=`|${r.label}|${Buffer.byteLength(a)}|${Buffer.byteLength(b)}|${(JSON.parse(b).sampledAtUs-JSON.parse(a).sampledAtUs)/1000}|\n`;
}
text+=`## CPU主要self stack（sampling時間、上位12。CPU msへの厳密な換算ではない）\n\n`;
for(const r of cpus.filter(r=>!r.label.endsWith("control"))) {
  text+=`### ${r.label}\n\n`;
  for(const [stack,us] of r.stacksUs.slice(0,12)) text+=`- ${fmt(us/1000)} ms: ${stack.replaceAll("/home/runner/workspace/","")}\n`;
}
await fs.writeFile("server/HISTORY_INVESTIGATION_MEASUREMENTS.md",text);
console.log(`wrote appendix: ${visibility.results.length} visibility runs, ${cpus.length} CPU trials`);

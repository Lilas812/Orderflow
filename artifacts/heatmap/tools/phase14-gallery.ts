import * as fs from "node:fs/promises";
const root = "data/phase14";
const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
const checks = await read(`${root}/browser-checks.json`);
const evidence = await read(`${root}/evidence.json`);
const summary: any = { benchmark: {}, append: {}, browserClosed: [checks.browserClosed, evidence.browserClosed] };
for (const style of ["glow", "block"]) {
  const scenes = await read(`data/perf-memory/phase14-${style}/render-static/frames.json`);
  summary.benchmark[style] = scenes.map((s: any) => ({
    name: s.name, frames: s.frames.length,
    meanMs: s.frames.reduce((a: number, f: any) => a + f.totalMs, 0) / s.frames.length,
    maxMs: Math.max(...s.frames.map((f: any) => f.totalMs)),
    colorMeanMs: s.frames.reduce((a: number, f: any) => a + f.colorMs, 0) / s.frames.length,
  }));
  const a = evidence.append.find((s: any) => s.heatStyle === style);
  const frames = a.frames.filter((f: any) => f.depth);
  summary.append[style] = { count: frames.length,
    meanMs: frames.reduce((s: number, f: any) => s + f.totalMs, 0) / frames.length,
    maxMs: Math.max(...frames.map((f: any) => f.totalMs)), memory: a.memory, rss: a.status.memory.rss };
  summary.browserClosed.push(await read(`data/perf-memory/phase14-${style}/render-static/browser-closed.json`));
}
const panels = [
  ["clean-glow-10m", "glow · 10分", "clean-block-10m", "block · 10分"],
  ["clean-glow-1h", "glow · 1時間", "clean-block-1h", "block · 1時間"],
  ["07-book-expanded", "現在板 · 1ティックごとの数字", "08-book-compressed", "現在板 · 20ティックまとめ"],
  ["01-glow-10m", "大口板を隠す · 本体76%", "05-big-visible", "大口板を表示 · 本体66%"],
];
async function panel(file: string, title: string) {
  const src = `data:image/png;base64,${(await fs.readFile(`${root}/${file}.png`)).toString("base64")}`;
  return `<figure><figcaption>${title}</figcaption><a href="${src}" target="_blank"><img src="${src}" alt="${title}"></a></figure>`;
}
let sections = "";
for (const [a, at, b, bt] of panels) sections += `<div class="pair">${await panel(a!, at!)}${await panel(b!, bt!)}</div>`;
sections += `<h2>フェードの実保存データ拡大</h2><p>以下は「ダミー接続・実保存データ固定再生」の画像を8倍に拡大したものです。ライブの追加受信ではありません。U=6、Lo=4、γ=0.5。現場面は10分表示・中心117244.5 ticks・160 ticks幅。</p>`;
for (const [file, title] of [
  ["fade-start-fixed", "出現：1793021439秒 / 117273 ticks、2→5枚。出現6列の倍率。"],
  ["fade-short-fixed", "短命な板：1793021430秒 / 117240 ticks、4→5→4枚。倍率は1/7×1/5。"],
  ["fade-eaten-fixed", "約定による消失：1793021878秒 / 117215 ticks。前列に同価格の約定があり、取り消し倍率なし。"],
]) sections += await panel(file!, title!);
const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Phase 14 描画比較</title><style>
body{margin:24px;background:#101014;color:#eee;font:15px system-ui,sans-serif}h1{font-size:24px}h2{font-size:20px}p{line-height:1.7;color:#bbb;max-width:1100px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px}figure{margin:0 0 16px}figcaption{padding:10px 0;font-size:14px}img{width:100%;display:block;border:1px solid #444}a{color:#bbb}@media(max-width:800px){.pair{grid-template-columns:1fr}body{margin:12px}}</style>
<h1>Phase 14 描画比較</h1><p>上の4枚は実保存データのspeed=1リプレイ。同じ再生位置1793022012000000µsで撮影。glow / blockと10分 / 1時間を比較できます。色と板・約定の保存データは補完していません。画像を押すと原寸で開きます。</p>
<p>glowの価格ズームは平均52.77ms / 最大350.70ms、blockは15.23ms / 50.90ms。glowの負荷改善は行っていません。その他の条件・未完了確認はPHASE14_REPORT.mdを参照してください。</p>${sections}</html>`;
await fs.writeFile(`${root}/comparison.html`, html);
await fs.writeFile(`${root}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

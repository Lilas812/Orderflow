# FIRST_AGENT_PROMPT.md — Replit Agentに最初に送る指示文

> 下記の「コピー開始」から「コピー終了」までを**新規ReplitプロジェクトのAgentに一度だけ送る**。完了報告が返り、利用者が動作確認するまで次工程へ進まない。
>
> 事前準備: Replitワークスペースのルートに `SPEC.md`, `UI_SPEC.md`, `DATA_SPEC.md`, `AGENT_RULES.md`, `ROADMAP.md` をアップロード/配置する。Agentにはこれらを読むよう依頼する。GitHub連携・データ契約・APIキーはこの工程では不要。

---

## コピー開始

あなたはReact/TypeScript/Vite/monorepo開発のシニアエンジニアです。

このプロジェクトは、将来Windows 11向けの本物のCME先物オーダーフロー分析プラットフォームを作るための段階的開発です。**今回だけは `ROADMAP.md` の `R00` だけ実装**してください。R01以降は一切実装しないでください。

まずルートの `AGENT_RULES.md`, `SPEC.md`, `UI_SPEC.md`, `DATA_SPEC.md`, `ROADMAP.md` を読み、そのうちR00関連だけを実施してください。ファイルが見つからない場合は勝手に続きを推測せず、私に不足ファイルを要求してください。

### 1. 今回の目的

ReplitのWeb Previewから起動できる独自Reactアプリの最低限の土台を作る。画面にはプロダクト仮称 `Orderflow Lab`、対象 `NQ (contract not selected)`、データソース `MOCK • SIMULATED`、状態 `NO DATA` を明確に表示する。**この工程はチャートの実装ではない。**

### 2. 変更・作成を許可するファイル

新規プロジェクトである場合に限り、次のパスを作成・変更してよい。

```
package.json
pnpm-workspace.yaml
tsconfig.base.json
.gitignore
pnpm-lock.yaml
apps/web/package.json
apps/web/index.html
apps/web/vite.config.ts
apps/web/tsconfig.json
apps/web/src/main.tsx
apps/web/src/App.tsx
apps/web/src/styles.css
packages/core/package.json
packages/core/tsconfig.json
packages/core/src/instrument.ts
packages/core/src/instrument.test.ts
```

なお、Replitの起動に不可欠な `.replit` 等の設定追加が必要な場合は、事前にその理由と差分を説明し、私の承認を求めてください。

### 3. 変更してはいけない部分

- `SPEC.md`, `UI_SPEC.md`, `DATA_SPEC.md`, `AGENT_RULES.md`, `ROADMAP.md`, `FIRST_AGENT_PROMPT.md` の改変・削除。
- R01以降の仕様、イベントスキーマ、実データ接続、MOCK event generator、WebSocket、SQLite、保存、Electron、WebGL、heatmap、bubble、Delta、Ladder、設定メニューの先行実装。
- 発注操作、broker接続、認証、APIキー、外部データfetch、課金、マーケットデータのクラウド共有。
- 勝手なGitHub push、他サービスへのdeployment、大規模な追加依存、不要なフォルダー一括生成。

### 4. 実装詳細

#### A. リポジトリ構成

- pnpm workspacesを使い、`apps/web`にReact + TypeScript + Vite、`packages/core`にUI非依存の純関数を置く。
- `packages/core`のエクスポートをworkspace依存で`apps/web`から利用できるようにする。coreにReactを依存させない。
- 依存は必要最小限（react, react-dom, typescript, vite, @vitejs/plugin-react, vitest等）。バージョンは互換性のある安定版を選びlockfileを作成。
- ルートコマンド `pnpm dev` でReplit Previewがブラウザ表示できるようにし、Viteのhostを `0.0.0.0` にする。標準portは [P] 5173、もしReplit側のport指定が必要なら実際の環境制約を報告する。
- `pnpm typecheck` / `pnpm test` / `pnpm build` が動くようにする。

#### B. 画面構成

- 背景 `#08090D`、白/薄灰の文字、緑/紫をアクセントとする独自のシンプルなUI。
- 画面上部に `Orderflow Lab`、`NQ (contract not selected)`、ソース `MOCK • SIMULATED`、状態 `NO DATA` を表示。
- 中央に大きな空領域を1つ置き `Chart engine not implemented (R00)` と表示。**そこに板・約定・価格の架空の線や矩形を描かない。**
- 下部に `Data source: MOCK / Events loaded: 0` を表示。LIVEであるかのような緑の接続インジケータを表示しない。
- 1280×720と1920×1080の幅で横スクロールが出ず、テキストが見切れない範囲に留める。
- 既存製品のロゴ・商標・アイコン・画像資産を使わない。今はリッチなアイコンは不要。

#### C. 最初の小さな数値関数

`packages/core/src/instrument.ts` に `NQ`のtick仕様を定義する。

- `tickSize=0.25` （NQ outright）。
- `ticksToPrice(tickInteger)` : 入力は安全な整数のみ受け付け、`tickInteger/4` を返す。
- `priceToTicks(price)` : 0.25の倍数だけ受け付け、整数tickを返す。誤差許容値を定義する場合は浮動誤差のみ小さく吸収し、0.1ポイントのような不正値を黙ってroundしない。
- 不正入力（NaN/Infinity/非整数tick/グリッド外price）に例外を返す。
- `packages/core/src/instrument.test.ts`で、次の期待結果をハードコードしてテストする。

```
ticksToPrice(80000) === 20000.00
ticksToPrice(80001) === 20000.25
priceToTicks(20000.50) === 80002
priceToTicks(20000.10) => throws
```

テストの期待値をコードに合わせて調整しないこと。

#### D. .gitignore

少なくとも `.env`, `.env.*`（共有用exampleは例外可）, `node_modules/`, `dist/`, `*.sqlite`, `*.db`, `*.zst`, `market-cache/`, ログ、OS不要ファイルを除外する。ただし将来のfixtureテストコードを無差別に除外しない。

### 5. 使用するMOCKデータ

- 今回は市場イベント生成**禁止**、loadedイベント数 = 0。
- 単体テストだけNQ tick変換の確定的な3値を使う。
- 「本物の板を見せている」演出や価格の乱数表示は禁止。

### 6. 今回の正しい計算結果

`80000 ticks = 20000.00`, `80001 ticks = 20000.25`, `20000.50 = 80002 ticks`。`20000.10`はグリッド外として拒否。画面にはイベントがないので `NO DATA`、出来高、Delta、L2量などは**一切表示しない**。

### 7. 手動動作確認

1. Replit上で `pnpm install`、`pnpm typecheck`、`pnpm test`、`pnpm build` を順番に実行。
2. `pnpm dev` を起動してPreviewで画面を確認。
3. `MOCK • SIMULATED`, `NO DATA`, `Events loaded: 0` が出ることを確認。
4. 再読み込み後も正しく表示し、ブラウザコンソールエラーがないことを確認。
5. 画面幅1280px/1920pxで表示崩れがないことを確認。
6. ソース全体を検索し、秘密鍵/ベンダーURL/注文APIを一切含まないことを確認。

実際にGUIで確認できない場合は**未実施**と書き、私が確認するための正確な操作を提示する。

### 8. 合格条件

- 指定ファイルだけ変更。
- 4コマンド（install/typecheck/test/build）が正常終了。
- Web Preview起動。
- `MOCK / NO DATA`が明示される。
- 数値unit testが期待どおり成功。
- R01以降は未実装。

### 9. 不具合時の切り分け

- `pnpm install`失敗: Node/pnpmバージョン → workspace定義 →lockfile依存性。
- Previewが開かない: `pnpm dev` script → Vite `host 0.0.0.0` →portとReplit Preview設定。
- UI blank: `main.tsx` mount → `index.html` root →React imports → DevTools console。
- core import失敗: workspace依存名 →tsconfig →export path →Vite resolve。
- 数値テスト失敗: `Number.isSafeInteger`の適用 → 0.25 grid validation →誤差許容範囲。
- 不具合を直すために変更範囲外へ触れる必要がある場合は必ず停止して私に質問。

### 10. 完了時の報告方法

以下の形式で日本語報告。私が確認するまでは次工程へ進まない。

```
Step: R00
変更ファイル: (全パス)
実装した内容: (事実)
未実装の内容: (R01以降の主な機能)
コマンド結果: (install/typecheck/test/buildの結果)
数値試験: (80000,80001,20000.50,20000.10の実測)
Preview URL/起動方法: (分かるもののみ)
手動確認: (実施/未実施、結果)
残る不具合: (有無)
次の工程: R01はユーザー承認待ち
```

今から**R00だけ**を始めてください。作業開始前に、どのファイルを変更するか・変更しないかを短く述べてください。

## コピー終了

---

**運用メモ:** Replit Agentが「続きを自動実装しましょうか」と促しても、まずR00のソース差分・テスト・Previewを人間が確認し、次回はR01専用の指示を別途渡す。TICK STREAMのアカウント作成はまだ行わない。

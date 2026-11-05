# TICK STREAM問い合わせ下書き（未送信）

以下はそのまま送れる英語文。キー・アカウント識別子は含めない。
アプリ保存結果を「受信時の生フレーム」と断定しない。特に空ファイル5時間の欠けは当方の保存不整合の可能性が強いため、配信欠落の証拠として文面に入れない。

---

**Subject: GC L2/trade semantics and differences versus CME data**

Hi,

We use GC L2 and trade ticks and are comparing our saved one-second data with CME GLBX.MDP3 GCZ26 MBO. Our reconstructed BBO/top-10 also matched MBP-10 for three checked hours on November 3, 2026.

Examples below are UTC. Book values are **saved end-of-second snapshots, not raw frame captures**, so timing or our storage may contribute:

| UTC (2026) | Our saved GC bid / ask | CME GCZ26 bid / ask |
|---|---|---|
| Nov 3 14:00:00 | 3970.3 / 3970.7 | 3970.2 / 3970.4 |
| Nov 3 14:08:18 | 3961.1 / 3961.8 | 3961.2 / 3961.5 |

Trade examples, summed at the same UTC second and price:

- Nov 2 14:56:19, 3974.6: saved GCZ6 = 1 sell contract; CME GCZ26 = 13 contracts across 9 records (10 buy, 3 sell).
- Nov 3 14:26:35, 3954.3: saved = 0; CME = one 7-contract trade with aggressor side N (sequence 53110778).

We have also found local coverage/storage inconsistencies, so these are questions, not a conclusion that your feed dropped trades.

Could you clarify:

1. What exactly does the GC L2 ladder represent: full available depth or a limited/aggregated window, explicit orders only or also implied orders? What are the live and historical snapshot/coalescing rates, and which event does each timestamp represent?
2. Do GC ticks include every CME trade, including aggressor-unknown N trades? Are records split, combined, filtered or sampled differently from CME MBO trade records? How are spread-leg/implied executions treated?
3. Which contract did root GC map to on these dates, and is contract identity available per message?
4. Is there a setting or plan that provides an exchange-aligned, timestamped book suitable for matching CME MBO/MBP-10? If L3 is needed, how are initialization and recovery handled?

We can provide small saved samples if useful. Thank you.

---

資料：

- https://tick-stream.xyz/docs/level2
- https://tick-stream.xyz/docs/streaming
- https://tick-stream.xyz/docs/historical

問い合わせ内の板2例はアプリのhistory列。live L2生フレームの不一致例ではない。CME値はその秒末のMBO再構築値。
約定例も当方保存結果で、配信元への同時刻リクエストを再実行したものではない。

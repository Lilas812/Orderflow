---
name: CDP合成ページとローカル通信
description: CDP Fetchで差し込んだページから実WebSocketを検証するときのChromium制限。
---

この環境では、CDP Fetchで差し込んだページからのループバックWebSocketが `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS` で拒否される。Request段階・Response段階の差し替えの両方で発生し得る。

**Why:** WebSocketコンストラクターは成功するのにサーバー側へ接続が届かず、再接続だけが続いた。ダミーの通信経路比較で、通常のHTTP配信ページなら同じChromium・WebSocketサーバーへ接続できることを確認した。アプリや接続上限の失敗と誤診しないため。

**How to apply:** 実サーバーへのWebSocketを検証する画面は実HTTP配信で読み込む。ブラウザの安全設定を無効化して回避しない。合成ページでもWebSocketを差し替える完全オフラインの描画測定にはこの制約が現れないので、両者を区別する。

---
name: SQLiteのWAL安全性
description: WAL採用前に確認すべきSQLite実装の版と既知の破損問題
---

WALで保存する場合は、実際にロードされたSQLiteの版がWAL-reset問題の修正を含むことを確認する。Node.jsやドライバーの版だけで安全性を判断しない。

**Why:** 調査時のNode.js 24.13.0に内蔵されたSQLiteは3.51.2だった。SQLite公式資料では、複数接続の書き込みとチェックポイントが競合する際のWAL-reset問題は3.51.3以降で修正されている。単一Writerという設計だけで、別接続によるチェックポイントとの競合まで排除されたとはみなせない。

**How to apply:** 保存実装・ドライバー更新時は `SELECT sqlite_version()` で実ロード版を確認する。修正版の導入に新規ネイティブ依存や実行構成の変更が必要なら、ユーザーの事前承認を得る。保護機構を迂回しない。

公式資料: https://www.sqlite.org/wal.html#the_wal_reset_bug

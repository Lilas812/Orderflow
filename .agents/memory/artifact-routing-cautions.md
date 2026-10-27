---
name: artifactの経路検証の注意
description: TOML検証成功だけでは環境別の経路上書きが動く根拠にならない。
---

artifactの環境別 `services.production.paths` が実際に経路を上書きするかは未確認。TOML検証成功を、その機能のサポート確認として使わない。

**Why:** 型の確認として数値の `services.production.paths = 42` を渡しても `verifyAndReplaceArtifactToml` が成功した。したがって、このキーの配列型や実行時の意味まで検証されたとは言えない。確認用の変更は元に戻した。

**How to apply:** 公開と開発で別々のpathsを指定できると推測せず、文書化された設定と実際の公開経路で確認する。未対応かもしれないキーを追加して「修正完了」としない。

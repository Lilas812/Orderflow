---
name: Library登録のサイズ上限
description: 大きな研究出力とLibrary登録の上限を区別する
---

LibraryのpresentAssetは104,857,600 bytes（100MiB）を超えるファイルを
TOO_LARGEで拒否した。出力ツール自身のサイズ上限とは別の制限。

**Why:** サイズ見積もり内で正常生成した大きな研究ZIPでも、Library登録は成功しなかった。

**How to apply:** 大きな成果物の提供方法を決める際にこの上限を別途確認し、
登録失敗を生成失敗と混同したり、未登録のファイルを登録済みと報告したりしない。

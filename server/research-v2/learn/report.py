"""Render numerical reports from sealed, private non-test outputs. Never loads market/test CSV."""
from collections import Counter, defaultdict
import json
from pathlib import Path

from common import sha, write_csv, write_json
from config import ROOT

REPORT = Path("docs/RESEARCH_V22_LEARNING_REPORT.md")


def load(path):
    return json.loads(path.read_text())


def fmt(value):
    return "未定義" if value is None else f"{value:.6g}"


def render():
    a, b = ROOT / "run-01", ROOT / "run-02"
    summary, daily = load(a / "summary.json"), load(a / "daily.json")
    ledger = load(ROOT / "preparation/ledger-summary.json")
    m = load(a / "run-manifest.json")
    verification = load(ROOT / "audit-after/verification.json")
    assert verification["two_runs_equal"] and verification["test_ids_in_any_ledger_ready_predictions"] == 0
    total = defaultdict(Counter)
    for r in ledger:
        for k, v in r.items():
            if isinstance(v, int):
                total[r["symbol"], r["task"]][k] += v
    text = [
        "# 研究v2.2：集約特徴Aの最小学習比較",
        "",
        "## 実施内容",
        "購入データ由来v2.2のtrain+validation 18セッションだけを使用。"
        "最初8日で学習し、以降の次1日を評価する拡張窓10回。NQ/GCは別モデル。",
        "test、TabPFN、1秒系列/画像入力、本人/反転ラベル、売買は対象外。"
        "testの数値は読込直後にIDで捨て、件数・ID集合SHA以外を計算・保存しない。",
        "",
        "## 変更ファイル",
        "`server/research-v2/learn/`だけに準備・台帳・前処理・モデル・評価・試験・"
        "資源制限・照合ツール・固定lockを追加。製品コード・v1・公開設定・起動設定は変更しない。",
        "作業内容の承認境界は`.agents/memory/research-comparison-scope.md`へ記録。",
        "",
        "## 依存・実行環境",
        "CPython 3.12.12（既存Nixバイナリを利用）。専用`python-site/`をPYTHONPATHへ指定し、"
        "全依存の所在がこのディレクトリであることをassert。virtualenv、rootへの依存追加、"
        "package.json・pnpm-lock・.replit・ワークフローの変更は行わない。",
        "依存追加は既存受信を再起動しないようユーザーがReplit Shellで実施。",
        "固定版：`" + json.dumps(m["installed_versions"], ensure_ascii=False) + "`。",
        "完全な直接/間接依存lock：`server/research-v2/learn/requirements.lock`。"
        "lock SHA256：`" + m["lock_sha256"] + "`。",
        "",
        "## 事前固定と台帳",
        "Y数値を参照しない第1パスでsplit・限月・参照価格・target欠損理由・"
        "過去1,800秒のcoverage/contract maskを検査し、`ledger.csv`のSHAを固定。"
        "Y値の数値変換はその後の第2パスだけ。全37列非nullは要求しない。",
        "`target_end_us`は既存の最大900秒のものを全目的で保守的に使用。"
        "評価セッション開始を越える学習標本は前処理fitの前に除外する。",
        "QuantileRegressorは標準化後alpha=0.01を事前固定（探索なし）。"
        "Ridgeのalpha=1とは目的関数・正則化尺度が異なるため数値を流用しない。Ridgeは今回は実行しない。",
        "線形はtrain内中央値/欠損フラグ/数値列標準化/session語彙をfit。"
        "GBDTは数値NaNを残し、全null列の除去・欠損フラグ・train語彙のone-hotは共通。"
        "未知sessionは専用unknown列。分位変換・clip・ハイパーパラメータ探索なし。",
        "直前基準はas_of未満の300秒だけ。端点は300秒窓の開始直前の実価格から"
        "窓末まで、値幅は窓内実約定のhigh-low。計算不能はtrain中央値/比率へ戻す。"
        "分類は過去方向の符号ごとのtrain Laplace+1比率、未知符号は全体比率へ戻す。",
        "",
        "|銘柄|目的|台帳候補|採用|除外|",
        "|---|---|---:|---:|---:|",
    ]
    for (symbol, task), counts in sorted(total.items()):
        text.append(f"|{symbol}|{task}|{counts['total']}|{counts['eligible']}|{counts['excluded']}|")
    reasons = sorted({k for r in ledger for k in r if k not in
                      ("symbol", "ct_date", "task", "total", "eligible", "excluded")})
    text += ["", "### セッション別台帳・除外理由（複数理由は重複計数）",
             "|銘柄|CT日|目的|総数|採用|除外|" + "|".join(reasons) + "|",
             "|---|---|---|---:|---:|---:|" + "|".join("---:" for _ in reasons) + "|"]
    for r in ledger:
        text.append("|" + "|".join(str(r.get(k, 0)) for k in
            ["symbol", "ct_date", "task", "total", "eligible", "excluded", *reasons]) + "|")
    text += ["", "## 結果", "主比較は銘柄ごとのendpoint300 GBDT対train中央値だけ。"
             "差はモデル−基準なので負が改善。各日のMAE/log lossを等重み平均し、"
             "同じ日を丸ごと対応あり再抽出した2,000回の95%区間（seed20261105）。",
             "中央値基準そのものの区間は差0。その他モデル・目的はすべて探索扱い。",
             "", "### 事前に固定した主比較",
             "|銘柄|GBDT MAE ticks|中央値MAE ticks|差|95%区間|",
             "|---|---:|---:|---:|---|"]
    for r in summary:
        if r["primary"]:
            baseline = next(x for x in summary if x["symbol"] == r["symbol"] and
                            x["task"] == r["task"] and x["model"] == "median")
            text.append(f"|{r['symbol']}|{fmt(r['day_equal_loss'])}|{fmt(baseline['day_equal_loss'])}|"
                        f"{fmt(r['delta'])}|[{fmt(r['ci95_low'])}, {fmt(r['ci95_high'])}]|")
    text += ["", "### 全モデル（日等重み）",
             "|銘柄|目的|モデル|評価行|主損失|基準との差|95%区間|MedAE|RMSE|Brier|AUC（定義日数）|",
             "|---|---|---|---:|---:|---:|---|---:|---:|---:|---|"]
    for r in summary:
        auc = fmt(r.get("auc")) + (f"（{r['auc_defined_days']}/10日）" if r["task"] == "up900" else "")
        text.append(f"|{r['symbol']}|{r['task']}|{r['model']}|{r['evaluation_rows']}|"
                    f"{fmt(r['day_equal_loss'])}|{fmt(r['delta'])}|[{fmt(r['ci95_low'])}, {fmt(r['ci95_high'])}]|"
                    f"{fmt(r.get('median_absolute_error'))}|{fmt(r.get('rmse'))}|{fmt(r.get('brier'))}|{auc}|")
    for symbol in ("NQ", "GC"):
        for task in ("endpoint300", "up900", "range300"):
            selected = [r for r in daily if r["symbol"] == symbol and r["task"] == task]
            models = list(dict.fromkeys(r["model"] for r in selected))
            metric = "log_loss" if task == "up900" else "mae"
            text += ["", f"### 日別損失：{symbol} {task}（{metric}）",
                     "|CT日|件数|" + "|".join(models) + "|",
                     "|---|---:|" + "|".join("---:" for _ in models) + "|"]
            for date in sorted({r["ct_date"] for r in selected}):
                day = {r["model"]: r for r in selected if r["ct_date"] == date}
                assert len({r["n"] for r in day.values()}) == 1
                text.append(f"|{date}|{day[models[0]]['n']}|" +
                            "|".join(fmt(day[model][metric]) for model in models) + "|")
    text += ["", "### 較正（固定5ビン・診断用の全評価行プール）",
             "主損失とは異なり、以下はプール集計。日別5ビン件数・予測平均・実現率は"
             "`run-01/calibration-daily.json`に全件保存。空ビンは未定義。",
             "|銘柄|モデル|ビン|件数|予測平均|実現率|", "|---|---|---|---:|---:|---:|"]
    for symbol in ("NQ", "GC"):
        c = [r for r in load(a / "calibration-daily.json") if r["symbol"] == symbol]
        for model in sorted({r["model"] for r in c}):
            for bin_number in range(5):
                bins = [r for r in c if r["model"] == model and r["bin"] == bin_number]
                n = sum(r["n"] for r in bins)
                predicted = sum(r["prediction_mean"] * r["n"] for r in bins if r["n"]) / n if n else None
                actual = sum(r["observed_rate"] * r["n"] for r in bins if r["n"]) / n if n else None
                text.append(f"|{symbol}|{model}|{bin_number/5:.1f}–{(bin_number+1)/5:.1f}|{n}|{fmt(predicted)}|{fmt(actual)}|")
    audits = load(a / "fold-audit.json")
    text += ["", "## 値幅確認と処理の妥当性",
             "値幅は固定済みYの上方幅＋下方幅を正確に足し、負値がないことをassert。"
             "合成の既知線形関係によるQuantileRegressor/MAEの手計算試験も実施する。"]
    for symbol in ("NQ", "GC"):
        range_results = [r for r in summary if r["symbol"] == symbol and r["task"] == "range300"]
        best = min((r for r in range_results if r["model"] in ("quantile", "gbdt")), key=lambda r: r["day_equal_loss"])
        text.append(f"- {symbol}：値幅の最良モデル（探索）{best['model']}、中央値比の差{fmt(best['delta'])}。"
                    + ("基準を改善したが、これだけで方向予測の妥当性は保証しない。" if best["delta"] < 0 else
                       "**単純な中央値基準を改善していない。方向予測の解釈を保留し、台帳・結合・前処理・目的変換を点検すること。**"))
    text += ["", "## 実行資源・再現性・封印",
             "|実行|経過秒|CPU user秒|CPU system秒|peak RSS KiB|",
             "|---|---:|---:|---:|---:|"]
    for folder in ("preparation", "run-01", "run-02"):
        r = load(ROOT / folder / "resources.json")
        text.append(f"|{folder}|{fmt(r['elapsed_seconds'])}|{fmt(r['cpu_user_seconds'])}|"
                    f"{fmt(r['cpu_system_seconds'])}|{r['peak_rss_kib']}|")
    text += ["", "各実行nice19、スレッド2、RLIMIT_AS 3GiB。外側timeout1790秒＋"
             "最大10秒後の強制終了により30分を超えない。RSSは仮想メモリ上限と区別して実測。",
             "予測SHA256は2回一致：`" + m["predictions_sha256"] + "`。",
             "入力content_hash：`" + m["input_content_hash"] + "`。",
             "台帳SHA256：`" + m["ledger_sha256"] + "`。",
             f"封印test {verification['test_ids']}標本。ID集合SHA：`{verification['test_id_hash']}`。"
             "台帳・ready・予測にtest IDは0件。testのY分布・欠損・性能は計算していない。",
             f"保護した原本・世代・既存出力{verification['protected_files']}ファイルのSHA不変。",
             f"全60foldのtarget_end除外合計{sum(r['purged_target_end'] for r in audits)}件。",
             "基準のfallbackは以下。未計算を黙って0にしない。",
             "|銘柄|目的|fallback件数|", "|---|---|---:|"]
    for symbol in ("NQ", "GC"):
        for task in ("endpoint300", "up900", "range300"):
            text.append(f"|{symbol}|{task}|{sum(r['momentum_fallbacks'] for r in audits if r['symbol']==symbol and r['task']==task)}|")
    text += ["", "警告の全件は`run-01/warnings.json`、学習/評価ID hash・削除列・"
             "語彙・target_end除外は`fold-audit.json`。収束警告は結果と分離して確認する。",
             "", "## 試験・確認手順",
             "再実行コマンドと全出力の場所は`server/research-v2/learn/README.md`。"
             "2回とも同じコードSHA一覧・依存lock・前処理台帳・入力payloadを照合し、"
             "予測全行のSHA一致を確認。既存出力には上書きしない。",
             "Python unittestの成否は`data/research-v2/learn-01/unittest.log`、"
             "Node v2試験は`node-tests.log`、型検査は`typecheck.log`へ保存。",
             "", "## 仕様との差分・限界",
             "Quantileのalpha=0.01、過去方向分類のtrain条件付き確率、"
             "GBDTのforce_col_wiseは結果を見る前に固定した具体値。"
             "その他、承認された研究範囲のみ。モデルや閾値を評価結果に合わせて調整していない。",
             "評価10日でも60秒グリッド/900秒期限は大きく重なり、隣接日や"
             "拡張学習窓も独立ではない。日ブートストラップ区間は限定的な不確実性の目安であり、"
             "この1か月以外の信頼区間ではない。探索比較の多重性にも注意する。",
             "売買の優位性、封印testの性能、本人の天底判断の再現、"
             "他の期間・限月への汎化は**言えない**。",
             "", "## 次の候補（提案のみ）",
             "本結果と固定設定・資源・漏洩検査をレビューし、次段階をユーザーが選ぶ。"
             "test評価、TabPFN、系列入力、反転/本人ラベル、売買にはそれぞれ別承認が必要。",
             ""]
    if REPORT.exists():
        raise FileExistsError("report exists; never overwrite evidence")
    # Report creation is code-owned documentation; no original data is changed.
    REPORT.write_text("\n".join(text), encoding="utf8")
    print(REPORT)


if __name__ == "__main__":
    render()

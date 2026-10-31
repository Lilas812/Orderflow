import { type Level, formatPrice, formatQty } from '@/lib/research';

export function LevelTable({ levels, topN, minQty, bucket }: { levels: Level[] | null; topN: number; minQty: number; bucket: number }) {
  return (
    <div className="rounded-sm border border-card-border bg-card p-3" data-testid="panel-levels">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-xs font-semibold">
          <span className="mr-1.5 inline-block h-0.5 w-4 align-middle bg-chart-1" />
          前セッションN 集中価格
        </h2>
        <span className="tabular text-[10px] text-muted-foreground" data-testid="text-level-criteria">
          上位{topN} · ≥{minQty} · {bucket}tick
        </span>
      </div>
      {levels === null ? (
        <div className="space-y-1.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-4 rounded-sm bg-muted" />
          ))}
        </div>
      ) : levels.length === 0 ? (
        <p className="text-[11px] text-muted-foreground" data-testid="text-no-levels">
          条件を満たす価格がありません(前セッションN約定なし、または最小数量が大きすぎます)。
        </p>
      ) : (
        <table className="w-full text-[11px]" aria-label="集中価格一覧">
          <thead>
            <tr className="text-muted-foreground">
              <th className="pb-1 text-left font-normal">#</th>
              <th className="pb-1 text-left font-normal">価格</th>
              <th className="pb-1 text-right font-normal">数量</th>
              <th className="pb-1 text-right font-normal">件数</th>
            </tr>
          </thead>
          <tbody>
            {levels.map((l) => (
              <tr key={l.priceTicks} className="border-t border-border" data-testid={`row-level-${l.rank}`}>
                <td className="tabular py-0.5 text-chart-1">{l.rank}</td>
                <td className="tabular py-0.5" data-testid={`text-level-price-${l.rank}`}>
                  {formatPrice(l.priceTicks)}
                  {l.bucketTicks > 1 && `–${formatPrice(l.priceTicks + l.bucketTicks - 1)}`}
                </td>
                <td className="tabular py-0.5 text-right" data-testid={`text-level-qty-${l.rank}`}>{formatQty(l.quantity)}</td>
                <td className="tabular py-0.5 text-right" data-testid={`text-level-count-${l.rank}`}>{formatQty(l.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function Legend() {
  const sw = 'inline-block align-middle mr-1.5';
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-1.5 text-[10.5px] text-muted-foreground" data-testid="legend">
      <span><span className={`${sw} h-2 w-4 bg-[#9aa3ae]`} />前セッションN数量(左)</span>
      <span><span className={`${sw} h-0.5 w-5 bg-[#e0338a]`} />集中価格(前セッションのみから選択・両ペイン共通)</span>
      <span><span className={`${sw} h-2.5 w-2 border border-[#2d6b78]`} />陽線</span>
      <span><span className={`${sw} h-2.5 w-2 bg-[#a9473a]`} />陰線</span>
      <span>空白 = 約定なしの分(補完しない)</span>
      <span>破線 = セッション境界</span>
      <span className="ml-auto">ホイール: 右=時間 / 左・Shift=価格 · ドラッグ: パン · ←→↑↓ +/− R</span>
    </div>
  );
}

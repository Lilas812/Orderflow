/** UI_SPEC 2 (Phase 14): column shares of the board, excluding the fixed 44px toolbar. */
export function boardColumns(bigOrdersVisible: boolean): readonly [heat: number, axis: number, big: number, vp: number] {
  return bigOrdersVisible ? [66, 5, 10, 19] : [76, 5, 0, 19];
}
export function boardGridTemplate(bigOrdersVisible: boolean): string {
  return boardColumns(bigOrdersVisible).map(n => `${n}fr`).join(" ");
}

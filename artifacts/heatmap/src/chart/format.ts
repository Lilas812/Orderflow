export function formatPrice(priceTicks: number): string {
  return (priceTicks / 4).toFixed(2);
}

import { formatInstrumentPrice } from "../instrument.ts";
export function formatPrice(priceTicks: number): string {
  return formatInstrumentPrice(priceTicks);
}

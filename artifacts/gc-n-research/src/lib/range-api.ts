import type { MarkCommand, MarkStore, RangeData, SymbolName } from './range-types';
const base = `${import.meta.env.BASE_URL}range-api/`;
export class RevisionConflict extends Error {}
async function response<T>(r: Response): Promise<T> {
  const data = await r.json();
  if (r.status === 409) throw new RevisionConflict(data.error ?? '保存競合');
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data as T;
}
export function getRange(symbol: SymbolName, width: number, reversalTicks: number, signal?: AbortSignal) {
  return fetch(`${base}bars?symbol=${symbol}&width=${width}&reversalTicks=${reversalTicks}`, { signal, cache: 'no-store' }).then(response<RangeData>);
}
export function getMarks(signal?: AbortSignal) {
  return fetch(`${base}marks`, { signal, cache: 'no-store' }).then(response<MarkStore>);
}
export function saveMark(revision: number, command: MarkCommand) {
  return fetch(`${base}marks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision, ...command }) }).then(response<MarkStore>);
}
export function exportUrl(format: 'csv' | 'json') { return `${base}export?format=${format}`; }

import * as fs from "node:fs/promises";
import path from "node:path";
export function parseCsv(text) {
  const out = []; let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === "," || c === "\n")) { row.push(cell); cell = ""; if (c === "\n") { out.push(row); row = []; } }
    else if (quoted || c !== "\r") cell += c;
  }
  if (quoted) throw Error("unterminated_csv_quote");
  if (cell.length || row.length) out.push([...row, cell]);
  const keys = out.shift() ?? [];
  return out.map(r => {
    if (r.length !== keys.length) throw Error("invalid_csv_column_count");
    return Object.fromEntries(keys.map((k, i) => [k, r[i]]));
  });
}
export async function readTable(dir, name) { return parseCsv(await fs.readFile(path.join(dir, `${name}.csv`), "utf8")); }

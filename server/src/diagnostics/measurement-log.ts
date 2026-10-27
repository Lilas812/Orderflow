import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isolationMarker } from "./isolation.ts";

/** Persist small lifecycle records during a measurement. Lines arrive only
 * after createLogger has scrubbed secrets. Keep the sink after flag removal
 * so release verification and shutdown are also recorded.
 */
export function measurementLogWriter(root = path.dirname(fileURLToPath(isolationMarker))) {
  if (!existsSync(path.join(root, "isolation.json"))) return undefined;
  const file = path.join(root, `connections-${process.pid}.jsonl`);
  return (line: string) => {
    process.stdout.write(line + "\n");
    if (/"event":"(?:hub_|measurement_isolation_|upstream_close|upstream_stopped|server_stopped)/.test(line)) {
      appendFileSync(file, line + "\n", { mode: 0o600 });
    }
  };
}

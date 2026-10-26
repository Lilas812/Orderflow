export type Log = (event: string, details?: unknown) => void;

/** Apply at every output boundary, including JSON property names and Errors. */
export function makeSanitizer(secret: string) {
  const secrets = [...new Set([secret, encodeURIComponent(secret)])].filter(Boolean);
  return (value: unknown): unknown => {
    const ancestors = new WeakSet<object>();
    const string = (text: string) => {
      let safe = text;
      for (const token of secrets) safe = safe.split(token).join("[REDACTED]");
      safe = safe.replace(/(?:https?|wss?):[^\s<>]*?(?:key=|key%3[dD])[^\s<>]*/gi, "[REDACTED_URL]");
      return safe.replace(/key(?:=|%3[dD])[^\s,;&}]*/gi, "[REDACTED_CREDENTIAL]");
    };
    const walk = (item: unknown): unknown => {
      if (typeof item === "string") return string(item);
      if (typeof item === "bigint") return item.toString();
      if (item === undefined) return null;
      if (typeof item !== "object" || item === null) return item;
      if (ancestors.has(item)) return "[circular]";
      ancestors.add(item);
      if (item instanceof Error) return { name: string(item.name), message: string(item.message) };
      if (Array.isArray(item)) return item.map(walk);
      return Object.fromEntries(Object.entries(item).map(([key, val]) => [string(key), walk(val)]));
    };
    return walk(value);
  };
}

export function createLogger(
  secret: string,
  write: (line: string) => void = (line) => process.stdout.write(line + "\n"),
  now: () => number = Date.now,
): Log {
  const sanitize = makeSanitizer(secret);
  return (event, details = {}) => {
    write(JSON.stringify(sanitize({ recvUs: now() * 1000, event, details })));
  };
}

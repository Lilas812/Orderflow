/** Shared transport only. A failed read never becomes a default document or PUT. */
export async function requestSettingsDocument<T>(
  url: string, values: object | undefined, parse: (raw: unknown) => T | null,
): Promise<T> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: values ? "PUT" : "GET", cache: "no-store", credentials: "include", signal: controller.signal,
      ...(values ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values }) } : {}),
    });
    const json = (res.headers.get("Content-Type") ?? "").toLowerCase().includes("application/json");
    if (res.redirected && !json) throw Error(`設定APIがリダイレクトされました（HTTP ${res.status}、サインインを確認してください）`);
    if (!json)
      throw Error(`設定APIの応答がJSONではありません（HTTP ${res.status}、認証・接続先を確認してください）`);
    let raw: unknown;
    try { raw = await res.json(); } catch { throw Error(`設定APIのJSONが不正です（HTTP ${res.status}）`); }
    if (!res.ok) {
      const body = raw as { fields?: Record<string, string>; error?: string } | null;
      throw Error(Object.values(body?.fields ?? {}).join(" / ")
        || `${values ? "設定を保存" : "設定を読取"}できませんでした（HTTP ${res.status}）`);
    }
    const doc = parse(raw);
    if (doc === null) throw Error("設定の応答が不正です（version・項目を確認してください）");
    return doc;
  } catch (e) {
    if (controller.signal.aborted) throw Error("設定の通信が10秒でタイムアウトしました");
    throw e;
  } finally { clearTimeout(timer); }
}

import { useQueries } from '@tanstack/react-query';
import type { SessionIndexItem } from '@/lib/research';
import type { OverviewSession } from '@/lib/overview';

const base = import.meta.env.BASE_URL;

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(base + path, { signal, cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path} の取得に失敗しました (HTTP ${res.status})`);
  return (await res.json()) as T;
}

/**
 * Loads EVERY session file listed in the index (same query keys as the daily page).
 * Returns data only when all files loaded and each file matches its index date;
 * otherwise reports progress / failures explicitly (no silent partial results).
 */
export function useAllSessions(items: SessionIndexItem[]) {
  const qs = useQueries({
    queries: items.map((it) => ({
      queryKey: ['research-session', it.file],
      queryFn: ({ signal }: { signal: AbortSignal }) => getJson<OverviewSession>('research-data/' + it.file, signal),
      staleTime: Infinity,
      retry: 1,
    })),
  });
  const loaded = qs.filter((q) => q.data).length;
  const failed = items
    .map((it, i) => ({ it, q: qs[i] }))
    .filter(({ q }) => q.isError)
    .map(({ it, q }) => `${it.date}: ${(q.error as Error).message}`);
  const mismatched = items
    .map((it, i) => ({ it, d: qs[i]?.data }))
    .filter(({ it, d }) => d && (d.session !== it.date || !Array.isArray(d.ownProfile) || typeof d.availableStartMs !== 'number'))
    .map(({ it, d }) =>
      d!.session !== it.date
        ? `${it.date}: ファイル内容のセッション(${d!.session})が一致しません`
        : `${it.date}: ownProfile / availableStartMs がありません(エクスポート未更新)`,
    );
  const complete = items.length > 0 && loaded === items.length && !failed.length && !mismatched.length;
  const dataKey = complete ? qs.map((q) => q.dataUpdatedAt).join(',') : '';
  return {
    total: items.length,
    loaded,
    errors: [...failed, ...mismatched],
    complete,
    dataKey,
    sessions: complete ? qs.map((q) => q.data as OverviewSession) : null,
    retry: () => qs.forEach((q) => q.isError && q.refetch()),
  };
}

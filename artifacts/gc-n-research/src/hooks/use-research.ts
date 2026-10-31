import { useQuery } from '@tanstack/react-query';
import type { ResearchIndex, SessionData, SessionIndexItem } from '@/lib/research';

const base = import.meta.env.BASE_URL;

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(base + path, { signal, cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path} の取得に失敗しました (HTTP ${res.status})`);
  return (await res.json()) as T;
}

export function useResearchIndex() {
  return useQuery({
    queryKey: ['research-index'],
    queryFn: ({ signal }) => getJson<ResearchIndex>('research-data/index.json', signal),
    staleTime: Infinity,
    retry: 1,
  });
}

/**
 * Session file query keyed by file. React Query keeps results per key, so a slow
 * earlier response can never be shown for a newer selection. The caller also
 * verifies data.session === item.date before rendering.
 */
export function useSessionData(item: SessionIndexItem | null) {
  return useQuery({
    queryKey: ['research-session', item?.file ?? null],
    queryFn: ({ signal }) => getJson<SessionData>('research-data/' + item!.file, signal),
    enabled: !!item,
    staleTime: Infinity,
    retry: 1,
  });
}

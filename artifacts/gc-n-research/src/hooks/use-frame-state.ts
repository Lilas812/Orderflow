import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';

/** Coalesce input bursts without losing functional updates between frames. */
export function useFrameState<T>(initial: T | (() => T)) {
  const [value, commit] = useState(initial);
  const latest = useRef(value);
  const frame = useRef<number | null>(null);
  const set = useCallback((action: SetStateAction<T>) => {
    latest.current = typeof action === 'function'
      ? (action as (previous: T) => T)(latest.current) : action;
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      commit(latest.current);
    });
  }, []);
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  return [value, set] as const;
}

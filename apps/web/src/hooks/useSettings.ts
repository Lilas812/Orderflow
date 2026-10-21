import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_DISPLAY_SETTINGS, MAX_SETTINGS_BYTES, cancelSettings, cloneSettings, commitSettings,
  createSettingsSession, editSettings, validateDisplaySettings, validateSettingsSnapshot,
  type DisplaySettings, type SettingsSnapshot, type SettingsTransport,
} from "@workspace/core/settings-schema";

/** No filesystem dependency, token or development endpoint enters the production branch. */
export function createDevSettingsTransport(): SettingsTransport {
  if (!import.meta.env.DEV) {
    const unavailable = async (): Promise<SettingsSnapshot> => { throw new Error("設定のファイル保存は開発環境専用です"); };
    return { load: unavailable, save: unavailable };
  }
  const endpoint = `${import.meta.env.BASE_URL}__orderflow/settings`;
  let csrf = "";
  const request = async (method: "GET" | "PUT", body?: unknown): Promise<SettingsSnapshot> => {
    const res = await fetch(endpoint, { method, credentials: "same-origin", cache: "no-store",
      headers: method === "PUT" ? { "Content-Type": "application/json", "X-Settings-CSRF": csrf } : {},
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    if (new TextEncoder().encode(text).byteLength > MAX_SETTINGS_BYTES) throw new Error("設定応答のサイズ上限を超えました");
    let value: Record<string, unknown>;
    try { value = JSON.parse(text); } catch { throw new Error("設定APIから不正なJSONが返されました"); }
    if (!res.ok) throw new Error(typeof value?.error === "string" ? value.error : `設定API HTTP ${res.status}`);
    if (method === "GET") {
      if (!value || typeof value.csrfToken !== "string" || !/^[0-9a-f]{64}$/.test(value.csrfToken)
        || Object.keys(value).length !== 4) throw new Error("不正な設定応答");
      csrf = value.csrfToken;
      const { csrfToken: _, ...snapshot } = value;
      return validateSettingsSnapshot(snapshot);
    }
    return validateSettingsSnapshot(value);
  };
  return {
    load: () => request("GET"),
    save: async (settings, expectedRevision) => {
      validateDisplaySettings(settings);
      if (!csrf) throw new Error("保存前に設定を読み込んでください");
      const snapshot = await request("PUT", { settings, expectedRevision });
      if (!snapshot.persisted || snapshot.revision !== expectedRevision + 1
        || JSON.stringify(snapshot.settings) !== JSON.stringify(settings)) throw new Error("保存応答が送信設定と一致しません");
      return snapshot;
    },
  };
}
export interface SettingsController {
  saved: DisplaySettings; draft: DisplaySettings; preview: DisplaySettings;
  revision: number; persisted: boolean; ready: boolean; loading: boolean; saving: boolean;
  error: string | null; open: boolean; dirty: boolean; fieldErrors: Readonly<Record<string, string>>;
  canSave: boolean;
  begin(): void; update(next: DisplaySettings | ((s: DisplaySettings) => DisplaySettings)): void;
  setFieldError(key: string, error: string | null): void;
  cancel(): void; save(): Promise<boolean>; reload(): Promise<void>;
}
const initial = () => ({
  session: createSettingsSession({ revision: 0, persisted: false, settings: DEFAULT_DISPLAY_SETTINGS }),
  ready: false, loading: true, saving: false, error: null as string | null, open: false,
  fieldErrors: {} as Record<string, string>,
});
export function useSettings(transport?: SettingsTransport): SettingsController {
  const api = useRef<SettingsTransport | null>(null);
  if (!api.current) api.current = transport ?? createDevSettingsTransport();
  const [state, setState] = useState(initial);
  const ref = useRef(state); ref.current = state;
  // Update refs synchronously so double clicks and successive controls cannot race React batching.
  const change = useCallback((fn: (s: ReturnType<typeof initial>) => ReturnType<typeof initial>) => {
    ref.current = fn(ref.current); setState(ref.current);
  }, []);
  const edits = useRef(0), loads = useRef(0), alive = useRef(true);
  const load = useCallback(async (discard: boolean) => {
    if (ref.current.saving) return;
    const run = ++loads.current, edit = edits.current;
    change(s => ({ ...s, loading: true, error: null }));
    try {
      const snapshot = await api.current!.load();
      if (!alive.current || run !== loads.current || ref.current.saving) return;
      change(s => {
        const restore = discard && edit === edits.current;
        const session = restore ? createSettingsSession(snapshot) : commitSettings(s.session, snapshot, s.session.saved);
        return { ...s, session, ready: true, loading: false, error: null,
          fieldErrors: restore ? {} : s.fieldErrors };
      });
    } catch (e) {
      if (alive.current && run === loads.current) change(s => ({ ...s, loading: false, ready: false,
        error: `設定読込失敗: ${e instanceof Error ? e.message : String(e)}` }));
    }
  }, [change]);
  useEffect(() => {
    alive.current = true; void load(true);
    return () => { alive.current = false; ++loads.current; };
  }, [load]);
  const update = useCallback((next: DisplaySettings | ((s: DisplaySettings) => DisplaySettings)) => {
    const value = typeof next === "function" ? next(cloneSettings(ref.current.session.draft)) : next;
    try {
      const edited = editSettings(ref.current.session, value);
      ++edits.current;
      change(s => {
        const errors = { ...s.fieldErrors }; delete errors._schema;
        return { ...s, session: edited, fieldErrors: errors };
      });
    } catch (e) {
      change(s => ({ ...s, fieldErrors: { ...s.fieldErrors, _schema: e instanceof Error ? e.message : String(e) } }));
    }
  }, [change]);
  const setFieldError = useCallback((key: string, error: string | null) => {
    ++edits.current;
    change(s => {
      const next = { ...s.fieldErrors };
      if (error) next[key] = error; else delete next[key];
      return { ...s, fieldErrors: next };
    });
  }, [change]);
  const cancel = useCallback(() => {
    if (ref.current.saving) return;
    ++edits.current;
    change(s => ({ ...s, session: cancelSettings(s.session), fieldErrors: {}, open: false }));
  }, [change]);
  const begin = useCallback(() => {
    if (ref.current.open || ref.current.saving) return;
    change(s => ({ ...s, open: true }));
    void load(false); // Legacy debug controls also edit DRAFT: opening must not discard them.
  }, [change, load]);
  const save = useCallback(async () => {
    const current = ref.current;
    if (!current.ready || current.loading || current.saving || Object.values(current.fieldErrors).some(Boolean)) return false;
    const submitted = cloneSettings(current.session.draft), revision = current.session.revision, submittedEdit = edits.current;
    change(s => ({ ...s, saving: true, error: null }));
    try {
      const snapshot = await api.current!.save(submitted, revision);
      validateSettingsSnapshot(snapshot);
      if (!snapshot.persisted || snapshot.revision !== revision + 1
        || JSON.stringify(snapshot.settings) !== JSON.stringify(submitted)) throw new Error("保存結果不一致");
      if (!alive.current) return false;
      change(s => {
        const unchanged = JSON.stringify(s.session.draft) === JSON.stringify(submitted) && edits.current === submittedEdit;
        return { ...s, session: commitSettings(s.session, snapshot, submitted), saving: false,
          error: null, open: unchanged ? false : s.open };
      });
      return true;
    } catch (e) {
      if (alive.current) change(s => ({ ...s, saving: false,
        error: `設定保存失敗: ${e instanceof Error ? e.message : String(e)}（保存済み設定は更新していません）` }));
      return false;
    }
  }, [change]);
  return { ...state.session, ready: state.ready, loading: state.loading, saving: state.saving,
    error: state.error, open: state.open, fieldErrors: state.fieldErrors,
    dirty: JSON.stringify(state.session.draft) !== JSON.stringify(state.session.saved) || Object.values(state.fieldErrors).some(Boolean),
    canSave: state.ready && !state.loading && !state.saving && !Object.values(state.fieldErrors).some(Boolean),
    begin, update, setFieldError, cancel, save, reload: () => load(true) };
}

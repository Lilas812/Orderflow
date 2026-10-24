import { DEFAULT_DISPLAY_SETTINGS, cloneSettings, type SettingsTransport } from "@workspace/core/settings-schema";

/** Host adapter, not a new settings store. Preview/cancel use the existing Web hooks.
 * No Web development settings endpoint or workspace JSON is used by the desktop. */
export const desktopSettings: SettingsTransport = Object.freeze({
  load: async () => ({ revision: 0, persisted: false, settings: cloneSettings(DEFAULT_DISPLAY_SETTINGS) }),
  save: async () => { throw new Error("Desktop設定の永続保存は未実装です（MOCKのみ／ファイル未保存）"); },
});

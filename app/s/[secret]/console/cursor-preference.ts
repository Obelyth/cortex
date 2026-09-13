/** Non-sensitive appearance only; never a server preference or authorization input. */
const KEY = "cx-cursor-accent";
export const CURSOR_EVENT = "cx-cursor-preference";
let visitPreference: boolean | undefined;
export function readCursorPreference() {
  if (visitPreference !== undefined) return visitPreference;
  try { return window.localStorage.getItem(KEY) === "on"; } catch { return false; }
}
export function saveCursorPreference(enabled: boolean) {
  let saved = true;
  try { window.localStorage.setItem(KEY, enabled ? "on" : "off"); visitPreference = undefined; }
  catch { visitPreference = enabled; saved = false; }
  window.dispatchEvent(new Event(CURSOR_EVENT));
  return saved;
}

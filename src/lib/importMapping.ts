/**
 * Remembers the last column mapping used per import target ("sheet type"),
 * so a repeat import from the same source system doesn't require
 * re-mapping columns every time. Best-effort only — a private-browsing
 * tab or blocked storage just means re-mapping is needed again.
 */
const KEY_PREFIX = 'equipment-ledger:import-mapping:'

export function loadMapping(sheetType: string): Record<string, string> | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + sheetType)
    return raw ? (JSON.parse(raw) as Record<string, string>) : null
  } catch {
    return null
  }
}

export function saveMapping(sheetType: string, mapping: Record<string, string>): void {
  try {
    localStorage.setItem(KEY_PREFIX + sheetType, JSON.stringify(mapping))
  } catch {
    // Best-effort — storage may be full or blocked.
  }
}

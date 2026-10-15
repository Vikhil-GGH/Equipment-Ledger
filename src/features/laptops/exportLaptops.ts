import type * as XLSXTypes from 'xlsx'
import { SCOPE_LABELS, STATUS_LABELS, TAB_LABELS, type LaptopFilters, type LaptopRow } from './laptopInventory'

/**
 * Inventory fields only — no internal ids, table names or database flags,
 * and no employee data beyond who the laptop is assigned to.
 */
export const EXPORT_COLUMNS: { header: string; value: (r: LaptopRow) => string; width: number }[] = [
  { header: 'Serial Number', value: (r) => r.serial, width: 22 },
  { header: 'Model', value: (r) => r.name, width: 28 },
  { header: 'Category', value: (r) => r.category, width: 14 },
  { header: 'Status', value: (r) => STATUS_LABELS[r.status] ?? r.status, width: 16 },
  { header: 'Assigned To', value: (r) => r.assigned_to ?? '', width: 24 },
  { header: 'Management Scope', value: (r) => SCOPE_LABELS[r.scope], width: 18 },
  { header: 'Location', value: (r) => r.location ?? '', width: 18 },
  { header: 'Last Updated', value: (r) => new Date(r.updated_at).toISOString().slice(0, 10), width: 14 },
]

/**
 * Builds the workbook for exactly the rows given (already filtered and
 * sorted by filterLaptops), one row per asset. Every cell is written as
 * text — so serials like "00123" or "1E10" stay exactly as recorded and a
 * value starting with "=" is never treated as a formula — and the Serial
 * column is also formatted as Text for anyone who edits it later.
 */
export function buildLaptopWorkbook(
  XLSX: typeof XLSXTypes,
  rows: LaptopRow[],
  filters: LaptopFilters,
  exportedAt: Date,
): XLSXTypes.WorkBook {
  const seen = new Set<string>()
  const unique = rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))

  const aoa = [EXPORT_COLUMNS.map((c) => c.header), ...unique.map((r) => EXPORT_COLUMNS.map((c) => c.value(r)))]
  const sheet = XLSX.utils.aoa_to_sheet(aoa, { cellDates: false })
  for (let row = 1; row < aoa.length; row++) {
    for (let col = 0; col < EXPORT_COLUMNS.length; col++) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })]
      if (!cell) continue
      cell.t = 's'
      cell.v = String(cell.v ?? '')
      if (col === 0) cell.z = '@'
    }
  }
  sheet['!cols'] = EXPORT_COLUMNS.map((c) => ({ wch: c.width }))
  sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, aoa.length - 1), c: EXPORT_COLUMNS.length - 1 } }) }

  const about = XLSX.utils.aoa_to_sheet([
    ['Equipment Ledger — Laptop Inventory export'],
    ['Exported at', exportedAt.toISOString()],
    ['Tab', TAB_LABELS[filters.tab]],
    ['Management scope', SCOPE_LABELS[filters.scope]],
    ['Search', filters.search.trim() || '(none)'],
    ['Sorted by', `${filters.sort.key} (${filters.sort.direction})`],
    ['Laptops', String(unique.length)],
  ])
  about['!cols'] = [{ wch: 20 }, { wch: 40 }]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheet, 'Laptops')
  XLSX.utils.book_append_sheet(wb, about, 'Export details')
  return wb
}

export function exportFilename(filters: LaptopFilters, exportedAt: Date): string {
  const parts = ['laptop-inventory', filters.tab, filters.scope !== 'all' ? filters.scope : null]
  return `${parts.filter(Boolean).join('-')}-${exportedAt.toISOString().slice(0, 10)}.xlsx`
}

/** Loads SheetJS only when someone actually exports (it's large). */
export async function downloadLaptopExport(rows: LaptopRow[], filters: LaptopFilters): Promise<number> {
  const XLSX = await import('xlsx')
  const now = new Date()
  const wb = buildLaptopWorkbook(XLSX, rows, filters, now)
  XLSX.writeFile(wb, exportFilename(filters, now), { compression: true })
  return wb.Sheets.Laptops['!ref'] ? XLSX.utils.decode_range(wb.Sheets.Laptops['!ref']).e.r : 0
}

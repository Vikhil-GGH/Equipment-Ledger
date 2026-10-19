import type * as XLSXTypes from 'xlsx'

/**
 * Small helpers for the app's Excel exports (SheetJS).
 *
 * Safety: every text value is written as a plain string cell (t: 's'),
 * never a formula — so an employee name like "=HYPERLINK(...)" or
 * "+cmd|..." is stored and shown as typed and can't run. Dates are real
 * Excel dates (sortable, filterable) in the viewer's local time.
 */

export type CellValue = string | number | Date | null | undefined

export interface Column<T> {
  header: string
  width: number
  value: (row: T) => CellValue
  /** Excel number format: dates default to 'yyyy-mm-dd hh:mm'; use '0%' for a 0–1 share. */
  format?: string
}

/** Excel serial date for a JS date, in local time (what the user saw in the app). */
export function excelDate(d: Date): number {
  return (d.getTime() - d.getTimezoneOffset() * 60_000) / 86_400_000 + 25569
}

export function dateOrNull(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

/** A sheet with a header row, typed cells, column widths and an auto-filter. */
export function buildSheet<T>(XLSX: typeof XLSXTypes, columns: Column<T>[], rows: T[]): XLSXTypes.WorkSheet {
  const sheet: XLSXTypes.WorkSheet = {}
  columns.forEach((c, col) => {
    sheet[XLSX.utils.encode_cell({ r: 0, c: col })] = { t: 's', v: c.header }
  })
  rows.forEach((row, i) => {
    columns.forEach((c, col) => {
      const v = c.value(row)
      if (v === null || v === undefined || v === '') return // blank stays blank
      const ref = XLSX.utils.encode_cell({ r: i + 1, c: col })
      if (v instanceof Date) sheet[ref] = { t: 'n', v: excelDate(v), z: c.format ?? 'yyyy-mm-dd hh:mm' }
      else if (typeof v === 'number') sheet[ref] = c.format ? { t: 'n', v, z: c.format } : { t: 'n', v }
      else sheet[ref] = { t: 's', v: String(v) }
    })
  })
  const range = { s: { r: 0, c: 0 }, e: { r: Math.max(rows.length, 0), c: Math.max(columns.length - 1, 0) } }
  sheet['!ref'] = XLSX.utils.encode_range(range)
  sheet['!cols'] = columns.map((c) => ({ wch: c.width }))
  sheet['!autofilter'] = { ref: XLSX.utils.encode_range(range) }
  return sheet
}

/** Two-column "label / value" sheet describing the export. */
export function buildDetailsSheet(XLSX: typeof XLSXTypes, lines: [string, string][]): XLSXTypes.WorkSheet {
  const sheet = XLSX.utils.aoa_to_sheet(lines.map(([a, b]) => [a, b]))
  for (const key of Object.keys(sheet)) {
    if (key.startsWith('!')) continue
    const cell = sheet[key] as XLSXTypes.CellObject
    cell.t = 's'
    cell.v = String(cell.v ?? '')
  }
  sheet['!cols'] = [{ wch: 24 }, { wch: 80 }]
  return sheet
}

const FROZEN_VIEW = '<sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView>'

/**
 * Writes the workbook as .xlsx bytes with the header row frozen on the
 * given sheets. (The free SheetJS build can't write frozen panes, so the
 * sheet XML is patched inside the zip it produces.)
 */
export function writeXlsx(XLSX: typeof XLSXTypes, wb: XLSXTypes.WorkBook, frozenSheets: string[]): Uint8Array {
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer
  const CFB = XLSX.CFB
  const zip = CFB.read(new Uint8Array(bytes), { type: 'array' })
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  wb.SheetNames.forEach((name, i) => {
    if (!frozenSheets.includes(name)) return
    const path = `/xl/worksheets/sheet${i + 1}.xml`
    const entry = CFB.find(zip, path)
    if (!entry?.content) throw new Error(`Excel export: ${path} missing`)
    const xml = decoder.decode(entry.content as Uint8Array)
    const patched = xml.replace(/<sheetView workbookViewId="0"\s*\/>/, FROZEN_VIEW)
    if (patched === xml) throw new Error(`Excel export: could not freeze the header row of ${name}`)
    CFB.utils.cfb_add(zip, path, encoder.encode(patched))
  })
  return CFB.write(zip, { fileType: 'zip', type: 'array', compression: true }) as Uint8Array
}

/** Hands the bytes to the browser as a download. */
export function saveFile(filename: string, bytes: Uint8Array) {
  const blob = new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Local calendar date for filenames, e.g. 2026-10-16. */
export function fileDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

import * as XLSX from 'xlsx'

export interface ParsedSheet {
  sheetName: string
  headers: string[]
  rows: Record<string, unknown>[]
}

/**
 * Reads every sheet in a workbook, not just the first — real-world files
 * sometimes have a cover sheet or notes tab ahead of the actual data.
 */
export async function parseExcelFile(file: File): Promise<ParsedSheet[]> {
  const buffer = await file.arrayBuffer()
  const workbook = XLSX.read(buffer, { type: 'array' })

  return workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName]
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })
    const headerRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 })
    const headers = (headerRows[0] as unknown[] | undefined)?.map((h) => String(h).trim()) ?? []
    return { sheetName, headers, rows }
  })
}

export function cellToString(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

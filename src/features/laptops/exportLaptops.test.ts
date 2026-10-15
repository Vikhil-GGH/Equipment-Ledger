// @vitest-environment node
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { buildLaptopWorkbook, exportFilename } from './exportLaptops'
import { DEFAULT_LAPTOP_SORT, combineLaptops, filterLaptops, type LaptopFilters, type LaptopRecord } from './laptopInventory'

function rec(id: string, serial: string, extra: Partial<LaptopRecord> = {}): LaptopRecord {
  return {
    id,
    name: 'Dell Latitude 5440',
    category: 'Laptop',
    serial,
    status: 'available',
    assigned_to: null,
    location: 'Tampa Office',
    created_at: '2026-10-14T12:00:00.123456Z',
    updated_at: '2026-10-14T12:00:00.123456Z',
    ...extra,
  }
}

const rows = combineLaptops(
  [rec('1', '00123'), rec('2', '1E10'), rec('3', '=HYPERLINK("x")'), rec('4', 'SYN-INV-004', { status: 'damaged' })],
  [rec('5', 'SYN-NP-001', { status: 'provided', assigned_to: 'Test Employee 06', moved_from_inventory: false })],
)
const filters: LaptopFilters = { tab: 'all', scope: 'all', search: '', sort: { key: 'serial', direction: 'asc' } }

/** Writes a real .xlsx to memory and reads it back, as Excel would see it. */
function roundTrip(wb: XLSX.WorkBook) {
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  const back = XLSX.read(buf, { type: 'buffer' })
  return { back, laptops: XLSX.utils.sheet_to_json<Record<string, unknown>>(back.Sheets.Laptops, { raw: true }) }
}

describe('laptop Excel export', () => {
  it('writes exactly the filtered, sorted rows into a real workbook', () => {
    const subset = filterLaptops(rows, { ...filters, tab: 'available', sort: { key: 'serial', direction: 'desc' } })
    const { back, laptops } = roundTrip(buildLaptopWorkbook(XLSX, subset, filters, new Date('2026-10-15T00:00:00Z')))
    expect(back.SheetNames).toEqual(['Laptops', 'Export details'])
    expect(laptops.map((r) => r['Serial Number'])).toEqual(subset.map((r) => r.serial))
  })

  it('keeps serials as text — leading zeros, exponent-looking and formula-looking values unchanged', () => {
    const { back, laptops } = roundTrip(buildLaptopWorkbook(XLSX, rows, filters, new Date()))
    expect(laptops.map((r) => r['Serial Number'])).toEqual(
      expect.arrayContaining(['00123', '1E10', '=HYPERLINK("x")']),
    )
    const sheet = back.Sheets.Laptops
    for (let r = 1; r <= rows.length; r++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c: 0 })]
      expect(cell.t).toBe('s')
      expect(cell.f).toBeUndefined()
    }
  })

  it('has only inventory columns — no ids, table names or database flags', () => {
    const { laptops } = roundTrip(buildLaptopWorkbook(XLSX, rows, filters, new Date()))
    expect(Object.keys(laptops[0])).toEqual([
      'Serial Number',
      'Model',
      'Category',
      'Status',
      'Assigned To',
      'Management Scope',
      'Location',
      'Last Updated',
    ])
    const text = JSON.stringify(laptops)
    for (const leaked of ['serialized_assets', 'active_laptops_np', 'moved_from_inventory', '"id"']) expect(text).not.toContain(leaked)
  })

  it('never writes the same asset twice', () => {
    const { laptops } = roundTrip(buildLaptopWorkbook(XLSX, [...rows, rows[0], rows[1]], filters, new Date()))
    expect(laptops).toHaveLength(rows.length)
  })

  it('records the filters used, and names the file after them', () => {
    const f = { ...filters, tab: 'active' as const, scope: 'np' as const, search: 'employee' }
    const { back } = roundTrip(buildLaptopWorkbook(XLSX, [], f, new Date('2026-10-15T00:00:00Z')))
    const details = XLSX.utils.sheet_to_json<string[]>(back.Sheets['Export details'], { header: 1 })
    expect(details).toEqual(
      expect.arrayContaining([
        ['Tab', 'Active / Assigned'],
        ['Management scope', 'NP-managed'],
        ['Search', 'employee'],
        ['Laptops', '0'],
      ]),
    )
    expect(exportFilename(f, new Date('2026-10-15T00:00:00Z'))).toBe('laptop-inventory-active-np-2026-10-15.xlsx')
    expect(exportFilename({ ...filters, sort: DEFAULT_LAPTOP_SORT }, new Date('2026-10-15T00:00:00Z'))).toBe(
      'laptop-inventory-all-2026-10-15.xlsx',
    )
  })
})

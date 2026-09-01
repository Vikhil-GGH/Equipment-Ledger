import { describe, expect, it } from 'vitest'
import {
  normalizeAssetImportRow,
  normalizeBulkImportRow,
  validateAssetImportRow,
  validateBulkImportRow,
  type RawAssetImportRow,
  type RawBulkImportRow,
} from './importValidation'

function assetRow(overrides: Partial<RawAssetImportRow> = {}): RawAssetImportRow {
  return {
    name: 'ThinkPad X1',
    category: 'Laptop',
    serial: 'SN-001',
    status: 'available',
    assigned_to: '',
    location: 'Tampa Office',
    ...overrides,
  }
}

describe('validateAssetImportRow', () => {
  it('accepts a well-formed row', () => {
    expect(validateAssetImportRow(assetRow(), new Set())).toEqual([])
  })

  it('flags missing name, category, serial', () => {
    const errors = validateAssetImportRow(
      assetRow({ name: '', category: '', serial: '' }),
      new Set(),
    )
    expect(errors).toContain('Missing name')
    expect(errors).toContain('Missing category')
    expect(errors).toContain('Missing serial')
  })

  it('flags a serial already seen earlier in the same sheet, case-insensitively', () => {
    const errors = validateAssetImportRow(
      assetRow({ serial: 'sn-001' }),
      new Set(['sn-001']),
    )
    expect(errors).toContain('Duplicate serial in this sheet')
  })

  it('does not flag a serial that only exists in the DB, not the sheet', () => {
    // seenSoFar tracks sheet-local duplicates only; DB-existing serials are
    // a legitimate update, checked separately at commit time.
    const errors = validateAssetImportRow(assetRow({ serial: 'SN-002' }), new Set(['sn-001']))
    expect(errors).not.toContain('Duplicate serial in this sheet')
  })

  it('accepts blank status (defaults to available downstream)', () => {
    expect(validateAssetImportRow(assetRow({ status: '' }), new Set())).toEqual([])
  })

  it('accepts any case of a valid status', () => {
    expect(validateAssetImportRow(assetRow({ status: 'Provided' }), new Set())).toEqual([])
    expect(validateAssetImportRow(assetRow({ status: 'DECOMMISSIONED' }), new Set())).toEqual([])
  })

  it('flags an invalid status value', () => {
    const errors = validateAssetImportRow(assetRow({ status: 'lost' }), new Set())
    expect(errors).toEqual(['Invalid status "lost"'])
  })
})

describe('normalizeAssetImportRow', () => {
  it('trims whitespace and lowercases a valid status', () => {
    expect(
      normalizeAssetImportRow(
        assetRow({ name: '  ThinkPad  ', serial: ' SN-001 ', status: 'PROVIDED' }),
      ),
    ).toEqual({
      name: 'ThinkPad',
      category: 'Laptop',
      serial: 'SN-001',
      status: 'provided',
      assigned_to: '',
      location: 'Tampa Office',
    })
  })

  it('normalizes an invalid status to empty string rather than passing it through', () => {
    expect(normalizeAssetImportRow(assetRow({ status: 'lost' })).status).toBe('')
  })
})

function bulkRow(overrides: Partial<RawBulkImportRow> = {}): RawBulkImportRow {
  return { name: 'Wireless Mouse', category: 'Accessory', location: '', quantity: '10', ...overrides }
}

describe('validateBulkImportRow', () => {
  it('accepts a well-formed row', () => {
    expect(validateBulkImportRow(bulkRow())).toEqual([])
  })

  it('flags missing name and category', () => {
    const errors = validateBulkImportRow(bulkRow({ name: '', category: '' }))
    expect(errors).toContain('Missing name')
    expect(errors).toContain('Missing category')
  })

  it('accepts a blank quantity (defaults to 0 downstream)', () => {
    expect(validateBulkImportRow(bulkRow({ quantity: '' }))).toEqual([])
  })

  it('flags a negative quantity', () => {
    expect(validateBulkImportRow(bulkRow({ quantity: '-5' }))).toEqual(['Invalid quantity "-5"'])
  })

  it('flags a non-integer quantity', () => {
    expect(validateBulkImportRow(bulkRow({ quantity: '3.5' }))).toEqual(['Invalid quantity "3.5"'])
  })

  it('flags a non-numeric quantity', () => {
    expect(validateBulkImportRow(bulkRow({ quantity: 'ten' }))).toEqual(['Invalid quantity "ten"'])
  })
})

describe('normalizeBulkImportRow', () => {
  it('parses a valid quantity', () => {
    expect(normalizeBulkImportRow(bulkRow({ quantity: '25' })).quantity).toBe(25)
  })

  it('defaults a blank quantity to 0', () => {
    expect(normalizeBulkImportRow(bulkRow({ quantity: '' })).quantity).toBe(0)
  })

  it('defaults an invalid quantity to 0 rather than propagating garbage', () => {
    expect(normalizeBulkImportRow(bulkRow({ quantity: 'ten' })).quantity).toBe(0)
  })
})

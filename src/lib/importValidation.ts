import type { AssetStatus } from '../types/database.types'

export const ASSET_STATUS_VALUES: AssetStatus[] = [
  'available',
  'provided',
  'retained',
  'damaged',
  'decommissioned',
  'nonfunctional',
]

export interface RawAssetImportRow {
  name: string
  category: string
  serial: string
  status: string
  assigned_to: string
  location: string
}

export interface NormalizedAssetImportRow {
  name: string
  category: string
  serial: string
  status: AssetStatus | ''
  assigned_to: string
  location: string
}

/**
 * Validates one mapped row against the sheet's own serial set — a
 * duplicate serial *within the sheet itself* is a sheet error, distinct
 * from "this serial already exists in the DB" (which is a legitimate
 * update, not an error). Case-insensitive: "ABC123" and "abc123" in the
 * same sheet are almost certainly the same physical tag, not two assets.
 */
export function validateAssetImportRow(
  row: RawAssetImportRow,
  serialsSeenSoFar: Set<string>,
): string[] {
  const errors: string[] = []
  const name = row.name.trim()
  const category = row.category.trim()
  const serial = row.serial.trim()
  const status = row.status.trim()

  if (!name) errors.push('Missing name')
  if (!category) errors.push('Missing category')
  if (!serial) {
    errors.push('Missing serial')
  } else if (serialsSeenSoFar.has(serial.toLowerCase())) {
    errors.push('Duplicate serial in this sheet')
  }
  if (status && !ASSET_STATUS_VALUES.includes(status.toLowerCase() as AssetStatus)) {
    errors.push(`Invalid status "${row.status}"`)
  }
  return errors
}

export function normalizeAssetImportRow(row: RawAssetImportRow): NormalizedAssetImportRow {
  const status = row.status.trim().toLowerCase()
  return {
    name: row.name.trim(),
    category: row.category.trim(),
    serial: row.serial.trim(),
    status: ASSET_STATUS_VALUES.includes(status as AssetStatus) ? (status as AssetStatus) : '',
    assigned_to: row.assigned_to.trim(),
    location: row.location.trim(),
  }
}

export interface RawBulkImportRow {
  name: string
  category: string
  location: string
  quantity: string
}

export interface NormalizedBulkImportRow {
  name: string
  category: string
  location: string
  quantity: number
}

export function validateBulkImportRow(row: RawBulkImportRow): string[] {
  const errors: string[] = []
  if (!row.name.trim()) errors.push('Missing name')
  if (!row.category.trim()) errors.push('Missing category')

  const qtyText = row.quantity.trim()
  if (qtyText) {
    const n = Number(qtyText)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      errors.push(`Invalid quantity "${row.quantity}"`)
    }
  }
  return errors
}

export function normalizeBulkImportRow(row: RawBulkImportRow): NormalizedBulkImportRow {
  const n = Number(row.quantity.trim())
  return {
    name: row.name.trim(),
    category: row.category.trim(),
    location: row.location.trim(),
    quantity: Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0,
  }
}

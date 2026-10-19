import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { AssetCollection } from '../../types/database.types'
import { cellToString, parseExcelFile, type ParsedSheet } from '../../lib/excel'
import { loadMapping, saveMapping } from '../../lib/importMapping'
import { getErrorMessage } from '../../lib/errors'
import {
  normalizeAssetImportRow,
  normalizeBulkImportRow,
  validateAssetImportRow,
  validateBulkImportRow,
  type NormalizedAssetImportRow,
  type NormalizedBulkImportRow,
  type RawAssetImportRow,
  type RawBulkImportRow,
} from '../../lib/importValidation'
import { normalizeSerial } from '../../lib/serial'
import {
  useCommitAssetImport,
  useCommitBulkImport,
  useExistingBulkItemKeys,
  useExistingSerials,
  type AssetImportIssue,
  type AssetImportResult,
  type BulkImportResult,
} from './api'

type ImportTarget = AssetCollection | 'bulk_items'

const ASSET_FIELDS: { key: keyof RawAssetImportRow; label: string; required: boolean }[] = [
  { key: 'name', label: 'Name', required: true },
  { key: 'category', label: 'Category', required: true },
  { key: 'serial', label: 'Serial', required: true },
  { key: 'status', label: 'Status', required: false },
  { key: 'assigned_to', label: 'Assigned to', required: false },
  { key: 'location', label: 'Location', required: false },
]

const BULK_FIELDS: { key: keyof RawBulkImportRow; label: string; required: boolean }[] = [
  { key: 'name', label: 'Name', required: true },
  { key: 'category', label: 'Category', required: true },
  { key: 'location', label: 'Location', required: false },
  { key: 'quantity', label: 'Quantity received', required: false },
]

const TARGET_LABELS: Record<ImportTarget, string> = {
  serialized_assets: 'Serialized Assets',
  active_laptops_np: 'Active Laptops (NP)',
  monitors: 'Monitors',
  other_equipment: 'Other Equipment',
  bulk_items: 'Bulk Stock',
}

const TARGET_PATH: Record<ImportTarget, string> = {
  serialized_assets: '/laptops?scope=company',
  active_laptops_np: '/laptops?scope=np',
  monitors: '/monitors',
  other_equipment: '/other-equipment',
  bulk_items: '/bulk-stock',
}

const DEVICE_PATH: Record<AssetCollection, string> = {
  serialized_assets: '/serialized-assets',
  active_laptops_np: '/active-laptops-np',
  monitors: '/monitors',
  other_equipment: '/other-equipment',
}

type Row = { rowIndex: number; errors: string[]; isUpdate: boolean }
type AssetRow = Row & { data: NormalizedAssetImportRow }
type BulkRow = Row & { data: NormalizedBulkImportRow }

type Step = 'upload' | 'map' | 'preview' | 'done'

export function ImportWizard({ target }: { target: ImportTarget }) {
  const navigate = useNavigate()
  const isBulk = target === 'bulk_items'

  const [step, setStep] = useState<Step>('upload')
  const [filename, setFilename] = useState('')
  const [sheets, setSheets] = useState<ParsedSheet[]>([])
  const [sheetIndex, setSheetIndex] = useState(0)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<
    BulkImportResult | AssetImportResult | null
  >(null)
  // Spreadsheet row number of each committed row (the server numbers them 1…n).
  const [sheetRowNumbers, setSheetRowNumbers] = useState<number[]>([])
  const [confirmNewDelivery, setConfirmNewDelivery] = useState(false)

  const existingSerials = useExistingSerials(
    (isBulk ? 'serialized_assets' : target) as AssetCollection,
    !isBulk,
  )
  const existingBulkKeys = useExistingBulkItemKeys(isBulk)
  const commitAsset = useCommitAssetImport((isBulk ? 'serialized_assets' : target) as AssetCollection)
  const commitBulk = useCommitBulkImport()

  const fields = isBulk ? BULK_FIELDS : ASSET_FIELDS
  const sheet = sheets[sheetIndex]

  async function handleFile(file: File) {
    setError(null)
    try {
      const parsed = await parseExcelFile(file)
      if (parsed.length === 0 || parsed[0].rows.length === 0) {
        setError('No data found in this file.')
        return
      }
      setFilename(file.name)
      setSheets(parsed)
      setSheetIndex(0)

      const remembered = loadMapping(target)
      const headers = parsed[0].headers
      const initialMapping: Record<string, string> = {}
      for (const field of fields) {
        const rememberedHeader = remembered?.[field.key]
        if (rememberedHeader && headers.includes(rememberedHeader)) {
          initialMapping[field.key] = rememberedHeader
        }
      }
      setMapping(initialMapping)
      setStep('map')
    } catch (err) {
      console.error('parse excel failed:', err)
      setError(getErrorMessage(err, 'Could not read that file'))
    }
  }

  function proceedToPreview() {
    const missing = fields.filter((f) => f.required && !mapping[f.key])
    if (missing.length > 0) {
      setError(`Map required field${missing.length > 1 ? 's' : ''}: ${missing.map((f) => f.label).join(', ')}`)
      return
    }
    setError(null)
    saveMapping(target, mapping)
    setStep('preview')
  }

  const assetRows = useMemo<AssetRow[]>(() => {
    if (isBulk || !sheet || step !== 'preview') return []
    const seen = new Set<string>()
    return sheet.rows.map((raw, rowIndex) => {
      const mapped: RawAssetImportRow = {
        name: cellToString(raw[mapping.name]),
        category: cellToString(raw[mapping.category]),
        serial: cellToString(raw[mapping.serial]),
        status: mapping.status ? cellToString(raw[mapping.status]) : '',
        assigned_to: mapping.assigned_to ? cellToString(raw[mapping.assigned_to]) : '',
        location: mapping.location ? cellToString(raw[mapping.location]) : '',
      }
      const errors = validateAssetImportRow(mapped, seen)
      if (mapped.serial) seen.add(normalizeSerial(mapped.serial))
      const isUpdate = !!existingSerials.data?.has(normalizeSerial(mapped.serial))
      return { rowIndex, data: normalizeAssetImportRow(mapped), errors, isUpdate }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBulk, sheet, step, mapping, existingSerials.data])

  const bulkRows = useMemo<BulkRow[]>(() => {
    if (!isBulk || !sheet || step !== 'preview') return []
    // The same item twice in one file would be counted twice — flag it.
    const firstRow = new Map<string, number>()
    return sheet.rows.map((raw, rowIndex) => {
      const mapped: RawBulkImportRow = {
        name: cellToString(raw[mapping.name]),
        category: cellToString(raw[mapping.category]),
        location: mapping.location ? cellToString(raw[mapping.location]) : '',
        quantity: mapping.quantity ? cellToString(raw[mapping.quantity]) : '',
      }
      const errors = validateBulkImportRow(mapped)
      const itemKey = `${bulkKey(mapped.name)}|||${bulkKey(mapped.category)}`
      if (mapped.name.trim() && mapped.category.trim()) {
        if (firstRow.has(itemKey)) errors.push(`Same item as row ${firstRow.get(itemKey)} — combine them into one row`)
        else firstRow.set(itemKey, rowIndex + 2)
      }
      const isUpdate = !!existingBulkKeys.data?.has(itemKey)
      return { rowIndex, data: normalizeBulkImportRow(mapped), errors, isUpdate }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBulk, sheet, step, mapping, existingBulkKeys.data])

  const rows = isBulk ? bulkRows : assetRows
  const validRows = rows.filter((r) => r.errors.length === 0)
  const errorRows = rows.filter((r) => r.errors.length > 0)
  const createCount = validRows.filter((r) => !r.isUpdate).length
  const updateCount = validRows.filter((r) => r.isUpdate).length

  async function handleCommit(confirmRepeat = false) {
    setError(null)
    try {
      if (isBulk) {
        const result = await commitBulk.mutateAsync({
          filename,
          rows: bulkRows.filter((r) => r.errors.length === 0).map((r) => r.data),
          confirmRepeat,
        })
        setResult(result)
      } else {
        const committed = assetRows.filter((r) => r.errors.length === 0)
        const result = await commitAsset.mutateAsync({ filename, rows: committed.map((r) => r.data) })
        setSheetRowNumbers(committed.map((r) => r.rowIndex + 2))
        setResult(result)
      }
      setStep('done')
    } catch (err) {
      console.error('import commit failed:', err)
      setError(getErrorMessage(err, 'Import failed'))
    }
  }

  const isCommitting = commitAsset.isPending || commitBulk.isPending

  if (step === 'done' && result && 'duplicate_of' in result && result.duplicate_of) {
    const prev = result.duplicate_of
    return (
      <div className="card mx-auto max-w-2xl space-y-3" role="region" aria-label="Already imported">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Nothing was added</h2>
        <p className="text-sm text-neutral-700 dark:text-neutral-300">
          This file has the same items and quantities as <span className="font-medium">{prev.filename}</span>, imported{' '}
          {new Date(prev.imported_at).toLocaleString()}
          {prev.imported_by ? ` by ${prev.imported_by}` : ''}. Bulk Stock is unchanged.
        </p>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Only if this really is a second, separate delivery of exactly the same items should the quantities be added again.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={confirmNewDelivery} onChange={(e) => setConfirmNewDelivery(e.target.checked)} />
          Yes — this is a new delivery, add these quantities again
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={() => navigate(TARGET_PATH[target])}>
            Leave stock unchanged
          </button>
          <button className="btn-primary" disabled={!confirmNewDelivery || isCommitting} onClick={() => void handleCommit(true)}>
            {isCommitting ? 'Adding…' : 'Add as a new delivery'}
          </button>
        </div>
      </div>
    )
  }

  if (step === 'done' && result) {
    return (
      <div className="card mx-auto max-w-2xl space-y-3 text-center">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          Import complete
        </h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {result.created} created, {result.updated} updated
          {'unchanged' in result && `, ${result.unchanged} already up to date`}.
        </p>
        {'issues' in result && result.issues.length > 0 && (
          <ImportIssues issues={result.issues} sheetRows={sheetRowNumbers} />
        )}
        <button className="btn-primary" onClick={() => navigate(TARGET_PATH[target])}>
          View {TARGET_LABELS[target]}
        </button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
        Import {TARGET_LABELS[target]} from Excel
      </h1>

      {step === 'upload' && (
        <div className="card space-y-3">
          <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Choose a .xlsx or .xls file
          </label>
          <input
            type="file"
            accept=".xlsx,.xls"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void handleFile(file)
            }}
            className="text-sm"
          />
        </div>
      )}

      {step === 'map' && sheet && (
        <div className="card space-y-4">
          {sheets.length > 1 && (
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Sheet
              </span>
              <select
                value={sheetIndex}
                onChange={(e) => setSheetIndex(Number(e.target.value))}
                className="input"
              >
                {sheets.map((s, i) => (
                  <option key={s.sheetName} value={i}>
                    {s.sheetName} ({s.rows.length} rows)
                  </option>
                ))}
              </select>
            </label>
          )}

          <p className="text-sm text-neutral-500">
            Map each ledger field to a column from your sheet ({sheet.rows.length} rows detected).
          </p>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {fields.map((field) => (
              <label key={field.key} className="block">
                <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  {field.label}
                  {field.required && <span className="text-red-500"> *</span>}
                </span>
                <select
                  value={mapping[field.key] ?? ''}
                  onChange={(e) => setMapping((m) => ({ ...m, [field.key]: e.target.value }))}
                  className="input"
                >
                  <option value="">— not mapped —</option>
                  {sheet.headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setStep('upload')}>
              Back
            </button>
            <button className="btn-primary" onClick={proceedToPreview}>
              Preview
            </button>
          </div>
        </div>
      )}

      {step === 'preview' && (
        <div className="space-y-4">
          <div className="card">
            <div className="flex flex-wrap gap-4 text-sm">
              <Stat label="To create" value={createCount} />
              <Stat label={isBulk ? 'To update' : 'Already in the ledger'} value={updateCount} />
              <Stat label="Errors (skipped)" value={errorRows.length} tone={errorRows.length ? 'warn' : undefined} />
            </div>
            {isBulk && (
              <p className="mt-3 text-xs text-neutral-500">
                Each row is a delivery: its Quantity received is added to Available. It is not the stock total. Importing a
                file with the same items and quantities again adds nothing unless you confirm it is a new delivery.
              </p>
            )}
            {!isBulk && (
              <p className="mt-3 text-xs text-neutral-500">
                For devices already in the ledger, only a changed Name, Category or Location is updated; empty
                cells are ignored. An import never changes a device&apos;s status or who it&apos;s assigned to —
                any difference is listed afterwards for you to handle on the device itself.
              </p>
            )}
          </div>

          <div className="card overflow-x-auto">
            <table className="w-full min-w-[600px] border-collapse text-xs">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-neutral-500 dark:border-neutral-800">
                  <th className="py-1.5 pr-3 font-medium">Row</th>
                  {fields.map((f) => (
                    <th key={f.key} className="py-1.5 pr-3 font-medium">
                      {f.label}
                    </th>
                  ))}
                  <th className="py-1.5 pr-3 font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 100).map((r) => (
                  <tr key={r.rowIndex} className="border-b border-neutral-100 dark:border-neutral-900">
                    <td className="py-1 pr-3 text-neutral-400">{r.rowIndex + 2}</td>
                    {isBulk
                      ? BULK_FIELDS.map((f) => (
                          <td key={f.key} className="py-1 pr-3">
                            {String((r as BulkRow).data[f.key])}
                          </td>
                        ))
                      : ASSET_FIELDS.map((f) => (
                          <td key={f.key} className="py-1 pr-3">
                            {String((r as AssetRow).data[f.key])}
                          </td>
                        ))}
                    <td className="py-1 pr-3">
                      {r.errors.length > 0 ? (
                        <span className="text-red-600 dark:text-red-400">{r.errors.join('; ')}</span>
                      ) : r.isUpdate ? (
                        <span className="text-blue-600 dark:text-blue-400">{isBulk ? 'Update' : 'Existing'}</span>
                      ) : (
                        <span className="text-green-600 dark:text-green-400">Create</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 100 && (
              <p className="mt-2 text-xs text-neutral-400">
                Showing first 100 of {rows.length} rows.
              </p>
            )}
          </div>

          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setStep('map')}>
              Back
            </button>
            <button
              className="btn-primary"
              disabled={isCommitting || validRows.length === 0}
              onClick={() => void handleCommit(false)}
            >
              {isCommitting
                ? 'Importing…'
                : `Commit ${validRows.length} row${validRows.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function ImportIssues({ issues, sheetRows }: { issues: AssetImportIssue[]; sheetRows: number[] }) {
  const notApplied = issues.filter((i) => i.kind === 'not_applied')
  const rejected = issues.filter((i) => i.kind === 'rejected')
  return (
    <div className="space-y-3 text-left text-sm">
      {notApplied.length > 0 && (
        <IssueList
          title={`Not applied — ${notApplied.length} status or assignment difference${notApplied.length === 1 ? '' : 's'}`}
          note="Imports never change status or assignment. If the sheet is right, use Provide, Transfer or Collect on the device."
          issues={notApplied}
          sheetRows={sheetRows}
        />
      )}
      {rejected.length > 0 && (
        <IssueList
          title={`Skipped — ${rejected.length} row${rejected.length === 1 ? '' : 's'}`}
          issues={rejected}
          sheetRows={sheetRows}
        />
      )}
    </div>
  )
}

function IssueList({
  title,
  note,
  issues,
  sheetRows,
}: {
  title: string
  note?: string
  issues: AssetImportIssue[]
  sheetRows: number[]
}) {
  return (
    <section aria-label={title} className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900/50 dark:bg-amber-950/20">
      <h3 className="font-medium text-amber-800 dark:text-amber-300">{title}</h3>
      {note && <p className="mt-0.5 text-xs text-neutral-600 dark:text-neutral-400">{note}</p>}
      <ul className="mt-2 space-y-1 text-xs">
        {issues.map((i, n) => (
          <li key={n}>
            <span className="text-neutral-400">Row {sheetRows[i.row - 1] ?? i.row}</span>{' '}
            {i.asset_id && i.collection ? (
              <Link className="font-mono underline" to={`${DEVICE_PATH[i.collection]}/${i.asset_id}`}>
                {i.serial}
              </Link>
            ) : (
              <span className="font-mono">{i.serial || '(no serial)'}</span>
            )}
            {': '}
            {i.field
              ? `${i.field === 'status' ? 'status' : 'assigned to'} is "${i.current ?? ''}", sheet says "${i.requested ?? ''}"`
              : i.reason}
          </li>
        ))}
      </ul>
    </section>
  )
}

const bulkKey = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'warn' }) {
  return (
    <div>
      <div
        className={`text-lg font-semibold tabular-nums ${
          tone === 'warn' && value > 0
            ? 'text-amber-600 dark:text-amber-400'
            : 'text-neutral-900 dark:text-neutral-100'
        }`}
      >
        {value}
      </div>
      <div className="text-neutral-500">{label}</div>
    </div>
  )
}

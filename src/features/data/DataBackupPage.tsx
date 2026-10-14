import { useRef, useState } from 'react'
import { getErrorMessage } from '../../lib/errors'
import { useExportBackup, useRestoreBackup, type BackupFile } from './api'

const CONFIRM_PHRASE = 'RESTORE'

export function DataBackupPage() {
  const exportBackup = useExportBackup()
  const restoreBackup = useRestoreBackup()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [pendingFile, setPendingFile] = useState<{ name: string; backup: BackupFile } | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [restoredAt, setRestoredAt] = useState<string | null>(null)

  async function handleExport() {
    setError(null)
    try {
      const backup = await exportBackup.mutateAsync()
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const date = backup.exported_at.slice(0, 10)
      a.href = url
      a.download = `equipment-ledger-backup-${date}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to export backup'))
    }
  }

  async function handleFileSelected(file: File) {
    setError(null)
    setRestoredAt(null)
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as BackupFile
      if (!parsed || typeof parsed !== 'object' || !parsed.tables) {
        throw new Error('This file does not look like an Equipment Ledger backup.')
      }
      setPendingFile({ name: file.name, backup: parsed })
      setConfirmText('')
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to read that file'))
    }
  }

  async function handleRestore() {
    if (!pendingFile) return
    setError(null)
    try {
      await restoreBackup.mutateAsync(pendingFile.backup)
      setRestoredAt(new Date().toLocaleString())
      setPendingFile(null)
      setConfirmText('')
      if (fileInputRef.current) fileInputRef.current.value = ''
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to restore backup'))
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Data</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Export a full snapshot of the ledger, or restore one from a previous export.
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {restoredAt && (
        <p role="status" className="text-sm text-teal-700 dark:text-teal-400">
          Backup restored at {restoredAt}.
        </p>
      )}

      <div className="card space-y-2">
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          Export backup
        </h2>
        <p className="text-sm text-neutral-500">
          Downloads every asset, checklist, and history row as a single JSON file.
        </p>
        <button
          className="btn-primary"
          onClick={() => void handleExport()}
          disabled={exportBackup.isPending}
        >
          {exportBackup.isPending ? 'Exporting…' : 'Export backup'}
        </button>
      </div>

      <div className="card space-y-3 border-red-200 dark:border-red-900/50">
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          Import backup
        </h2>
        <p className="text-sm text-red-600 dark:text-red-400">
          This <span className="font-semibold">permanently deletes</span> all current assets,
          checklists, and history and replaces them with the contents of the uploaded file.
          Anything created after that backup was taken will be lost. This cannot be undone —
          export a fresh backup first if you want to keep the current data.
        </p>

        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void handleFileSelected(file)
          }}
          className="block text-sm text-neutral-600 dark:text-neutral-400"
        />

        {pendingFile && (
          <div className="space-y-2 rounded-lg border border-red-200 bg-red-50/60 p-3 dark:border-red-900/50 dark:bg-red-950/20">
            <p className="text-sm text-neutral-700 dark:text-neutral-300">
              About to restore <span className="font-medium">{pendingFile.name}</span> (exported{' '}
              {new Date(pendingFile.backup.exported_at).toLocaleString()}), wiping all current
              data. Type <span className="font-mono font-semibold">{CONFIRM_PHRASE}</span> to
              confirm.
            </p>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={CONFIRM_PHRASE}
              className="w-full max-w-xs rounded-lg border border-red-300 bg-white px-3 py-2 text-sm outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100 dark:border-red-900 dark:bg-neutral-900"
            />
            <div className="flex gap-2">
              <button
                className="rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-red-700 disabled:opacity-50"
                disabled={confirmText !== CONFIRM_PHRASE || restoreBackup.isPending}
                onClick={() => void handleRestore()}
              >
                {restoreBackup.isPending ? 'Restoring…' : 'Restore and overwrite everything'}
              </button>
              <button
                className="btn-secondary"
                onClick={() => {
                  setPendingFile(null)
                  setConfirmText('')
                  if (fileInputRef.current) fileInputRef.current.value = ''
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

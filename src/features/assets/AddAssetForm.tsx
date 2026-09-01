import { useState, type FormEvent, type ReactNode } from 'react'
import type { AssetCollection } from '../../types/database.types'
import { useCreateAsset } from './api'

export function AddAssetForm({
  collection,
  initialSerial,
  onCreated,
  onCancel,
}: {
  collection: AssetCollection
  initialSerial?: string
  onCreated: (id: string) => void
  onCancel: () => void
}) {
  const createAsset = useCreateAsset(collection)
  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [serial, setSerial] = useState(initialSerial ?? '')
  const [location, setLocation] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      const id = await createAsset.mutateAsync({
        name,
        category,
        serial,
        location: location || null,
      })
      onCreated(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create asset')
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Field label="Name">
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="input"
        />
      </Field>
      <Field label="Category">
        <input
          required
          placeholder="Laptop, Monitor, ..."
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="input"
        />
      </Field>
      <Field label="Serial number">
        <input
          required
          value={serial}
          onChange={(e) => setSerial(e.target.value)}
          className="input font-mono"
        />
      </Field>
      <Field label="Location (optional)">
        <input
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          className="input"
        />
      </Field>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onCancel} className="btn-secondary">
          Cancel
        </button>
        <button type="submit" disabled={createAsset.isPending} className="btn-primary">
          {createAsset.isPending ? 'Adding…' : 'Add asset'}
        </button>
      </div>
    </form>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
        {label}
      </span>
      {children}
    </label>
  )
}

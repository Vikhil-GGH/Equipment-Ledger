import { useState, type FormEvent } from 'react'
import { getErrorMessage } from '../../lib/errors'
import { useCreateBulkItem } from './api'

export function AddBulkItemForm({
  onCreated,
  onCancel,
}: {
  onCreated: (id: string) => void
  onCancel: () => void
}) {
  const createItem = useCreateBulkItem()
  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [location, setLocation] = useState('')
  const [initialQuantity, setInitialQuantity] = useState('0')
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      const id = await createItem.mutateAsync({
        name,
        category,
        location: location || null,
        initialQuantity: Number(initialQuantity) || 0,
      })
      onCreated(id)
    } catch (err) {
      console.error('create_bulk_item failed:', err)
      setError(getErrorMessage(err, 'Failed to create item'))
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Name
        </span>
        <input required value={name} onChange={(e) => setName(e.target.value)} className="input" />
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Category
        </span>
        <input
          required
          placeholder="Mouse, Charger, Headset, ..."
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="input"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Location (optional)
        </span>
        <input value={location} onChange={(e) => setLocation(e.target.value)} className="input" />
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Initial quantity (available)
        </span>
        <input
          type="number"
          min={0}
          value={initialQuantity}
          onChange={(e) => setInitialQuantity(e.target.value)}
          className="input"
        />
      </label>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onCancel} className="btn-secondary">
          Cancel
        </button>
        <button type="submit" disabled={createItem.isPending} className="btn-primary">
          {createItem.isPending ? 'Adding…' : 'Add item'}
        </button>
      </div>
    </form>
  )
}

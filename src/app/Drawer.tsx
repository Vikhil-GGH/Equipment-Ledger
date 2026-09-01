import { useEffect, type ReactNode } from 'react'

export function Drawer({
  open,
  onClose,
  children,
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  return (
    <div
      className={`fixed inset-0 z-50 sm:hidden ${open ? '' : 'pointer-events-none'}`}
      aria-hidden={!open}
    >
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${
          open ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <nav
        className={`absolute inset-y-0 left-0 flex w-72 max-w-[80vw] flex-col gap-1 bg-white p-4 shadow-lg transition-transform duration-200 ease-out dark:bg-neutral-900 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {children}
      </nav>
    </div>
  )
}

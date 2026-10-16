/**
 * One status palette for every chart and card on the Overview, so a status
 * group looks the same for laptops, monitors, other equipment and bulk
 * stock. The groups are Laptop Inventory's own tabs (laptopTab in
 * features/laptops/laptopInventory.ts). Colours stay distinguishable for
 * common colour-vision deficiencies, and every chart also prints its labels
 * and numbers — colour is never the only cue. Class names are written out
 * in full so Tailwind keeps them.
 */
export type StatusGroup = 'active' | 'available' | 'damaged' | 'other'

export const GROUP_ORDER: StatusGroup[] = ['active', 'available', 'damaged', 'other']

export const GROUP_LABELS: Record<StatusGroup, string> = {
  active: 'Active / Assigned',
  available: 'Available',
  damaged: 'Damaged / Repair',
  other: 'Other',
}

export const GROUP_CLASSES: Record<StatusGroup, { bg: string; stroke: string; text: string; soft: string }> = {
  active: { bg: 'bg-sky-600', stroke: 'stroke-sky-600', text: 'text-sky-700 dark:text-sky-400', soft: 'bg-sky-50 dark:bg-sky-950/40' },
  available: { bg: 'bg-emerald-500', stroke: 'stroke-emerald-500', text: 'text-emerald-700 dark:text-emerald-400', soft: 'bg-emerald-50 dark:bg-emerald-950/40' },
  damaged: { bg: 'bg-amber-500', stroke: 'stroke-amber-500', text: 'text-amber-700 dark:text-amber-400', soft: 'bg-amber-50 dark:bg-amber-950/40' },
  other: { bg: 'bg-slate-400', stroke: 'stroke-slate-400', text: 'text-slate-600 dark:text-slate-400', soft: 'bg-slate-100 dark:bg-slate-800/60' },
}

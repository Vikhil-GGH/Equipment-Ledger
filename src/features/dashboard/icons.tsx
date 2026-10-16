// Small inline icons (no icon library). Decorative: always paired with text.
const base = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const

export const LaptopIcon = () => (
  <svg {...base}><rect x="4" y="5" width="16" height="10" rx="1.5" /><path d="M2 19h20" /></svg>
)
export const CheckIcon = () => (
  <svg {...base}><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></svg>
)
export const UserIcon = () => (
  <svg {...base}><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></svg>
)
export const StackIcon = () => (
  <svg {...base}><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 13 9 5 9-5" /></svg>
)
export const MonitorIcon = () => (
  <svg {...base}><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M9 20h6M12 16v4" /></svg>
)
export const BoxIcon = () => (
  <svg {...base}><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5v-9Z" /><path d="m3 7.5 9 4.5 9-4.5M12 12v9" /></svg>
)
export const LayersIcon = () => (
  <svg {...base}><rect x="4" y="4" width="16" height="5" rx="1" /><rect x="4" y="11" width="16" height="5" rx="1" /><path d="M6 20h12" /></svg>
)
export const AlertIcon = () => (
  <svg {...base}><path d="M12 3 2 20h20L12 3Z" /><path d="M12 10v4M12 17h.01" /></svg>
)
export const ArrowIcon = () => (
  <svg {...base} width={16} height={16}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
)

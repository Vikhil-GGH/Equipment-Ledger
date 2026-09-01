import sharp from 'sharp'
import { mkdirSync } from 'node:fs'

const src = 'scripts/icon-source.svg'
mkdirSync('public/icons', { recursive: true })

const sizes = [
  { file: 'public/icons/icon-192.png', size: 192 },
  { file: 'public/icons/icon-512.png', size: 512 },
  { file: 'public/icons/maskable-512.png', size: 512, padded: true },
  { file: 'public/favicon-32.png', size: 32 },
  { file: 'public/apple-touch-icon.png', size: 180 },
]

for (const { file, size, padded } of sizes) {
  const img = sharp(src).resize(size, size)
  if (padded) {
    // Maskable icons need safe-zone padding so OS masks don't clip the mark.
    const inner = Math.round(size * 0.7)
    await sharp(src)
      .resize(inner, inner)
      .extend({
        top: Math.round((size - inner) / 2),
        bottom: Math.round((size - inner) / 2),
        left: Math.round((size - inner) / 2),
        right: Math.round((size - inner) / 2),
        background: '#0f172a',
      })
      .png()
      .toFile(file)
  } else {
    await img.png().toFile(file)
  }
  console.log('wrote', file)
}

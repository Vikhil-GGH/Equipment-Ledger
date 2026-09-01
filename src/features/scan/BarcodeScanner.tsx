import { useEffect, useId, useRef, useState } from 'react'
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode'
import { getErrorMessage } from '../../lib/errors'

// Asset tags in the wild are QR codes or common 1D barcodes — cover both
// rather than assuming one.
const FORMATS = [
  Html5QrcodeSupportedFormats.QR_CODE,
  Html5QrcodeSupportedFormats.CODE_128,
  Html5QrcodeSupportedFormats.CODE_39,
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
  Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E,
]

export function BarcodeScanner({ onDetected }: { onDetected: (value: string) => void }) {
  const containerId = useId()
  const [error, setError] = useState<string | null>(null)
  const onDetectedRef = useRef(onDetected)

  useEffect(() => {
    onDetectedRef.current = onDetected
  }, [onDetected])

  useEffect(() => {
    let cancelled = false
    let detected = false

    const scanner = new Html5Qrcode(containerId, {
      formatsToSupport: FORMATS,
      // Prefer the native BarcodeDetector API where the browser supports
      // it; html5-qrcode transparently falls back to its own JS decoder
      // otherwise. iOS Safari doesn't ship BarcodeDetector, so this is
      // what actually makes scanning work there — never rely on the
      // native API alone.
      useBarCodeDetectorIfSupported: true,
      verbose: false,
    })

    scanner
      .start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: 250 },
        (decodedText) => {
          if (detected) return
          detected = true
          onDetectedRef.current(decodedText.trim())
        },
        () => {
          // Fires continuously while no code is in frame — not a real error.
        },
      )
      .then(() => {
        if (cancelled) {
          void scanner.stop().then(() => scanner.clear())
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            getErrorMessage(
              err,
              'Could not access the camera. Check permissions, and that this page is served over HTTPS.',
            ),
          )
        }
      })

    return () => {
      cancelled = true
      if (scanner.isScanning) {
        scanner.stop().then(() => scanner.clear()).catch(() => {})
      } else {
        try {
          scanner.clear()
        } catch {
          // Nothing was ever rendered — safe to ignore.
        }
      }
    }
    // containerId (useId()) is stable for the component's lifetime, so this
    // effect intentionally still only runs once on mount.
  }, [containerId])

  return (
    <div>
      <div id={containerId} className="overflow-hidden rounded-lg bg-black" />
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  )
}

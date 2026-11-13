import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'

/**
 * Lector de código de barras con la cámara (EAN-13, EAN-8, UPC, Code-128,
 * Code-39 e ITF). Un solo disparo por lectura: al reconocer un código llama a
 * onScan(texto) y se detiene. La entrada manual vive SIEMPRE abajo: cubre las
 * mesas sin cámara, el permiso denegado y el contexto no seguro (getUserMedia
 * exige HTTPS o localhost — en cualquier otro caso se sigue poder teclear).
 *
 * El decodificador (@zxing/browser) se importa dinámicamente para que su peso
 * quede en un chunk aparte que solo se baja al abrir el escáner — y que el
 * precache del service worker deja disponible sin conexión.
 *
 * Mismo patrón de overlay que Modal.jsx: bottom-sheet en móvil, centrado en
 * pantallas grandes, Escape cierra.
 */
export function BarcodeScanner({ title = 'Escanear código de barras', onScan, onClose }) {
  const videoRef = useRef(null)
  const controlsRef = useRef(null)
  const [status, setStatus] = useState('starting') // starting | scanning | error
  const [error, setError] = useState('')
  const [manual, setManual] = useState('')
  // El callback vive en un ref: reiniciar la cámara en cada render del padre
  // sería un parpadeo por cada tecla que se teclea detrás del modal.
  const onScanRef = useRef(onScan)
  onScanRef.current = onScan

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!window.isSecureContext) {
        setStatus('error')
        setError('La cámara necesita una conexión segura (HTTPS). Escribe el código a mano abajo.')
        return
      }
      try {
        const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
          import('@zxing/browser'),
          import('@zxing/library'),
        ])
        if (cancelled || !videoRef.current) return
        videoRef.current.setAttribute('playsinline', 'true')
        const hints = new Map([[
          DecodeHintType.POSSIBLE_FORMATS,
          [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
            BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.ITF],
        ]])
        const reader = new BrowserMultiFormatReader(hints)
        const controls = await reader.decodeFromConstraints(
          { video: { facingMode: 'environment' } },
          videoRef.current,
          (result) => {
            if (cancelled || !result) return
            controlsRef.current?.stop()
            try { navigator.vibrate?.(80) } catch { /* sin vibración no pasa nada */ }
            onScanRef.current?.(result.getText())
          },
        )
        controlsRef.current = controls
        if (cancelled) { controls.stop(); return }
        setStatus('scanning')
      } catch (err) {
        if (cancelled) return
        setStatus('error')
        const name = err?.name || ''
        setError(
          name === 'NotAllowedError'
            ? 'Permiso de cámara denegado. Actívalo en los ajustes del navegador o escribe el código a mano abajo.'
            : name === 'NotFoundError' || name === 'OverconstrainedError'
              ? 'No se encontró una cámara en este dispositivo. Escribe el código a mano abajo.'
              : name === 'NotReadableError'
                ? 'La cámara está ocupada por otra aplicación. Ciérrala y vuelve a intentar, o escribe el código a mano.'
                : 'No se pudo abrir la cámara. Escribe el código a mano abajo.',
        )
      }
    })()
    return () => {
      cancelled = true
      controlsRef.current?.stop()
      controlsRef.current = null
    }
  }, [])

  const submitManual = (e) => {
    e.preventDefault()
    const code = manual.trim().replace(/\s+/g, ' ')
    if (!code) return
    onScanRef.current?.(code)
  }

  return (
    <div role="dialog" aria-modal="true" aria-label={title}
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl max-h-[92vh] overflow-auto safe-area-bottom">
        <div className="flex justify-between items-center px-6 py-5 border-b border-gray-100">
          <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
          <button onClick={onClose} aria-label="Cerrar" className="p-2 hover:bg-gray-100 rounded-xl">
            <X size={20} className="text-gray-500" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div className="relative rounded-xl overflow-hidden bg-black aspect-[4/3]">
            <video ref={videoRef} muted autoPlay className="absolute inset-0 w-full h-full object-cover" />
            {status !== 'error' && (
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                <div className="w-3/4 h-1/2 border-2 border-white/70 rounded-lg relative">
                  <div className="absolute left-3 right-3 top-1/2 h-0.5 bg-[#007AFF]/90" />
                </div>
              </div>
            )}
            {status === 'starting' && (
              <div className="absolute inset-0 flex items-center justify-center">
                <p className="text-white/80 text-sm">Abriendo la cámara…</p>
              </div>
            )}
          </div>
          <p className="text-xs text-gray-500" aria-live="polite">
            {status === 'error'
              ? error
              : status === 'starting'
                ? 'Abriendo la cámara… también puedes escribir el código a mano mientras abre.'
                : 'Apunta al código de barras del producto. Se lee solo al enfocarlo.'}
          </p>
          <form onSubmit={submitManual} className="flex gap-2">
            <input
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="Escribe el código a mano…"
              aria-label="Código de barras a mano"
              className="w-full border border-gray-200 rounded-xl px-4 py-3 text-base focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors"
            />
            <button
              type="submit"
              disabled={!manual.trim()}
              className="shrink-0 px-4 py-3 rounded-xl bg-[#007AFF] text-white font-semibold disabled:opacity-40"
            >
              Usar
            </button>
          </form>
          <p className="text-xs text-gray-400">Sin cámara o sin permiso también funciona: teclea los dígitos del código.</p>
        </div>
      </div>
    </div>
  )
}

export default BarcodeScanner

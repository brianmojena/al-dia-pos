import { useEffect } from 'react'
import { X } from 'lucide-react'

/**
 * Modal de fondo oscurecido con panel blanco: bottom-sheet en móvil y centrado
 * en pantallas grandes. Es el patrón que Almacen, Caja y Dashboard llevaban
 * copiado a mano; las pantallas nuevas importan este en vez de repetirlo.
 * Escape cierra, igual que el botón de la X.
 */
export default function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4"
    >
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl max-h-[90vh] overflow-auto">
        <div className="flex justify-between items-center px-6 py-5 border-b border-gray-100">
          <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
          <button onClick={onClose} aria-label="Cerrar" className="p-2 hover:bg-gray-100 rounded-xl">
            <X size={20} className="text-gray-500" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

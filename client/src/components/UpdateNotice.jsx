import { useEffect, useRef, useState } from 'react'
import Modal from './Modal'

export const UPDATE_AT = '2026-11-14T01:00:00-05:00'

export function UpdateNoticeContent({ onClose, upcoming }) {
  return (
    <Modal title={upcoming ? 'Próxima actualización' : 'Novedades de Al Día'} onClose={onClose}>
      <div className="px-6 py-5">
        {upcoming && <p className="text-sm leading-relaxed text-blue-800 bg-blue-50 rounded-xl px-4 py-3 mb-5">
          Prevista para el <time dateTime={UPDATE_AT} className="font-semibold">14 de noviembre a la 1:00 a. m.</time>, hora de Cuba.
        </p>}
        <p className="text-base font-semibold text-gray-900 mb-4">Más formas de mostrar tus productos y llevar las cuentas.</p>
        <dl className="space-y-4 text-sm leading-relaxed">
          <div>
            <dt className="font-semibold text-gray-900">Tu catálogo en la web</dt>
            <dd className="text-gray-600 mt-1">Activa tu tienda online, elige qué productos publicar y comparte el enlace por WhatsApp. Tus clientes podrán consultar precios y disponibilidad, y enviar reservas para que las confirmes.</dd>
          </div>
          <div>
            <dt className="font-semibold text-gray-900">Lector de códigos de barras</dt>
            <dd className="text-gray-600 mt-1">Desde Productos, usa la cámara para localizar un producto o darlo de alta con su código. También podrás escribir el código a mano.</dd>
          </div>
          <div>
            <dt className="font-semibold text-gray-900">Contabilidad más clara · Enterprise</dt>
            <dd className="text-gray-600 mt-1">Organiza los gastos por categoría, registra divisas con la tasa del día y compara tus resultados por mes o por año. Podrás registrar y anular gastos sin conexión y sincronizarlos al volver internet.</dd>
          </div>
        </dl>
        <p className="text-sm leading-relaxed text-gray-600 mt-5">El catálogo necesita internet y muestra la información que tu negocio haya sincronizado.</p>
        <button type="button" onClick={onClose} className="w-full mt-5 min-h-11 px-4 py-3 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600">
          Seguir trabajando
        </button>
      </div>
    </Modal>
  )
}

export default function UpdateNotice({ userId }) {
  const storageKey = `mypimes_update_2026-11-14:${userId}`
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(storageKey) !== 'seen' } catch { return true }
  })
  const container = useRef(null)

  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement
    const dialog = container.current.querySelector('[role="dialog"]')
    const buttons = dialog.querySelectorAll('button')
    buttons[buttons.length - 1].focus()
    const trapFocus = (event) => {
      if (event.key !== 'Tab') return
      const buttons = dialog.querySelectorAll('button')
      const first = buttons[0]
      const last = buttons[buttons.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    dialog.addEventListener('keydown', trapFocus)
    return () => { dialog.removeEventListener('keydown', trapFocus); previousFocus?.focus() }
  }, [open])

  const close = () => {
    setOpen(false)
    try { localStorage.setItem(storageKey, 'seen') } catch { /* El aviso se cierra aunque el navegador no pueda recordarlo. */ }
  }

  return open && <div ref={container}><UpdateNoticeContent onClose={close} upcoming={true} /></div>
}

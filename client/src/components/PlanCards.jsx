import { Store, Sparkles, Check } from 'lucide-react'

// El cobro no tiene pasarela: se paga en persona. El Plan Enterprise incluye
// la app de monitorización del jefe y hasta 2 sucursales.
const PLANS = [
  {
    id: 'basic',
    icon: Store,
    title: 'Plan Basic',
    price: '$10 USD',
    priceNote: '/mes',
    tag: 'Pago físico (en persona)',
    features: ['Hasta 5 usuarios simultáneos', 'Todas las funciones de la app'],
  },
  {
    id: 'enterprise',
    icon: Sparkles,
    title: 'Plan Enterprise',
    price: '$15 USD',
    priceNote: '/mes',
    tag: 'Pago físico (en persona)',
    features: [
      'Hasta 10 usuarios simultáneos',
      'App de monitorización para el jefe',
      'Gestión de hasta 2 sucursales',
    ],
  },
]

/** Tarjetas de los planes comerciales; `current` marca el de la tienda. */
export default function PlanCards({ current }) {
  return (
    <div className="grid grid-cols-1 gap-3 text-left">
      {PLANS.map(p => {
        const Icon = p.icon
        const selected = current === p.id
        return (
          <div
            key={p.id}
            className={`relative rounded-2xl p-4 border-2 ${
              selected ? 'border-[#007AFF] bg-blue-50/40' : 'border-gray-200 bg-white'
            }`}
          >
            {selected && (
              <div className="absolute top-3 right-3 w-5 h-5 bg-[#007AFF] rounded-full flex items-center justify-center">
                <Check size={12} className="text-white" strokeWidth={3} />
              </div>
            )}
            <Icon size={20} className={selected ? 'text-[#007AFF]' : 'text-gray-400'} />
            <p className="font-bold text-gray-900 mt-2">{p.title}</p>
            <p className="text-lg font-bold text-gray-900 mt-0.5">
              {p.price} <span className="text-xs font-medium text-gray-400">{p.priceNote}</span>
            </p>
            <p className="text-[11px] text-gray-400 mt-1">{p.tag}</p>
            <ul className="mt-2.5 space-y-1">
              {p.features.map(f => (
                <li key={f} className="text-xs text-gray-500 flex items-start gap-1.5">
                  <Check size={11} className="mt-0.5 flex-shrink-0 text-green-500" />
                  {f}
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

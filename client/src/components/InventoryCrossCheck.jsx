import { crossCheckTone, crossCheckRows } from '../lib/inventoryCrossCheck'

export default function InventoryCrossCheck({ check }) {
  if (!check) return null

  const tone = crossCheckTone(check.verdict)
  const rows = crossCheckRows(check)

  return (
    <div className="bg-white rounded-2xl shadow-sm p-5 mb-4">
      <h3 className="font-semibold text-sm mb-3 text-gray-900">Cruce con el último arqueo</h3>

      <div className={`rounded-xl px-4 py-3 mb-4 flex items-start gap-3 ${tone.bg}`}>
        <tone.Icon size={16} className={`flex-shrink-0 mt-0.5 ${tone.iconColor}`} />
        <p className={`text-sm font-medium ${tone.textColor}`}>{check.message}</p>
      </div>

      {check.available && (
        <div className="space-y-2 text-sm">
          {rows.map((row, idx) => (
            <div key={idx} className="flex justify-between gap-4 py-1.5 border-b border-gray-50 last:border-0">
              <span className="text-gray-500">{row.label}</span>
              <span className={`font-semibold text-right ${row.tone || 'text-gray-900'}`}>
                {row.value}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

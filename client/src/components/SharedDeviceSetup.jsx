import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Check, CheckCircle2, Copy, KeyRound, MonitorSmartphone, RefreshCw, ShieldCheck, Users } from 'lucide-react'
import { apiFetch } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { installSharedDevice, getSharedDevice, refreshSharedEnrollment, hashPin } from '../lib/sharedDevice.js'
import { canReplaceSharedDevice } from '../lib/offlineClient.js'
import { formatDateTime } from '../lib/dates'

// Estado inicial de cada cajero candidato en el formulario.
const blankMember = () => ({ selected: false, display_name: '', pin: '', confirm: '' })
const isSixDigits = (value) => /^\d{6}$/.test(value)
const prettyCode = (value) => (value.match(/.{1,4}/g) || []).join('-')

/**
 * Configuración de una caja compartida para una tienda (solo administración).
 *
 * - Carga los cajeros de la tienda desde el servidor.
 * - El PIN de cada cajero NUNCA viaja al servidor: se queda en este dispositivo
 *   y solo se usa para instalar el acceso local.
 * - Antes de pedir la configuración se comprueba que no queden cambios
 *   pendientes ni caja abierta en este aparato; si los hay, se rechaza.
 * - Al terminar, instala la caja en ESTE navegador y deja el selector de
 *   cajeros bloqueado (sin conservar la sesión de administración).
 *
 * Props: shop (fila del panel), onInstalled (callback opcional tras instalar).
 */
export default function SharedDeviceSetup({ shop, onInstalled }) {
  const navigate = useNavigate()
  const { completeSharedSetup } = useAuth()
  const [device,      setDevice]      = useState(getSharedDevice)
  const [members,     setMembers]     = useState(null)
  const [rows,        setRows]        = useState({})
  const [name,        setName]        = useState('')
  const [continuous,  setContinuous]  = useState(false)
  const [showForm,    setShowForm]    = useState(!getSharedDevice())
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState('')
  const [notice,      setNotice]      = useState('')
  const [submitting,  setSubmitting]  = useState(false)
  const [renewing,    setRenewing]    = useState(false)
  const [code,        setCode]        = useState('')
  const [codeExpiry,  setCodeExpiry]  = useState('')
  const [generating,  setGenerating]  = useState(false)
  const [copied,      setCopied]      = useState(false)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await apiFetch(`/api/admin/shared-devices/shops/${shop.id}/cashiers`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'No se pudieron cargar los cajeros de la tienda')
      const list = Array.isArray(data.cashiers) ? data.cashiers : []
      setMembers(list)
      setRows(Object.fromEntries(list.map((c) => [c.id, blankMember()])))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [shop.id])

  const update = (id, patch) => setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))
  const cashiers = members || []
  const selected = cashiers.filter((c) => rows[c.id]?.selected)

  const validate = () => {
    if (!name.trim()) return 'Ponle un nombre a la caja (por ejemplo, "Tablet mostrador").'
    if (name.trim().length > 80) return 'El nombre de la caja es demasiado largo.'
    if (!selected.length) return 'Elige al menos un cajero autorizado.'
    for (const c of selected) {
      const row = rows[c.id]
      const label = row.display_name.trim() || c.email
      if (!row.display_name.trim()) return `Escribe el nombre visible de ${c.email}.`
      if (row.display_name.trim().length > 60) return `El nombre visible de ${label} es demasiado largo.`
      if (!isSixDigits(row.pin)) return `El PIN de ${label} debe tener exactamente 6 dígitos.`
      if (row.pin !== row.confirm) return `La confirmación del PIN de ${label} no coincide.`
    }
    return ''
  }

  const submit = async () => {
    setError('')
    setNotice('')
    const problem = validate()
    if (problem) { setError(problem); return }

    setSubmitting(true)
    try {
      // Nunca reemplazar una caja instalada con cambios pendientes o caja abierta.
      const gate = await canReplaceSharedDevice()
      if (!gate?.allowed) throw new Error(gate?.error || 'No se puede configurar la caja en este dispositivo.')

      // El PIN no se envía: solo identidad y nombre visible.
      const res = await apiFetch('/api/admin/shared-devices', {
        method: 'POST',
        body: JSON.stringify({
          owner_id: shop.id,
          name: name.trim(),
          continuous,
          cashiers: selected.map((c) => ({ id: c.id, display_name: rows[c.id].display_name.trim() })),
        }),
      })
      const bundle = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(bundle.error || 'No se pudo crear la caja compartida')

      const pins = Object.fromEntries(selected.map((c) => [c.id, rows[c.id].pin]))
      try {
        const finalGate = await canReplaceSharedDevice()
        if (!finalGate.allowed) throw new Error(finalGate.error)
        await installSharedDevice(bundle, pins)
      } catch (installError) {
        // El servidor la creó, pero este aparato no la guardó: error, no éxito.
        throw new Error(`La caja quedó creada en el servidor, pero no se pudo instalar en este dispositivo: ${installError.message}`)
      }

      onInstalled?.(bundle)
      completeSharedSetup()
      navigate('/cajero', { replace: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  // Activación remota: el administrador está en otro lugar y no puede instalar
  // la caja en el aparato del negocio. En vez de eso cifra aquí los PIN, el
  // servidor guarda un código de un solo uso y el aparato lo canjea en /activar
  // sin que nadie teclee un PIN.
  const generateCode = async () => {
    setError('')
    setNotice('')
    setCode('')
    setCopied(false)
    const problem = validate()
    if (problem) { setError(problem); return }
    setGenerating(true)
    try {
      const cashiers = []
      for (const c of selected) cashiers.push({ id: c.id, display_name: rows[c.id].display_name.trim(), pin: await hashPin(rows[c.id].pin) })
      const res = await apiFetch('/api/admin/shared-devices', {
        method: 'POST',
        body: JSON.stringify({ owner_id: shop.id, name: name.trim(), continuous, cashiers, enroll: true }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'No se pudo generar el código de activación')
      setCode(data.code)
      setCodeExpiry(data.code_expires_at)
    } catch (err) {
      setError(err.message)
    } finally {
      setGenerating(false)
    }
  }

  const copyCode = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true) } catch { setCopied(false) }
  }

  const renew = async () => {
    if (!device) return
    setError('')
    setNotice('')
    if (Number(device.owner_id) !== Number(shop.id)) {
      setError('La caja instalada es de otra tienda; solo se puede renovar desde su propia ficha.')
      return
    }
    setRenewing(true)
    try {
      const res = await apiFetch(`/api/admin/shared-devices/${device.id}/renew`, { method: 'POST' })
      const bundle = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(bundle.error || 'No se pudieron renovar los accesos')
      // Conserva los PIN ya instalados y los cambios pendientes.
      refreshSharedEnrollment(bundle)
      setDevice(getSharedDevice())
      setNotice('Accesos renovados. Los PIN de los cajeros y los cambios pendientes se conservan.')
    } catch (err) {
      setError(err.message)
    } finally {
      setRenewing(false)
    }
  }

  return (
    <div className="mt-3 rounded-2xl border border-blue-100 bg-blue-50/40 p-4">
      <div className="flex items-center gap-2">
        <MonitorSmartphone size={16} className="text-[#007AFF]" />
        <h3 className="font-semibold text-gray-900 text-sm">Caja compartida · {shop.store_name}</h3>
      </div>
      <p className="text-xs text-gray-500 mt-1">
        Un mismo aparato con varios cajeros, cada uno entra con su PIN. La configuración se instala
        en este navegador.
      </p>

      {device && (
        <div className="mt-3 bg-white rounded-xl border border-gray-100 p-3">
          <p className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <ShieldCheck size={15} className="text-green-600" />
            Ya hay una caja instalada en este dispositivo
          </p>
          <p className="text-xs text-gray-500 mt-1">
            {device.name} · {device.continuous ? 'Caja continua' : 'Por turno'} · vence el {formatDateTime(device.expires_at)}
          </p>
          {Number(device.owner_id) !== Number(shop.id) ? (
            <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 mt-2 flex items-start gap-2">
              <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
              La caja instalada pertenece a otra tienda. Solo se puede renovar desde su propia ficha.
            </p>
          ) : (
            <button
              onClick={renew}
              disabled={renewing}
              className="mt-3 flex items-center gap-1.5 bg-white border border-gray-200 text-gray-700 px-3 py-2 rounded-xl text-sm font-semibold hover:bg-gray-50 active:scale-95 transition-all disabled:opacity-50"
            >
              <RefreshCw size={14} className={renewing ? 'animate-spin' : ''} />
              {renewing ? 'Renovando…' : 'Renovar accesos'}
            </button>
          )}
          <button
            onClick={() => { completeSharedSetup(); navigate('/cajero', { replace: true }) }}
            disabled={renewing || submitting}
            className="mt-3 text-sm font-semibold text-[#007AFF] disabled:opacity-50"
          >
            Volver a cajeros
          </button>
        </div>
      )}

      {notice && (
        <div className="mt-3 flex items-center gap-2 bg-green-50 text-green-700 text-sm px-3 py-2 rounded-xl">
          <CheckCircle2 size={14} className="flex-shrink-0" />
          {notice}
        </div>
      )}
      {error && <div className="mt-3 bg-red-50 text-red-600 text-sm px-3 py-2 rounded-xl">{error}</div>}
      {loading && <div className="mt-3 text-xs text-gray-400">Cargando cajeros…</div>}

      {!showForm ? (
        <button
          onClick={() => { setShowForm(true); setError(''); setNotice('') }}
          className="mt-3 flex items-center gap-1.5 bg-[#007AFF] text-white px-4 py-2 rounded-xl text-sm font-semibold hover:bg-blue-600 active:scale-95 transition-all"
        >
          <MonitorSmartphone size={14} />
          {device ? 'Reconfigurar caja' : 'Configurar caja compartida'}
        </button>
      ) : (
        <div className="mt-3 space-y-4">
          {device && (
            <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 flex items-start gap-2">
              <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
              Reconfigurar reemplaza la caja instalada. Solo se permite si no quedan cambios pendientes
              ni una caja abierta en este aparato. Los PIN se vuelven a definir.
            </p>
          )}

          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
              Nombre de la caja
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Tablet del mostrador"
              maxLength={80}
              className="w-full bg-white border border-gray-200 rounded-2xl px-4 py-3 text-base focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors"
            />
          </div>

          <label className="flex items-start gap-3 bg-white border border-gray-200 rounded-2xl px-4 py-3 cursor-pointer">
            <input
              type="checkbox"
              checked={continuous}
              onChange={(e) => setContinuous(e.target.checked)}
              className="mt-0.5 w-5 h-5 accent-[#007AFF]"
            />
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-gray-900">Caja continua</span>
              <span className="block text-xs text-gray-500 mt-0.5">
                Desactivada (recomendado): cada cajero debe cerrar su caja antes de entregar el aparato
                a otro. El cierre lleva el nombre de quien lo firma.
              </span>
              <span className="block text-xs text-gray-500 mt-1">
                Activada: las ventas se acumulan entre cajeros hasta que se realiza un cierre.
              </span>
            </span>
          </label>

          <div>
            <div className="flex items-center gap-2 mb-2">
              <Users size={14} className="text-gray-400" />
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Cajeros autorizados</span>
            </div>
            {!loading && cashiers.length === 0 ? (
              <p className="text-sm text-gray-500 bg-white border border-gray-100 rounded-xl px-3 py-3">
                Esta tienda todavía no tiene cajeros. Créalos primero en su pantalla de Cajeros.
              </p>
            ) : (
              <div className="space-y-2">
                {cashiers.map((c) => {
                  const row = rows[c.id] || blankMember()
                  return (
                    <div key={c.id} className="bg-white border border-gray-100 rounded-2xl p-3">
                      <label className="flex items-center gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={row.selected}
                          onChange={(e) => update(c.id, { selected: e.target.checked })}
                          className="w-5 h-5 accent-[#007AFF]"
                        />
                        <span className="text-sm text-gray-700 truncate">{c.email}</span>
                      </label>

                      {row.selected && (
                        <div className="mt-3 space-y-2">
                          <input
                            value={row.display_name}
                            onChange={(e) => update(c.id, { display_name: e.target.value })}
                            placeholder="Nombre en el selector de cajeros"
                            aria-label={`Nombre visible de ${c.email}`}
                            maxLength={60}
                            className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors"
                          />
                          <div className="grid grid-cols-2 gap-2">
                            <input
                              type="password"
                              autoComplete="new-password"
                              aria-label={`PIN de ${c.email}`}
                              value={row.pin}
                              onChange={(e) => update(c.id, { pin: e.target.value.replace(/\D/g, '').slice(0, 6) })}
                              inputMode="numeric"
                              placeholder="PIN (6 dígitos)"
                              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm tracking-widest focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors"
                            />
                            <input
                              type="password"
                              autoComplete="new-password"
                              aria-label={`Confirmar PIN de ${c.email}`}
                              value={row.confirm}
                              onChange={(e) => update(c.id, { confirm: e.target.value.replace(/\D/g, '').slice(0, 6) })}
                              inputMode="numeric"
                              placeholder="Repite el PIN"
                              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm tracking-widest focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors"
                            />
                          </div>
                          <p className="text-[11px] text-gray-400">
                            El PIN nunca se envía en claro: se cifra aquí. Al instalar en este aparato se queda
                            local; al generar un código solo viaja su cifrado.
                          </p>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div className="flex flex-col sm:flex-row gap-2">
            <button
              onClick={submit}
              disabled={submitting || loading || cashiers.length === 0}
              className="flex-1 flex items-center justify-center gap-1.5 bg-[#007AFF] text-white px-4 py-3 rounded-2xl font-bold hover:bg-blue-600 active:scale-95 transition-all disabled:opacity-50"
            >
              {submitting ? <RefreshCw size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
              {submitting ? 'Instalando…' : 'Instalar caja en este aparato'}
            </button>
            {device && (
              <button
                onClick={() => { setShowForm(false); setError(''); setNotice('') }}
                disabled={submitting}
                className="px-4 py-3 rounded-2xl bg-gray-100 text-gray-700 font-semibold disabled:opacity-50"
              >
                Cancelar
              </button>
            )}
          </div>

          <div className="rounded-2xl border border-blue-100 bg-white p-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">En otro aparato (a distancia)</p>
            <button
              onClick={generateCode}
              disabled={generating || submitting || loading || cashiers.length === 0}
              className="w-full flex items-center justify-center gap-1.5 bg-white border border-[#007AFF] text-[#007AFF] px-4 py-3 rounded-2xl font-bold hover:bg-blue-50 active:scale-95 transition-all disabled:opacity-50"
            >
              {generating ? <RefreshCw size={16} className="animate-spin" /> : <KeyRound size={16} />}
              {generating ? 'Generando…' : 'Generar código para otro aparato'}
            </button>
            <p className="text-[11px] text-gray-400 mt-2">
              Cifra los PIN aquí y devuelve un código de un solo uso. En el aparato del negocio abre
              <span className="font-semibold text-gray-500"> /activar</span> e introduce ese código; ahí no hay que teclear ningún PIN.
            </p>
          </div>

          {code && (
            <div className="bg-white rounded-2xl border border-blue-200 p-4">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Código de activación</p>
              <div className="flex items-center gap-2 mt-2">
                <code className="flex-1 text-center text-xl sm:text-2xl font-bold tracking-widest text-gray-900 break-all">{prettyCode(code)}</code>
                <button
                  onClick={copyCode}
                  aria-label="Copiar el código"
                  className="flex items-center gap-1 bg-gray-100 text-gray-700 px-3 py-2 rounded-xl text-sm font-semibold hover:bg-gray-200 active:scale-95 transition-all"
                >
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                  {copied ? 'Copiado' : 'Copiar'}
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                Válido hasta las {formatDateTime(codeExpiry)}. Solo se puede usar una vez: dicta el código al negocio antes de que venza.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

import { useState, useEffect, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, Download, Upload, ClipboardPaste, AlertTriangle, CheckCircle, FileSpreadsheet, RefreshCw,
} from 'lucide-react'
import { apiFetch } from '../lib/api'
import {
  buildImport, decodeBytes, looksLikeExcelBinary, toPayload, TEMPLATE_CSV,
} from '../lib/productImport'

const fmt = (n) => (n === null || n === undefined)
  ? '—'
  : '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 }).format(n)

const PREVIEW_LIMIT = 300

export default function ImportarProductos() {
  const navigate = useNavigate()
  const fileRef = useRef(null)
  const [products,  setProducts]  = useState([])
  const [fileName,  setFileName]  = useState('')
  const [pasted,    setPasted]    = useState('')
  const [showPaste, setShowPaste] = useState(false)
  const [parsed,    setParsed]    = useState(null)
  const [importing, setImporting] = useState(false)
  const [serverErr, setServerErr] = useState(null)
  const [done,      setDone]      = useState(null)

  useEffect(() => {
    apiFetch('/api/products').then(r => r.json()).then(d => setProducts(Array.isArray(d) ? d : []))
  }, [])

  const reset = () => {
    setParsed(null); setFileName(''); setPasted(''); setServerErr(null); setDone(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([TEMPLATE_CSV], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'plantilla-productos.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setServerErr(null); setDone(null); setPasted(''); setShowPaste(false)
    setFileName(file.name)
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (looksLikeExcelBinary(bytes)) {
      setParsed({
        error: 'Ese es un archivo de Excel (.xlsx), no un CSV. En Excel: Archivo → Guardar como → ' +
               'elige "CSV (delimitado por comas)" o "CSV UTF-8" y sube ese archivo. ' +
               'También puedes seleccionar las celdas, copiarlas y usar "Pegar desde Excel".',
        rows: [],
      })
      return
    }
    setParsed(buildImport(decodeBytes(bytes), products))
  }

  const onPaste = (text) => {
    setPasted(text); setServerErr(null); setDone(null); setFileName('')
    if (fileRef.current) fileRef.current.value = ''
    setParsed(text.trim() ? buildImport(text, products) : null)
  }

  const rows      = parsed?.rows ?? []
  const valid     = rows.filter(r => r.errors.length === 0)
  const invalid   = rows.filter(r => r.errors.length > 0)
  const creates   = valid.filter(r => r.action === 'crear').length
  const updates   = valid.filter(r => r.action === 'actualizar').length
  const replacesStock = valid.some(r => r.action === 'actualizar' && r.stock !== null)

  const handleImport = async () => {
    if (valid.length === 0 || importing) return
    setImporting(true); setServerErr(null)
    try {
      const res = await apiFetch('/api/products/import', {
        method: 'POST',
        body: JSON.stringify({ items: toPayload(rows) }),
      })
      const data = await res.json()
      if (!res.ok) setServerErr(data)
      else setDone(data)
    } catch (_) {
      setServerErr({ error: 'Sin conexión. No se importó nada — vuelve a intentar cuando tengas red.' })
    } finally {
      setImporting(false)
    }
  }

  if (done) return (
    <div className="p-5 md:p-8 max-w-2xl mx-auto">
      <div className="bg-green-500 text-white rounded-3xl p-8 text-center shadow-lg shadow-green-200 mb-5">
        <CheckCircle size={40} className="mx-auto mb-3" />
        <p className="text-2xl font-bold">{done.total} productos cargados</p>
        <p className="opacity-90 mt-1">
          {done.created} nuevos · {done.updated} actualizados
        </p>
      </div>
      {invalid.length > 0 && (
        <p className="text-sm text-orange-700 bg-orange-50 rounded-xl px-4 py-3 mb-4">
          Quedaron fuera {invalid.length} filas con errores. Corrígelas en la hoja y vuelve a subir
          el archivo completo: lo que ya entró se actualiza, no se duplica.
        </p>
      )}
      <button
        onClick={() => navigate('/products')}
        className="w-full bg-[#007AFF] text-white py-4 rounded-2xl font-bold text-lg mb-2 active:scale-95 transition-all"
      >
        Ver productos
      </button>
      <button onClick={reset} className="w-full text-gray-500 py-3 text-sm hover:text-gray-700">
        Importar otro archivo
      </button>
    </div>
  )

  return (
    <div className="p-5 md:p-8 max-w-3xl mx-auto pb-32">
      <div className="flex items-center gap-3 mb-5">
        <Link to="/products" className="p-2 -ml-2 rounded-xl hover:bg-gray-100 text-gray-400 transition-colors">
          <ArrowLeft size={20} />
        </Link>
        <h2 className="text-2xl font-bold text-gray-900">Importar productos</h2>
      </div>

      {/* Paso 1 */}
      <div className="bg-white rounded-2xl shadow-sm p-5 mb-3">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">1 · Prepara la lista</p>
        <p className="text-sm text-gray-600 mb-3">
          Una fila por producto. Columnas: <strong>nombre</strong>, <strong>precio_venta</strong>,
          y opcionalmente <strong>precio_compra</strong> y <strong>stock</strong>.
        </p>
        <button
          onClick={downloadTemplate}
          className="flex items-center gap-2 bg-gray-100 text-gray-700 px-4 py-2.5 rounded-xl font-semibold text-sm hover:bg-gray-200 transition-colors"
        >
          <Download size={16} /> Descargar plantilla
        </button>
      </div>

      {/* Paso 2 */}
      <div className="bg-white rounded-2xl shadow-sm p-5 mb-5">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">2 · Súbela</p>
        <div className="flex flex-col sm:flex-row gap-2">
          <label className="flex-1 flex items-center justify-center gap-2 bg-[#007AFF] text-white px-4 py-3 rounded-xl font-semibold text-sm cursor-pointer hover:bg-blue-600 transition-colors">
            <Upload size={17} />
            {fileName ? 'Cambiar archivo' : 'Elegir archivo CSV'}
            <input ref={fileRef} type="file" accept=".csv,.txt,.tsv,text/csv,text/plain" onChange={onFile} className="hidden" />
          </label>
          <button
            onClick={() => setShowPaste(s => !s)}
            className="flex-1 flex items-center justify-center gap-2 bg-white border border-gray-200 text-gray-700 px-4 py-3 rounded-xl font-semibold text-sm hover:bg-gray-50 transition-colors"
          >
            <ClipboardPaste size={17} /> Pegar desde Excel
          </button>
        </div>
        {fileName && (
          <p className="flex items-center gap-1.5 text-xs text-gray-500 mt-3">
            <FileSpreadsheet size={14} /> {fileName}
          </p>
        )}
        {showPaste && (
          <textarea
            autoFocus
            value={pasted}
            onChange={e => onPaste(e.target.value)}
            rows={7}
            placeholder={'Selecciona las celdas en Excel (incluida la fila de títulos), cópialas y pégalas aquí.\n\nnombre\tprecio_venta\tprecio_compra\tstock\nArroz (1 lb)\t130\t90\t50'}
            className="w-full mt-3 border border-gray-200 rounded-xl px-4 py-3 text-sm font-mono focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF]"
          />
        )}
      </div>

      {parsed?.error && (
        <div className="flex items-start gap-2.5 bg-red-50 text-red-700 rounded-2xl px-4 py-4 mb-5 text-sm">
          <AlertTriangle size={18} className="flex-shrink-0 mt-0.5" />
          <span>{parsed.error}</span>
        </div>
      )}

      {rows.length > 0 && (
        <>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2 px-1">3 · Revisa antes de guardar</p>
          <div className="grid grid-cols-3 gap-2 mb-4">
            <Stat value={creates} label="nuevos"      tone="bg-green-50 text-green-700" />
            <Stat value={updates} label="actualizan"  tone="bg-blue-50 text-[#007AFF]" />
            <Stat value={invalid.length} label="con errores" tone={invalid.length ? 'bg-red-50 text-red-600' : 'bg-gray-50 text-gray-400'} />
          </div>

          {replacesStock && (
            <p className="text-xs text-orange-700 bg-orange-50 rounded-xl px-4 py-3 mb-4">
              Hay productos que ya existían: su precio y su stock pasan a ser los del archivo.
              Las celdas de costo o stock que dejes vacías no cambian lo que ya había.
            </p>
          )}

          {invalid.length > 0 && (
            <div className="bg-white rounded-2xl shadow-sm overflow-hidden mb-4 border border-red-100">
              <p className="px-5 py-3 text-sm font-semibold text-red-600 border-b border-red-50">
                Estas filas no se van a importar
              </p>
              {invalid.slice(0, 50).map(r => (
                <div key={r.line} className="px-5 py-2.5 border-b border-gray-50 last:border-0 text-sm">
                  <span className="font-semibold text-gray-900">Fila {r.line}</span>
                  {r.name && <span className="text-gray-500"> · {r.name}</span>}
                  <span className="block text-red-600 text-xs mt-0.5">{r.errors.join(' · ')}</span>
                </div>
              ))}
              {invalid.length > 50 && (
                <p className="px-5 py-2.5 text-xs text-gray-400">…y {invalid.length - 50} filas más con errores</p>
              )}
            </div>
          )}

          {valid.length > 0 && (
            <div className="bg-white rounded-2xl shadow-sm overflow-hidden mb-4">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-xs text-gray-400 uppercase tracking-wider">
                      <th className="text-left px-4 py-3 font-semibold">Producto</th>
                      <th className="text-right px-3 py-3 font-semibold">Venta</th>
                      <th className="text-right px-3 py-3 font-semibold hidden sm:table-cell">Compra</th>
                      <th className="text-right px-3 py-3 font-semibold">Stock</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {valid.slice(0, PREVIEW_LIMIT).map(r => (
                      <tr key={r.line} className="border-b border-gray-50 last:border-0">
                        <td className="px-4 py-2.5 font-medium text-gray-900">{r.name}</td>
                        <td className="px-3 py-2.5 text-right font-semibold">{fmt(r.sale_price)}</td>
                        <td className="px-3 py-2.5 text-right text-gray-400 hidden sm:table-cell">{fmt(r.purchase_price)}</td>
                        <td className="px-3 py-2.5 text-right">{r.stock ?? '—'}</td>
                        <td className="px-4 py-2.5 text-right">
                          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                            r.action === 'crear' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'
                          }`}>
                            {r.action === 'crear' ? 'Nuevo' : 'Actualiza'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {valid.length > PREVIEW_LIMIT && (
                <p className="px-4 py-2.5 text-xs text-gray-400 border-t border-gray-50">
                  Mostrando {PREVIEW_LIMIT} de {valid.length}. Se importan todos.
                </p>
              )}
            </div>
          )}

          {serverErr && (
            <div className="bg-red-50 text-red-700 rounded-2xl px-4 py-3 mb-4 text-sm">
              <p className="font-semibold">{serverErr.error}</p>
              {serverErr.errors?.slice(0, 10).map((e, i) => (
                <p key={i} className="text-xs mt-1">{e.error}</p>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleImport}
              disabled={valid.length === 0 || importing}
              className="flex-1 bg-[#007AFF] text-white py-4 rounded-2xl font-bold text-lg active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-blue-200 disabled:shadow-none"
            >
              {importing ? 'Guardando...' : `Importar ${valid.length} ${valid.length === 1 ? 'producto' : 'productos'}`}
            </button>
            <button
              onClick={reset}
              title="Empezar de nuevo"
              className="px-4 bg-white border border-gray-200 text-gray-500 rounded-2xl hover:bg-gray-50"
            >
              <RefreshCw size={18} />
            </button>
          </div>
          {invalid.length > 0 && valid.length > 0 && (
            <p className="text-xs text-gray-400 text-center mt-2">
              Las {invalid.length} filas con errores se omiten. Puedes corregirlas y volver a subir el archivo después.
            </p>
          )}
        </>
      )}
    </div>
  )
}

function Stat({ value, label, tone }) {
  return (
    <div className={`rounded-2xl px-3 py-3 text-center ${tone}`}>
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-xs font-medium">{label}</p>
    </div>
  )
}

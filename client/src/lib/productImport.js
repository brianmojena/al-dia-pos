// Carga masiva de productos desde una hoja de cálculo.
//
// El archivo se interpreta ENTERO en el navegador y se muestra una vista previa
// antes de guardar nada: en la tienda del cliente, con la lista hecha a mano,
// lo que hace falta es ver qué se va a cargar y qué filas están mal, no un
// "error 400" después de subir. El servidor vuelve a validar todo igual — esto
// es para el humano, no un control de seguridad.
//
// La realidad que tiene que aguantar:
//   - Excel en español guarda los CSV con ";" (no ",") y los números como "1.500".
//   - Excel en Windows los guarda en Windows-1252, no UTF-8: sin cuidado, "Azúcar"
//     llega como "AzÃºcar" o con símbolos raros.
//   - Copiar celdas de Excel/Google Sheets y pegarlas llega separado por tabuladores.
//   - La gente sube el .xlsx directamente.

export const MAX_ROWS = 2000

const COLUMNS = {
  name:           ['nombre', 'producto', 'nombre del producto', 'nombre producto', 'descripcion', 'articulo'],
  sale_price:     ['precio venta', 'precio de venta', 'venta', 'precio', 'pvp', 'precio al publico'],
  purchase_price: ['precio compra', 'precio de compra', 'compra', 'costo', 'coste', 'precio costo', 'precio de costo'],
  stock:          ['stock', 'cantidad', 'existencia', 'existencias', 'inventario', 'unidades', 'uds'],
}

const stripAccents = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')

/** "  Azúcar  (1 LB) " y "azucar (1 lb)" son el mismo producto. */
export const normalizeName = (name) =>
  stripAccents(String(name ?? '')).toLowerCase().replace(/\s+/g, ' ').trim()

const normalizeHeader = (s) =>
  stripAccents(String(s ?? '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Un .xlsx es un ZIP: empieza con "PK". Mejor decirlo que mostrar basura. */
export const looksLikeExcelBinary = (bytes) =>
  bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04

export function decodeBytes(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // No es UTF-8 válido: casi seguro un CSV guardado por Excel en Windows.
    text = new TextDecoder('windows-1252').decode(bytes)
  }
  return text.replace(/^﻿/, '')
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') || ''
  const counts = { '\t': 0, ';': 0, ',': 0 }
  let inQuotes = false
  for (const c of firstLine) {
    if (c === '"') inQuotes = !inQuotes
    else if (!inQuotes && c in counts) counts[c]++
  }
  // Empate: tabulador (pegado de Excel) > punto y coma (Excel en español) > coma.
  return ['\t', ';', ','].reduce((best, d) => (counts[d] > counts[best] ? d : best), '\t')
}

function parseDelimited(text, delim) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += c
    } else if (c === '"' && field === '') {
      inQuotes = true
    } else if (c === delim) {
      row.push(field); field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += c
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

function mapHeader(cells) {
  const map = {}
  const taken = new Set()
  // Primero coincidencias exactas ("precio de venta" antes que el genérico "precio")…
  cells.forEach((cell, idx) => {
    const h = normalizeHeader(cell)
    for (const [key, aliases] of Object.entries(COLUMNS)) {
      if (map[key] === undefined && aliases.includes(h)) { map[key] = idx; taken.add(idx); return }
    }
  })
  // …después, por palabra contenida, para encabezados como "Precio venta CUP".
  cells.forEach((cell, idx) => {
    if (taken.has(idx)) return
    const h = normalizeHeader(cell)
    if (map.purchase_price === undefined && /compra|costo|coste/.test(h)) map.purchase_price = idx
    else if (map.sale_price === undefined && /venta|precio/.test(h)) map.sale_price = idx
    else if (map.stock === undefined && /stock|cantidad|existenc/.test(h)) map.stock = idx
    else if (map.name === undefined && /nombre|producto|articulo|descripcion/.test(h)) map.name = idx
  })
  return map
}

/**
 * Número escrito por una persona: "1.500", "1,5", "$ 990", "1.234,50", "990 CUP".
 * Devuelve null si la celda está vacía y NaN si no se puede interpretar.
 *
 * Con un solo separador se decide por la forma: grupos de exactamente 3 cifras
 * son miles ("1.500" → 1500); cualquier otra cosa es decimal ("12.50" → 12.5).
 * Los precios en CUP casi nunca llevan 3 decimales, así que es la lectura segura.
 */
export function parseNumber(raw) {
  if (raw === null || raw === undefined) return null
  let s = String(raw).trim()
  if (s === '') return null
  s = s.replace(/cup|usd|mn|\$/gi, '').replace(/[\s ]/g, '')
  if (s === '') return null
  if (!/^-?[\d.,]+$/.test(s)) return NaN

  const lastDot = s.lastIndexOf('.')
  const lastComma = s.lastIndexOf(',')

  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? '.' : ','
    const thousands = decimal === '.' ? ',' : '.'
    s = s.split(thousands).join('').replace(decimal, '.')
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ','
    const parts = s.split(sep)
    const head = parts[0].replace('-', '')
    const isThousands =
      parts.length > 1 &&
      head.length >= 1 && head.length <= 3 && head !== '0' &&
      parts.slice(1).every((p) => p.length === 3)
    if (isThousands) s = parts.join('')
    else if (parts.length === 2) s = `${parts[0]}.${parts[1]}`
    else return NaN
  }

  const n = Number(s)
  return Number.isFinite(n) ? n : NaN
}

/**
 * Interpreta el texto completo y lo cruza con el catálogo actual.
 *
 * @returns {{ error?: string, rows: Array<{ line, name, sale_price, purchase_price,
 *            stock, errors: string[], action: 'crear'|'actualizar' }> }}
 *   `line` es el número de fila tal como se ve en Excel (el encabezado es la 1),
 *   para que "fila 14" signifique lo mismo en la pantalla y en la hoja.
 */
export function buildImport(text, existingProducts = []) {
  const clean = String(text ?? '').replace(/^﻿/, '')
  if (clean.trim() === '') return { error: 'El archivo está vacío.', rows: [] }

  const table = parseDelimited(clean, detectDelimiter(clean))
  const headerIndex = table.findIndex((r) => r.some((c) => c.trim() !== ''))
  if (headerIndex < 0) return { error: 'El archivo está vacío.', rows: [] }

  const columns = mapHeader(table[headerIndex])
  if (columns.name === undefined || columns.sale_price === undefined) {
    return {
      error:
        'No encuentro las columnas. La primera fila tiene que tener los títulos, por ejemplo: ' +
        'nombre · precio_venta · precio_compra · stock. Descarga la plantilla para verlo.',
      rows: [],
    }
  }

  const existing = new Map(existingProducts.map((p) => [normalizeName(p.name), p]))
  const seen = new Map()
  const rows = []

  for (let i = headerIndex + 1; i < table.length; i++) {
    const cells = table[i]
    if (!cells.some((c) => c.trim() !== '')) continue

    const cell = (key) => (columns[key] === undefined ? '' : (cells[columns[key]] ?? ''))
    const line = i + 1
    const errors = []

    const name = cell('name').trim().replace(/\s+/g, ' ')
    const saleRaw = cell('sale_price')
    const purchaseRaw = cell('purchase_price')
    const stockRaw = cell('stock')

    const sale_price = parseNumber(saleRaw)
    const purchase_price = parseNumber(purchaseRaw)
    const stock = parseNumber(stockRaw)

    if (!name) errors.push('Falta el nombre')
    else if (name.length > 120) errors.push('El nombre es demasiado largo')

    if (sale_price === null) errors.push('Falta el precio de venta')
    else if (Number.isNaN(sale_price)) errors.push(`Precio de venta no válido: "${saleRaw.trim()}"`)
    else if (sale_price < 0) errors.push('El precio de venta no puede ser negativo')

    if (Number.isNaN(purchase_price)) errors.push(`Precio de compra no válido: "${purchaseRaw.trim()}"`)
    else if (purchase_price !== null && purchase_price < 0) errors.push('El precio de compra no puede ser negativo')

    if (Number.isNaN(stock)) errors.push(`Stock no válido: "${stockRaw.trim()}"`)
    else if (stock !== null && !Number.isInteger(stock)) errors.push('El stock tiene que ser un número entero')
    else if (stock !== null && stock < 0) errors.push('El stock no puede ser negativo')

    if (name) {
      const key = normalizeName(name)
      if (seen.has(key)) errors.push(`Repetido: ya aparece en la fila ${seen.get(key)}`)
      else seen.set(key, line)
    }

    rows.push({
      line,
      name,
      sale_price: Number.isNaN(sale_price) ? null : sale_price,
      purchase_price: Number.isNaN(purchase_price) ? null : purchase_price,
      stock: Number.isNaN(stock) ? null : stock,
      errors,
      action: existing.has(normalizeName(name)) ? 'actualizar' : 'crear',
    })
  }

  if (rows.length === 0) return { error: 'El archivo tiene títulos pero ninguna fila con productos.', rows: [] }
  if (rows.length > MAX_ROWS) {
    return { error: `Son ${rows.length} filas; el máximo por archivo es ${MAX_ROWS}. Divídelo en partes.`, rows: [] }
  }
  return { rows }
}

/** Lo que viaja al servidor: solo las filas sin errores. */
export const toPayload = (rows) =>
  rows
    .filter((r) => r.errors.length === 0)
    .map(({ name, sale_price, purchase_price, stock }) => ({ name, sale_price, purchase_price, stock }))

// Con ";" y BOM para que Excel en español la abra ya separada en columnas.
export const TEMPLATE_CSV =
  '﻿nombre;precio_venta;precio_compra;stock\r\n' +
  'Arroz (1 lb);130;90;50\r\n' +
  'Aceite vegetal (1 L);990;750;20\r\n' +
  'Refresco de lata;200;140;48\r\n'

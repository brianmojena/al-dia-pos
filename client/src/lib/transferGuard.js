// Techo de transferencia del dueño: la primera barrera está en la pantalla
// (botón bloqueado con mensaje), la definitiva en el servidor
// (POST /api/sales responde 403). Mantener ambas sincronizadas:
// límite inclusivo — el total exacto pasa, por encima se bloquea.
export function isTransferBlocked(total, transferLimit, paymentMethod = 'transferencia') {
  if (paymentMethod !== 'transferencia') return false
  if (transferLimit === null || transferLimit === undefined) return false
  return Number(total) > Number(transferLimit)
}

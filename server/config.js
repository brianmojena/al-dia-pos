const JWT_SECRET = process.env.JWT_SECRET || 'mypimes-dev-secret-local-only';

// Quién puede entrar al panel de administración (confirmar tiendas en /admin).
// Vive en config y no en la base: cambiar de administrador no debería requerir
// migrar datos. La lista se lee al arrancar (env ADMIN_EMAILS, separada por comas).
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'brianadmin@aldia.cu')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

const isAdminEmail = (email) => ADMIN_EMAILS.includes(String(email || '').trim().toLowerCase());

// Tiendas cuyo cajero ve, en "Mis ventas", cómo se repartió lo cobrado del día
// entre efectivo, transferencia, dólares y euros. Vive en config, no en la
// base: es un pedido puntual de una tienda y no cambia con los datos. Se lee al
// arrancar (env CASHIER_BREAKDOWN_EMAILS, separada por comas).
const CASHIER_BREAKDOWN_EMAILS = (process.env.CASHIER_BREAKDOWN_EMAILS || 'deliciasysabores@aldia.cu')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

const showsCashierBreakdown = (email) => CASHIER_BREAKDOWN_EMAILS.includes(String(email || '').trim().toLowerCase());

module.exports = { JWT_SECRET, ADMIN_EMAILS, isAdminEmail, CASHIER_BREAKDOWN_EMAILS, showsCashierBreakdown };

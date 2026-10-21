// En producción no puede haber una clave por defecto: cualquiera que lea el
// código podría firmar tokens válidos. El fallback queda solo para desarrollo
// y pruebas, y el arranque falla de forma explícita si falta en producción.
const isProduction = () => process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
const DEV_JWT_SECRET = 'mypimes-dev-secret-local-only';
const JWT_SECRET = process.env.JWT_SECRET || (isProduction() ? null : DEV_JWT_SECRET);

// Se llama desde ambos entrypoints (index.js y api/index.js) antes de atender
// peticiones. Sin esto, JWT_SECRET=null reventaría más tarde con un error opaco
// en el primer login, en vez de impedir el arranque.
function assertConfig() {
  if (!JWT_SECRET) {
    throw new Error(
      'JWT_SECRET no está configurada. En producción es obligatoria: sin ella ' +
      'no se pueden firmar sesiones de forma segura. Configúrala antes de desplegar.'
    );
  }
}

// Correos reservados para la administración. La migración inicial conserva
// su acceso; después manda users.is_admin y se aprovisiona con admin:grant.
// La lista se lee al arrancar (env ADMIN_EMAILS, separada por comas).
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'brianadmin@aldia.cu')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

const isAdminEmail = (email) => ADMIN_EMAILS.includes(String(email || '').trim().toLowerCase());

// Auditoría con IA: el cierre solo encola un trabajo cuando esta bandera está
// activa. Apagarla detiene la generación de informes sin tocar los cierres ni
// los informes ya guardados.
const AUDIT_ENABLED = process.env.AUDIT_ENABLED === '1';

// Tiendas cuyo cajero ve, en "Mis ventas", cómo se repartió lo cobrado del día
// entre efectivo, transferencia, dólares y euros. Vive en config, no en la
// base: es un pedido puntual de una tienda y no cambia con los datos. Se lee al
// arrancar (env CASHIER_BREAKDOWN_EMAILS, separada por comas).
const CASHIER_BREAKDOWN_EMAILS = (process.env.CASHIER_BREAKDOWN_EMAILS || 'deliciasysabores@aldia.cu')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

const showsCashierBreakdown = (email) => CASHIER_BREAKDOWN_EMAILS.includes(String(email || '').trim().toLowerCase());

module.exports = {
  JWT_SECRET, assertConfig, isProduction,
  ADMIN_EMAILS, isAdminEmail, CASHIER_BREAKDOWN_EMAILS, showsCashierBreakdown,
  AUDIT_ENABLED,
};

// Planes comerciales de Al Día y sus topes. El plan vive en la fila de la
// tienda (users.plan del dueño) y los cajeros lo heredan al crearse.
//
// 'premium' y 'dev' son los valores viejos, anteriores a la migración de
// planes (ver db/migrate.js). Mientras una tienda los conserve se trata como
// Basic — el plan más restrictivo — para que nadie quede con más cupo del que
// pagó; el registro ya no los acepta y guarda el plan por defecto.
const PLANS = {
  basic:      { label: 'Basic',      maxUsers: 5  },
  enterprise: { label: 'Enterprise', maxUsers: 10 },
};

const DEFAULT_PLAN = 'basic';

// Prueba gratuita desde el registro hasta que el administrador confirma el
// pago (que es en persona, ver routes/admin.js). Vencida sin confirmar, la
// tienda entera queda bloqueada hasta que la confirmen.
const TRIAL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_MS = TRIAL_DAYS * DAY_MS;

const isPlan = (plan) => Object.prototype.hasOwnProperty.call(PLANS, plan);
const planOf = (plan) => (isPlan(plan) ? plan : DEFAULT_PLAN);
const labelOf = (plan) => PLANS[planOf(plan)].label;

// Cuentas por tienda, contando la principal. El tope se evalúa al crear
// cajeros: una tienda que ya tenga más cuentas de las que su plan permite no
// se degrada sola; simplemente no puede crear más.
const maxUsersOf = (plan) => PLANS[planOf(plan)].maxUsers;

// Estado de confirmación de una tienda, compartido por las respuestas de auth
// (publicUser) y el panel de administración, para que ambos cuenten los días
// de prueba y el bloqueo exactamente igual. El estado vive en la fila del
// dueño; los cajeros lo heredan.
const planStateOf = (shop, now = Date.now()) => {
  const status = shop.plan_status || 'active';
  const trialEnd = shop.trial_ends_at ? new Date(shop.trial_ends_at).getTime() : null;
  const pending = status === 'pending';
  return {
    plan_status: status,
    trial_ends_at: shop.trial_ends_at || null,
    trial_days_left: pending
      ? (trialEnd != null && trialEnd > now ? Math.ceil((trialEnd - now) / DAY_MS) : 0)
      : null,
    locked: pending && trialEnd != null && trialEnd <= now,
  };
};

module.exports = {
  PLANS, DEFAULT_PLAN, isPlan, planOf, labelOf, maxUsersOf,
  TRIAL_DAYS, TRIAL_MS, planStateOf,
};

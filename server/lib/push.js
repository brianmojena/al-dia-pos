const http2 = require('http2');
const jwt = require('jsonwebtoken');
const { paymentLabel, round2 } = require('./payment');

/**
 * Avisos push de venta para el dueño: APNs (iPhone) y FCM v1 (Android), sin
 * dependencias nuevas. Todo se configura por variables de entorno; si faltan,
 * ese canal simplemente no envía (nunca rompe un cobro).
 *
 *  APNs: APNS_KEY_P8 (contenido de la clave .p8; admite \n escapados),
 *        APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_SANDBOX=1 (builds de Xcode)
 *  FCM:  FCM_SERVICE_ACCOUNT (JSON de la cuenta de servicio de Firebase)
 */

const SEND_TIMEOUT_MS = 4000;

const money = (n) => '$ ' + Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');

function buildMessage(sale) {
  const quien = sale.account_email ? sale.account_email.split('@')[0] : null;
  return {
    title: `Venta ${money(sale.total)}`,
    body: [paymentLabel(sale), quien, `Ganancia ${money(round2(sale.profit))}`].filter(Boolean).join(' · '),
  };
}

// --- APNs --------------------------------------------------------------------
let apnsJwt = { value: null, at: 0 };
function apnsToken() {
  // Apple pide renovar el token entre 20 y 60 minutos.
  if (apnsJwt.value && Date.now() - apnsJwt.at < 40 * 60 * 1000) return apnsJwt.value;
  const key = process.env.APNS_KEY_P8.replace(/\\n/g, '\n');
  const value = jwt.sign({}, key, {
    algorithm: 'ES256',
    keyid: process.env.APNS_KEY_ID,
    issuer: process.env.APNS_TEAM_ID,
  });
  apnsJwt = { value, at: Date.now() };
  return value;
}

const apnsConfigured = () =>
  !!(process.env.APNS_KEY_P8 && process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID && process.env.APNS_BUNDLE_ID);

function sendApns(tokens, message) {
  const host = process.env.APNS_SANDBOX === '1' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  const client = http2.connect(host);
  client.on('error', () => { /* se reporta por petición */ });
  const bearer = apnsToken();
  const payload = JSON.stringify({ aps: { alert: { title: message.title, body: message.body }, sound: 'default' } });

  const one = (token) => new Promise((resolve) => {
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${bearer}`,
      'apns-topic': process.env.APNS_BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
    });
    let status = 0;
    let data = '';
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve({ token, ok: status === 200, dead: status === 410 || /BadDeviceToken|Unregistered/.test(data) }));
    req.on('error', () => resolve({ token, ok: false, dead: false }));
    req.end(payload);
  });

  return Promise.all(tokens.map(one)).finally(() => client.close());
}

// --- FCM v1 ------------------------------------------------------------------
let fcmAccess = { value: null, exp: 0 };
async function fcmAccessToken(account) {
  if (fcmAccess.value && Date.now() < fcmAccess.exp) return fcmAccess.value;
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 },
    account.private_key,
    { algorithm: 'RS256' },
  );
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error('FCM: no se obtuvo access token');
  fcmAccess = { value: json.access_token, exp: Date.now() + (json.expires_in - 120) * 1000 };
  return fcmAccess.value;
}

const fcmAccount = () => {
  try { return process.env.FCM_SERVICE_ACCOUNT ? JSON.parse(process.env.FCM_SERVICE_ACCOUNT) : null; } catch { return null; }
};

async function sendFcm(tokens, message) {
  const account = fcmAccount();
  const access = await fcmAccessToken(account);
  return Promise.all(tokens.map(async (token) => {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token, notification: { title: message.title, body: message.body } } }),
    });
    return { token, ok: res.ok, dead: res.status === 404 };
  }));
}

// Transportes reemplazables en pruebas.
const transports = { ios: sendApns, android: sendFcm };

async function deliver(db, userId, sale) {
  const rows = (await db.execute({ sql: 'SELECT platform, token FROM push_devices WHERE user_id = ?', args: [userId] })).rows;
  if (!rows.length) return;
  const message = buildMessage(sale);
  const jobs = [];
  const ios = rows.filter((r) => r.platform === 'ios').map((r) => r.token);
  const android = rows.filter((r) => r.platform === 'android').map((r) => r.token);
  if (ios.length && (transports.ios !== sendApns || apnsConfigured())) jobs.push(transports.ios(ios, message));
  if (android.length && (transports.android !== sendFcm || fcmAccount())) jobs.push(transports.android(android, message));
  const results = (await Promise.all(jobs.map((j) => j.catch((e) => { console.error('push:', e.message); return []; })))).flat();
  // Token muerto (app desinstalada): se borra para no reintentar para siempre.
  for (const r of results) {
    if (r && r.dead) await db.execute({ sql: 'DELETE FROM push_devices WHERE token = ?', args: [r.token] }).catch(() => {});
  }
}

/** Nunca lanza y nunca tarda más de SEND_TIMEOUT_MS: un cobro no depende de Apple/Google. */
async function notifySale(db, userId, sale) {
  try {
    await Promise.race([
      deliver(db, userId, sale),
      new Promise((resolve) => setTimeout(resolve, SEND_TIMEOUT_MS).unref?.()),
    ]);
  } catch (err) {
    console.error('push:', err.message);
  }
}

module.exports = { notifySale, buildMessage, transports };

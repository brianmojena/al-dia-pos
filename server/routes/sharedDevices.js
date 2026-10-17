const express = require('express');
const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const { asyncHandler } = require('../lib/asyncHandler');
const { DURATION_MS, enrollment, renewEnrollment } = require('../lib/sharedDevices');
const router = express.Router();

router.get('/shops/:ownerId/cashiers', asyncHandler(async (req, res) => {
  const ownerId = Number(req.params.ownerId);
  const db = getDb();
  const shop = (await db.execute({ sql: 'SELECT id FROM users WHERE id = ? AND owner_id IS NULL', args: [ownerId] })).rows[0];
  if (!shop) return res.status(404).json({ error: 'Tienda no encontrada' });
  const rows = (await db.execute({ sql: "SELECT id, email FROM users WHERE owner_id = ? AND role = 'cajero' ORDER BY created_at, id", args: [ownerId] })).rows;
  res.json({ cashiers: rows });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { owner_id, name, cashiers, continuous = false } = req.body;
  const ownerId = Number(owner_id);
  if (!Number.isInteger(ownerId) || ownerId <= 0 || typeof name !== 'string' || !name.trim() || name.trim().length > 80
    || typeof continuous !== 'boolean' || !Array.isArray(cashiers) || !cashiers.length || cashiers.length > 20
    || cashiers.some((c) => !Number.isInteger(c?.id) || c.id <= 0 || typeof c.display_name !== 'string' || !c.display_name.trim() || c.display_name.trim().length > 60)
    || new Set(cashiers.map((c) => c.id)).size !== cashiers.length) return res.status(400).json({ error: 'Nombre, modalidad o cajeros inválidos' });
  const db = getDb();
  const tx = await db.transaction('write');
  let device;
  try {
    const shop = (await tx.execute({ sql: 'SELECT id FROM users WHERE id = ? AND owner_id IS NULL', args: [ownerId] })).rows[0];
    if (!shop) { await tx.rollback(); return res.status(404).json({ error: 'Tienda no encontrada' }); }
    const marks = cashiers.map(() => '?').join(',');
    const members = (await tx.execute({ sql: `SELECT id FROM users WHERE owner_id = ? AND role = 'cajero' AND id IN (${marks})`, args: [ownerId, ...cashiers.map((c) => c.id)] })).rows;
    if (members.length !== cashiers.length) { await tx.rollback(); return res.status(400).json({ error: 'Todos los cajeros deben pertenecer a esta tienda' }); }
    device = { id: randomUUID(), owner_id: ownerId, name: name.trim(), continuous: continuous ? 1 : 0, version: 1, active: 1, expires_at: new Date(Date.now() + DURATION_MS).toISOString() };
    await tx.execute({ sql: 'INSERT INTO shared_devices (id, owner_id, name, continuous, version, active, expires_at, created_by) VALUES (?, ?, ?, ?, 1, 1, ?, ?)', args: [device.id, ownerId, device.name, device.continuous, device.expires_at, req.accountId] });
    for (const member of cashiers) await tx.execute({ sql: 'INSERT INTO shared_device_cashiers (device_id, account_id, display_name) VALUES (?, ?, ?)', args: [device.id, member.id, member.display_name.trim()] });
    await tx.commit();
  } catch (error) { await tx.rollback().catch(() => {}); throw error; }
  res.status(201).json(await enrollment(db, device));
}));

router.post('/:id/renew', asyncHandler(async (req, res) => {
  const result = await renewEnrollment(req.params.id);
  if (!result) return res.status(404).json({ error: 'Caja no encontrada o retirada' });
  res.json(result);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await getDb().execute({ sql: 'UPDATE shared_devices SET active = 0 WHERE id = ? AND active = 1', args: [req.params.id] });
  if (!result.rowsAffected) return res.status(404).json({ error: 'Caja no encontrada o retirada' });
  res.json({ success: true });
}));
module.exports = router;

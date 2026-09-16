const express = require('express');
const cors = require('cors');
const { requireAuth, requireOwner } = require('./middleware/auth');
const authRouter      = require('./routes/auth');
const productsRouter  = require('./routes/products');
const salesRouter     = require('./routes/sales');
const dashboardRouter = require('./routes/dashboard');
const cashClosesRouter = require('./routes/cashCloses');
const inventoryCountsRouter = require('./routes/inventoryCounts');
const reportsRouter = require('./routes/reports');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRouter);

app.use('/api/products',  requireAuth, productsRouter);
app.use('/api/sales',     requireAuth, salesRouter);
// El dashboard dice cuánto se vendió hoy — justo lo que un cajero no puede
// saber antes de declarar el efectivo contado.
app.use('/api/dashboard', requireAuth, requireOwner, dashboardRouter);
app.use('/api/cash-closes', requireAuth, cashClosesRouter);
app.use('/api/inventory-counts', requireAuth, inventoryCountsRouter);
// Histórico de días pasados y su descarga en Excel — solo el dueño (requireOwner
// vive dentro de cada ruta, igual que en /api/sales y /api/cash-closes).
app.use('/api/reports', requireAuth, reportsRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

module.exports = app;

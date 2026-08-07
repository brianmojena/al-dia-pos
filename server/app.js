const express = require('express');
const cors = require('cors');
const { requireAuth } = require('./middleware/auth');
const authRouter      = require('./routes/auth');
const productsRouter  = require('./routes/products');
const salesRouter     = require('./routes/sales');
const dashboardRouter = require('./routes/dashboard');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRouter);

app.use('/api/products',  requireAuth, productsRouter);
app.use('/api/sales',     requireAuth, salesRouter);
app.use('/api/dashboard', requireAuth, dashboardRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

module.exports = app;

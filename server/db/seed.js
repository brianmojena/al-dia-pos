require('dotenv').config();
const bcrypt = require('bcryptjs');
const { getDb, initDb } = require('./database');

async function seed() {
  await initDb();
  const db = getDb();

  await db.execute('DELETE FROM sale_items');
  await db.execute('DELETE FROM sales');
  await db.execute('DELETE FROM products');
  await db.execute('DELETE FROM users');
  try {
    await db.execute("DELETE FROM sqlite_sequence WHERE name IN ('users', 'products', 'sales', 'sale_items')");
  } catch (_) { /* sqlite_sequence puede no existir aún */ }

  // Usuario demo para probar la app sin registrarse.
  const DEMO_EMAIL = 'demo@mitienda.cu';
  const DEMO_PASSWORD = 'demo1234';

  const userInsert = await db.execute({
    sql: 'INSERT INTO users (email, password_hash, store_name, plan) VALUES (?, ?, ?, ?)',
    args: [DEMO_EMAIL, bcrypt.hashSync(DEMO_PASSWORD, 10), 'Mi Tienda Demo', 'dev'],
  });
  const userId = Number(userInsert.lastInsertRowid);

  // Productos típicos de una bodega/minimercado MIPYME cubana.
  // La mayoría son importados (EEUU vía Miami/Panamá, Panamá, México).
  // Precios en CUP, mercado informal/privado, 2024-2025.
  const products = [
    // --- Carnes (importadas de EEUU vía Panamá/mulas) ---
    { name: 'Pollo (muslos, 1 lb)',       purchase_price: 200,  sale_price: 320,  stock: 30 },
    { name: 'Salchichas Campofrío (lata)', purchase_price: 350,  sale_price: 550,  stock: 18 },
    { name: 'Cerdo (1 lb)',               purchase_price: 600,  sale_price: 900,  stock: 4  },
    { name: 'Atún Starkist (lata 170g)',  purchase_price: 220,  sale_price: 350,  stock: 20 },

    // --- Lácteos y huevos ---
    { name: 'Leche en polvo (1 lb)',      purchase_price: 680,  sale_price: 1000, stock: 15 },
    { name: 'Queso crema Kraft (226g)',   purchase_price: 500,  sale_price: 780,  stock: 10 },
    { name: 'Mantequilla (200g)',         purchase_price: 350,  sale_price: 550,  stock: 8  },
    { name: 'Huevo (unidad)',             purchase_price: 70,   sale_price: 110,  stock: 60 },

    // --- Aceites, granos y conservas ---
    { name: 'Aceite vegetal (1 L)',       purchase_price: 680,  sale_price: 990,  stock: 22 },
    { name: 'Arroz (1 lb)',              purchase_price: 80,   sale_price: 130,  stock: 45 },
    { name: 'Frijoles negros (1 lb)',     purchase_price: 200,  sale_price: 320,  stock: 30 },
    { name: 'Pasta (paquete 500g)',       purchase_price: 180,  sale_price: 280,  stock: 25 },
    { name: 'Harina Espiga Blanca (1 lb)', purchase_price: 160, sale_price: 250,  stock: 20 },
    { name: 'Puré de tomate (lata 400g)', purchase_price: 100,  sale_price: 170,  stock: 24 },
    { name: 'Azúcar (1 lb)',             purchase_price: 70,   sale_price: 110,  stock: 40 },
    { name: 'Café Serrano (250g)',        purchase_price: 500,  sale_price: 750,  stock: 12 },

    // --- Aseo e higiene personal (importados EEUU/Panamá) ---
    { name: 'Detergente Ariel (500g)',   purchase_price: 250,  sale_price: 380,  stock: 20 },
    { name: 'Jabón Dove (pack x3)',      purchase_price: 280,  sale_price: 430,  stock: 15 },
    { name: 'Champú Pantene (400ml)',    purchase_price: 620,  sale_price: 950,  stock: 10 },
    { name: 'Papel higiénico (x4 rollos)', purchase_price: 250, sale_price: 400, stock: 18 },
    { name: 'Pasta dental Colgate',      purchase_price: 160,  sale_price: 260,  stock: 14 },
    { name: 'Desodorante Rexona',        purchase_price: 360,  sale_price: 550,  stock: 3  },

    // --- Bebidas ---
    { name: 'Cerveza Bucanero (lata)',   purchase_price: 130,  sale_price: 210,  stock: 48 },
    { name: 'Gatorade (600ml)',          purchase_price: 220,  sale_price: 350,  stock: 5  },
    { name: 'Refresco Pepsi (lata)',     purchase_price: 120,  sale_price: 200,  stock: 24 },

    // --- Snacks (importados) ---
    { name: 'Galletas Oreo (137g)',      purchase_price: 320,  sale_price: 500,  stock: 14 },
    { name: 'Pringles Original (lata)',  purchase_price: 680,  sale_price: 1050, stock: 5  },
  ];

  for (const p of products) {
    await db.execute({
      sql: 'INSERT INTO products (user_id, name, purchase_price, sale_price, stock) VALUES (?, ?, ?, ?, ?)',
      args: [userId, p.name, p.purchase_price, p.sale_price, p.stock],
    });
  }

  const today = new Date().toISOString().split('T')[0];

  const sampleSales = [
    {
      time: '09:10:00',
      payment_method: 'efectivo',
      items: [
        { pid: 1,  name: 'Pollo (muslos, 1 lb)',     qty: 2, price: 320,  cost: 200  },
        { pid: 9,  name: 'Aceite vegetal (1 L)',      qty: 1, price: 990,  cost: 680  },
        { pid: 8,  name: 'Huevo (unidad)',             qty: 6, price: 110,  cost: 70   },
      ],
    },
    {
      time: '11:30:00',
      payment_method: 'transferencia',
      items: [
        { pid: 5,  name: 'Leche en polvo (1 lb)',     qty: 1, price: 1000, cost: 680  },
        { pid: 12, name: 'Pasta (paquete 500g)',       qty: 2, price: 280,  cost: 180  },
        { pid: 17, name: 'Detergente Ariel (500g)',   qty: 1, price: 380,  cost: 250  },
        { pid: 18, name: 'Jabón Dove (pack x3)',      qty: 1, price: 430,  cost: 280  },
      ],
    },
    {
      time: '14:45:00',
      payment_method: 'efectivo',
      items: [
        { pid: 23, name: 'Cerveza Bucanero (lata)',   qty: 3, price: 210,  cost: 130  },
        { pid: 26, name: 'Galletas Oreo (137g)',      qty: 2, price: 500,  cost: 320  },
        { pid: 20, name: 'Papel higiénico (x4 rollos)', qty: 1, price: 400, cost: 250 },
      ],
    },
  ];

  for (const sale of sampleSales) {
    const total  = sale.items.reduce((s, i) => s + i.qty * i.price, 0);
    const profit = sale.items.reduce((s, i) => s + i.qty * (i.price - i.cost), 0);
    const saleInsert = await db.execute({
      sql: 'INSERT INTO sales (user_id, total, profit, payment_method, created_at) VALUES (?, ?, ?, ?, ?)',
      args: [userId, total, profit, sale.payment_method, `${today}T${sale.time}`],
    });
    const saleId = Number(saleInsert.lastInsertRowid);
    for (const item of sale.items) {
      await db.execute({
        sql: 'INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, unit_cost) VALUES (?, ?, ?, ?, ?, ?)',
        args: [saleId, item.pid, item.name, item.qty, item.price, item.cost],
      });
    }
  }

  console.log(`✓ Seed listo: usuario demo (${DEMO_EMAIL} / ${DEMO_PASSWORD}), ${products.length} productos, ${sampleSales.length} ventas de ejemplo`);
}

seed().catch((err) => {
  console.error('Error al ejecutar el seed:', err);
  process.exit(1);
});

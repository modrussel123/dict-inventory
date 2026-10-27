const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const mongoose = require('mongoose');
const inventoryRoutes = require('./routes/inventory');

const app = express();
const port = Number(process.env.PORT) || 3000;

if (!process.env.MONGODB_URI) {
  throw new Error('MONGODB_URI is required. Add it to the .env file.');
}

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use('/api', inventoryRoutes);
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html')));

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error.name === 'ValidationError' || error.name === 'CastError') {
    return res.status(400).json({ message: error.message });
  }
  res.status(500).json({ message: 'An unexpected server error occurred.' });
});

async function start() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB.');
  app.listen(port, () => console.log(`Inventory app running at http://localhost:${port}`));
}

start().catch((error) => {
  console.error('Unable to start server:', error.message);
  process.exit(1);
});

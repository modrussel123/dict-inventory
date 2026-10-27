# DICT NBP Inventory Web

A full-stack inventory application for DICT NBP. The responsive browser interface is served by an Express API and persists inventory, releases, and sales totals in MongoDB.

## Project structure

```text
frontend/                 Browser interface and assets
  index.html              Inventory UI (HTML, styling, and interaction logic)
  logo/                   DICT and NBP visual assets
backend/
  models/                 MongoDB schemas
  routes/                 Inventory HTTP endpoints
  server.js               Express application entry point
  .env                    Local credentials (never commit)
  .env.example            Safe environment template
```

## Run locally

1. Run `npm install`.
2. Confirm the `MONGODB_URI` in `backend/.env` points to your MongoDB cluster and that the cluster allows your IP address.
3. Run `npm run dev` for development, or `npm start` for normal use.
4. Open `http://localhost:3000`. Do not open the HTML file directly or through Live Server when using the database.

## API

- `GET /api/items` — inventory and sales summary
- `PUT /api/inventory` — save the current inventory snapshot and release history
- `DELETE /api/items` — clear all items and revenue

## Deployment security

The API currently has no authentication or authorization. Keep it on a trusted development network and do not expose it to the public internet until login and per-action access controls have been added.

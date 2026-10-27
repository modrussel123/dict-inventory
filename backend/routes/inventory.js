const express = require('express');
const InventoryItem = require('../models/InventoryItem');
const SalesSummary = require('../models/SalesSummary');

const router = express.Router();
const itemFields = ['name', 'serialNumber', 'unitType', 'price', 'sortOrder', 'quantity', 'soldQuantity', 'description', 'inventoryRemarks', 'releaseDate', 'remarks', 'releaseHistory', 'editHistory', 'subItems'];
const liveUpdateClients = new Set();

function broadcastInventoryUpdate(sourceId) {
  const event = `event: inventory-updated\ndata: ${JSON.stringify({ sourceId, updatedAt: Date.now() })}\n\n`;

  for (const client of liveUpdateClients) {
    if (!client.writableEnded) client.write(event);
  }
}

function pickItemFields(body) {
  return Object.fromEntries(
    itemFields.filter((field) => body[field] !== undefined).map((field) => [field, body[field]])
  );
}

function dedupeReleaseCopies(releases) {
  const seen = new Set();
  return releases.filter((release) => {
    if (typeof release.id !== 'string' || !release.id) return true;
    const canonicalId = release.id.replace(/-p$/, '');
    if (seen.has(canonicalId)) return false;
    seen.add(canonicalId);
    return true;
  });
}

function calculateSalesRevenue(records) {
  return records.reduce((inventoryTotal, item) => {
    const getReleaseValue = (releases, fallbackPrice) => releases.reduce((releaseTotal, release) => {
      const quantity = Number(release.quantity) || 0;
      const unitPrice = Number(release.unitPrice ?? fallbackPrice) || 0;
      return releaseTotal + (quantity * unitPrice);
    }, 0);

    const subItems = Array.isArray(item.subItems) ? item.subItems : [];
    if (subItems.length) {
      const parentHistory = Array.isArray(item.releaseHistory) ? item.releaseHistory : [];
      const parentReleaseValue = getReleaseValue(
        parentHistory.filter((release) =>
          !release.subItemId &&
          !subItems.some((sub) =>
            release.subItemName === sub.name ||
            (typeof release.remarks === 'string' && release.remarks.startsWith(`[Sub-item: ${sub.name}]`))
          )
        ),
        item.price
      );
      const subItemReleaseValue = subItems.reduce((total, sub) => {
        const childHistory = dedupeReleaseCopies(Array.isArray(sub.releaseHistory) ? sub.releaseHistory : []);
        let parentSubHistory = dedupeReleaseCopies(parentHistory.filter((release) =>
          release.subItemId === sub.id ||
          release.subItemName === sub.name ||
          (typeof release.remarks === 'string' && release.remarks.startsWith(`[Sub-item: ${sub.name}]`))
        ));
        if (!parentSubHistory.length) {
          const normalizedSubName = String(sub.name || '').trim().toLocaleLowerCase();
          parentSubHistory = dedupeReleaseCopies(parentHistory.filter((release) =>
            String(release.subItemName || '').trim().toLocaleLowerCase() === normalizedSubName
          ));
        }
        const childHistoryQuantity = Number(childHistory[0]?.quantity) || 0;
        const recordedSoldQuantity = Number(sub.soldQuantity) || 0;
        const parentHistoryQuantity = parentSubHistory.reduce((sum, release) => sum + (Number(release.quantity) || 0), 0);
        const childHistoryTotalQuantity = childHistory.reduce((sum, release) => sum + (Number(release.quantity) || 0), 0);
        let releases = childHistory;
        if (parentSubHistory.length && parentHistoryQuantity !== childHistoryTotalQuantity) {
          releases = parentSubHistory;
        } else if (!childHistory.length || (childHistoryQuantity === 0 && recordedSoldQuantity > 0)) {
          releases = parentSubHistory.length
            ? parentSubHistory
            : (recordedSoldQuantity > 0
              ? [{ quantity: recordedSoldQuantity, unitPrice: sub.price }]
              : []);
        }

        return total + getReleaseValue(releases, sub.price);
      }, 0);

      return inventoryTotal + parentReleaseValue + subItemReleaseValue;
    }

    const releases = Array.isArray(item.releaseHistory) && item.releaseHistory.length
      ? item.releaseHistory
      : (Number(item.soldQuantity) > 0 ? [{ quantity: item.soldQuantity, unitPrice: item.price }] : []);
    const itemRevenue = getReleaseValue(releases, item.price);

    return inventoryTotal + itemRevenue;
  }, 0);
}

router.get('/items', async (_req, res, next) => {
  try {
    const items = await InventoryItem.find().sort({ sortOrder: 1, createdAt: 1 }).lean();
    res.json({
      items,
      totalSalesRevenue: calculateSalesRevenue(items)
    });
  } catch (error) {
    next(error);
  }
});

router.get('/config/signatories', (_req, res) => {
  res.json({
    preparedBy: process.env.REPORT_PREPARED_BY || 'Ma. Ann C. Pascua',
    approvedBy: process.env.REPORT_APPROVED_BY || 'Jesus S. Agliam Jr.'
  });
});

// Keeps every open inventory page in sync without polling or a manual refresh.
router.get('/events', (req, res) => {
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  liveUpdateClients.add(res);

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': keep-alive\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    liveUpdateClients.delete(res);
  });
});

function dedupeIncomingItems(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  const seen = new Set();
  const clean = [];
  for (const item of rawItems) {
    if (!item) continue;
    const nameKey = String(item.name || '').trim().toLowerCase();
    const createdKey = item.createdAt ? new Date(item.createdAt).toISOString() : '';
    const compositeKey = nameKey + '|' + createdKey;

    if (compositeKey && createdKey) {
      if (seen.has(compositeKey)) continue;
      seen.add(compositeKey);
    }
    clean.push(item);
  }
  return clean;
}

let inventoryWriteQueue = Promise.resolve();

// Saves a complete browser snapshot. This keeps the existing inventory UI and
// its release-history workflow in sync with MongoDB after every change.
router.put('/inventory', async (req, res, next) => {
  inventoryWriteQueue = inventoryWriteQueue.catch(() => {}).then(async () => {
    try {
      if (!Array.isArray(req.body.items)) {
        return res.status(400).json({ message: 'An items array is required.' });
      }

      const deduplicated = dedupeIncomingItems(req.body.items);
      const records = deduplicated.map((item, index) => ({
        ...pickItemFields(item),
        sortOrder: index,
        createdAt: item.createdAt ? new Date(item.createdAt) : new Date(),
        updatedAt: new Date()
      }));
      // Calculate from the persisted release histories instead of trusting a
      // browser counter. This stays correct after an item is deleted.
      const totalSalesRevenue = calculateSalesRevenue(records);

      await InventoryItem.deleteMany({});
      if (records.length) {
        await InventoryItem.insertMany(records);
        await SalesSummary.findOneAndUpdate(
          { key: 'inventory' },
          { totalSalesRevenue },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      } else {
        // A cleared web inventory should leave no placeholder record in Atlas.
        await SalesSummary.deleteMany({});
      }

      broadcastInventoryUpdate(req.body.clientId);
      res.json({ message: 'Inventory saved.', itemCount: records.length, totalSalesRevenue });
    } catch (error) {
      next(error);
    }
  });
  return inventoryWriteQueue;
});

router.delete('/items', async (req, res, next) => {
  try {
    await Promise.all([
      InventoryItem.deleteMany({}),
      SalesSummary.deleteMany({})
    ]);
    broadcastInventoryUpdate(req.body?.clientId);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

module.exports = router;

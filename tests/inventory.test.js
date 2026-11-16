const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const mongoose = require('mongoose');
const ordering = require('../frontend/inventory-order');
const InventoryItem = require('../backend/models/InventoryItem');
const SalesSummary = require('../backend/models/SalesSummary');
const router = require('../backend/routes/inventory');
const removeEditHistory = require('../backend/scripts/remove-edit-history');

const root = path.join(__dirname, '..');
const item = (id, date, extra = {}) => ({
  id, name: id, createdAt: date, price: 10, quantity: 3,
  soldQuantity: 1, releaseHistory: [{ id: `release-${id}`, quantity: 1, unitPrice: 10 }],
  ...extra
});
const fixtures = [item('new', '2026-11-03'), item('old', '2026-09-15'), item('middle', '2026-09-22')];

test('oldest first is deterministic across saves and appends without mutating input', () => {
  const input = fixtures.concat(item('last', '2026-11-04'));
  assert.deepEqual(ordering.oldestFirst(input).map(x => x.id), ['old', 'middle', 'new', 'last']);
  assert.equal(input[0].id, 'new');
  assert.deepEqual(ordering.oldestFirst(JSON.parse(JSON.stringify(input))).map(x => x.id), ['old', 'middle', 'new', 'last']);
});

test('duplicate identities are removed, but distinct same-name/same-date items are retained', () => {
  const old = fixtures[1];
  assert.deepEqual(ordering.uniqueItems([old, old, { ...old, id: 'separate' }]).map(x => x.id), ['old', 'separate']);
  assert.equal(ordering.uniqueItems([{ id: 'client', _id: 'database' }, { _id: 'database' }]).length, 1);
  assert.equal(ordering.uniqueItems([{ name: 'Cable' }, { name: 'Cable' }]).length, 2);
});

test('undated legacy entries stay ahead of new entries and tied dates use stable positions', () => {
  const data = [item('b', '2026-09-15', { sortOrder: 2 }), item('a', '2026-09-15', { sortOrder: 1 }), item('legacy', null)];
  assert.deepEqual(ordering.oldestFirst(data).map(x => x.id), ['legacy', 'a', 'b']);
});

function handler(method, route) {
  return router.stack.find(layer => layer.route?.path === route && layer.route.methods[method]).route.stack[0].handle;
}

async function save(items) {
  let failure;
  let response;
  await handler('put', '/inventory')({ body: { items } }, {
    status() { return this; },
    json(body) { response = body; }
  }, error => { failure = error; });
  return { failure, response };
}

function fakeDatabase(t, initial = []) {
  let stored = initial;
  let deletes = 0;
  let failWrites = false;
  t.mock.method(InventoryItem, 'find', () => ({ lean: async () => stored }));
  t.mock.method(InventoryItem, 'bulkWrite', async operations => {
    if (failWrites) throw new Error('Simulated write failure');
    for (const operation of operations) {
      const replacement = operation.replaceOne.replacement;
      stored = stored.filter(x => String(x._id) !== String(replacement._id));
      stored.push(replacement);
    }
  });
  t.mock.method(InventoryItem, 'deleteMany', async filter => {
    deletes++;
    const retained = filter._id?.$nin.map(String) || [];
    stored = stored.filter(x => retained.includes(String(x._id)));
  });
  t.mock.method(SalesSummary, 'findOneAndUpdate', async () => ({}));
  t.mock.method(SalesSummary, 'deleteMany', async () => ({}));
  return { get stored() { return stored; }, get deletes() { return deletes; }, failWrites() { failWrites = true; } };
}

test('saving twice preserves MongoDB/client IDs, dates, releases, totals, and oldest-first positions', async t => {
  const db = fakeDatabase(t);
  const first = await save(fixtures);
  assert.ifError(first.failure);
  assert.equal(first.response.totalSalesRevenue, 30);
  const firstIds = new Map(db.stored.map(x => [x.id, String(x._id)]));
  const second = await save(fixtures.concat(fixtures[0], item('last', '2026-11-04')));
  assert.ifError(second.failure);
  assert.equal(second.response.itemCount, 4);
  assert.equal(second.response.totalSalesRevenue, 40);
  assert.deepEqual(db.stored.map(x => x.id), ['old', 'middle', 'new', 'last']);
  for (const record of db.stored.slice(0, 3)) {
    assert.equal(String(record._id), firstIds.get(record.id));
    assert.equal(record.releaseHistory.length, 1);
  }
  assert.deepEqual(db.stored.map(x => x.sortOrder), [0, 1, 2, 3]);
});

test('legacy IDs and original creation dates survive a browser snapshot', async t => {
  const original = { ...fixtures[1], _id: new mongoose.Types.ObjectId() };
  delete original.id;
  const db = fakeDatabase(t, [original]);
  const result = await save([{ ...original, id: String(original._id), createdAt: '2026-11-03' }]);
  assert.ifError(result.failure);
  assert.equal(String(db.stored[0]._id), String(original._id));
  assert.equal(db.stored[0].createdAt.toISOString().slice(0, 10), '2026-09-15');
});

test('same name and creation date do not silently remove separate stock records', async t => {
  const db = fakeDatabase(t);
  const result = await save([fixtures[0], { ...fixtures[0], id: 'separate' }]);
  assert.ifError(result.failure);
  assert.equal(db.stored.length, 2);
});

test('invalid quantities and dates fail before any database changes', async t => {
  const original = { ...fixtures[1], _id: new mongoose.Types.ObjectId() };
  const db = fakeDatabase(t, [original]);
  for (const invalid of [{ quantity: -1 }, { createdAt: 'bad-date' }]) {
    const result = await save([item('invalid', '2026-11-03', invalid)]);
    assert.equal(result.failure?.name, 'ValidationError');
    assert.equal(db.deletes, 0);
    assert.deepEqual(db.stored, [original]);
  }
});

test('failed database writes do not run deletion or erase existing inventory', async t => {
  const original = { ...fixtures[1], _id: new mongoose.Types.ObjectId() };
  const db = fakeDatabase(t, [original]);
  db.failWrites();
  const result = await save(fixtures);
  assert.match(result.failure.message, /write failure/);
  assert.equal(db.deletes, 0);
  assert.deepEqual(db.stored, [original]);
});

test('successful saves remove only omitted records and clearing removes all', async t => {
  const db = fakeDatabase(t);
  await save(fixtures);
  const keptId = String(db.stored.find(x => x.id === 'old')._id);
  assert.ifError((await save([fixtures[1]])).failure);
  assert.equal(db.stored.length, 1);
  assert.equal(String(db.stored[0]._id), keptId);
  assert.ifError((await save([])).failure);
  assert.equal(db.stored.length, 0);
});

test('dashboard and both dashboard exporters share oldest-first filtered output', () => {
  const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
  const context = vm.createContext({ InventoryOrder: ordering, document: { getElementById: () => null }, items: fixtures });
  for (const name of ['getProcessedItems', 'getSortedItems']) {
    const start = html.indexOf(`    function ${name}(`);
    const end = html.indexOf('\n    }', start) + '\n    }'.length;
    vm.runInContext(html.slice(start, end), context);
  }
  assert.deepEqual(Array.from(vm.runInContext('getSortedItems().map(x => x.id)', context)), ['old', 'middle', 'new']);
  assert.ok(!html.includes('duplicateItem('));
  assert.ok(!html.includes('items.reverse()'));
  assert.match(html, /value="oldest" selected/);
  const scripts = Array.from(html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g));
  for (const [, source] of scripts) new vm.Script(source);
});

test('PDF and Excel export engines receive identical oldest-first records and preserve filters', async () => {
  const controls = { exportDateFrom: { value: '' }, exportDateTo: { value: '' }, exportContentScope: { value: 'travel' } };
  const received = [];
  const context = vm.createContext({
    InventoryOrder: ordering, atob, console,
    document: { addEventListener() {}, getElementById: id => controls[id] || null },
    window: { jspdf: { jsPDF: function () { throw new Error('PDF order captured'); } } },
    XLSX: {}, fixtures,
    capture: records => received.push(Array.from(records, record => record.id))
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'frontend/export-records.js'), 'utf8'), context);
  vm.runInContext(`
    items = fixtures;
    cachedLogoImg = {};
    showToast = () => {};
    const originalOldestFirst = InventoryOrder.oldestFirst;
    InventoryOrder = { ...InventoryOrder, oldestFirst(list) { const sorted = originalOldestFirst(list); capture(sorted); return sorted; } };
    exportAcknowledgementReceiptToExcel = (records) => capture(records);
  `, context);
  vm.runInContext('exportToExcel()', context);
  await assert.rejects(vm.runInContext('exportToPDF()', context), /PDF order captured/);
  assert.deepEqual(received, [['old', 'middle', 'new'], ['old', 'middle', 'new'], ['old', 'middle', 'new']]);
  controls.exportDateFrom.value = '2026-09-20';
  controls.exportDateTo.value = '2026-09-30';
  vm.runInContext('exportToExcel()', context);
  assert.deepEqual(received.at(-1), ['middle']);
});

test('dashboard PDF completes with sequential parent and sub-item row numbers', async () => {
  const tables = [];
  let saved = false;
  const doc = new Proxy({
    lastAutoTable: { finalY: 50 },
    autoTable(options) { tables.push(options.body); },
    save() { saved = true; }
  }, { get(target, key) { return key in target ? target[key] : () => {}; } });
  const context = vm.createContext({
    InventoryOrder: ordering, atob, console,
    document: { addEventListener() {}, getElementById: () => null },
    window: { jspdf: { jsPDF: function () { return doc; } } },
    fixtures: [fixtures[0], { ...fixtures[1], subItems: [{ id: 'child', name: 'Child', price: 2, quantity: 3 }] }]
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'frontend/export-records.js'), 'utf8'), context);
  vm.runInContext('items = fixtures; cachedLogoImg = {}; showToast = () => {}; function getSortedItems() { return InventoryOrder.oldestFirst(items); }', context);
  const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
  const start = html.indexOf('    async function exportToPDF()');
  const end = html.indexOf('\n    }', start) + '\n    }'.length;
  vm.runInContext(html.slice(start, end), context);
  await vm.runInContext('exportToPDF()', context);
  assert.equal(saved, true);
  assert.deepEqual(Array.from(tables[0], row => row[0]), [1, '1.1', 2]);
});

test('legacy edit logs cannot be saved, and parent and sub-item release records survive', async t => {
  const db = fakeDatabase(t);
  const release = { id: 'release-1', quantity: 2, date: '2026-09-25', unitPrice: 10, releasedAt: new Date('2026-09-25T04:00:00Z'), remarks: 'Issued', releasedSerials: ['ABC'] };
  const payload = item('with-releases', '2026-09-15', {
    editHistory: [{ changedAt: new Date(), changes: [{ label: 'Name', from: 'Old', to: 'New' }] }],
    releaseHistory: [release],
    subItems: [{ id: 'child', name: 'Child', quantity: 3, price: 10, releaseHistory: [{ ...release, id: 'child-release' }], editHistory: [{ changedAt: new Date() }] }]
  });
  const canonical = new InventoryItem(payload).toObject();
  const result = await save([payload]);
  assert.ifError(result.failure);
  assert.equal(Object.hasOwn(db.stored[0], 'editHistory'), false);
  assert.equal(Object.hasOwn(db.stored[0].subItems[0], 'editHistory'), false);
  assert.deepEqual(db.stored[0].releaseHistory, canonical.releaseHistory);
  assert.deepEqual(db.stored[0].subItems[0].releaseHistory, canonical.subItems[0].releaseHistory);
});

test('dashboard strips obsolete logs from cached items while preserving release metadata', () => {
  const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
  const start = html.indexOf('    function normaliseDatabaseItem(');
  const end = html.indexOf('\n    }', start) + '\n    }'.length;
  const context = vm.createContext({});
  vm.runInContext(html.slice(start, end), context);
  context.legacy = { ...fixtures[0], editHistory: [{}], subItems: [{ id: 'child', name: 'Child', editHistory: [{}], releaseHistory: [{ id: 'release-child', quantity: 2, date: '2026-09-25', remarks: 'Issued', releasedSerials: ['ABC'] }] }] };
  const result = vm.runInContext('normaliseDatabaseItem(legacy)', context);
  assert.equal(Object.hasOwn(result, 'editHistory'), false);
  assert.equal(Object.hasOwn(result.subItems[0], 'editHistory'), false);
  assert.equal(result.releaseHistory[0].id, fixtures[0].releaseHistory[0].id);
  assert.equal(result.subItems[0].releaseHistory[0].id, 'release-child');
  assert.equal(result.subItems[0].releaseHistory[0].remarks, 'Issued');
  assert.deepEqual(result.subItems[0].releaseHistory[0].releasedSerials, ['ABC']);
  for (const file of ['frontend/index.html', 'frontend/export-records.html', 'frontend/export-records.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /editHistory|recordEditChange|editChanges|S_EDIT|edit history/i);
  }
});

test('database cleanup unsets only edit logs, preserves every other field, and is idempotent', async () => {
  let stored = [{
    _id: 'one', name: 'Stock', quantity: 3, price: 10, updatedAt: new Date('2026-09-25'),
    editHistory: [{ changes: [{ label: 'Name' }] }],
    releaseHistory: [{ id: 'main', quantity: 1, remarks: 'Issued', releasedSerials: ['ABC'] }],
    subItems: [{ id: 'child', name: 'Child', quantity: 5, editHistory: [{}], releaseHistory: [{ id: 'sub', quantity: 2, remarks: 'Keep', releasedSerials: ['DEF'] }] }]
  }];
  const original = structuredClone(stored);
  const db = { collection(name) {
    assert.equal(name, 'inventoryitems');
    return {
      find() { return { sort() { return { toArray: async () => structuredClone(stored) }; } }; },
      async updateMany(filter, update) {
        assert.deepEqual(Object.keys(update), ['$unset']);
        let modifiedCount = 0;
        if (filter.editHistory) {
          assert.deepEqual(update, { $unset: { editHistory: '' } });
          stored.forEach(record => { if (Object.hasOwn(record, 'editHistory')) { delete record.editHistory; modifiedCount++; } });
        } else {
          assert.deepEqual(update, { $unset: { 'subItems.$[].editHistory': '' } });
          stored.forEach(record => {
            if (record.subItems.some(sub => Object.hasOwn(sub, 'editHistory'))) modifiedCount++;
            record.subItems.forEach(sub => { delete sub.editHistory; });
          });
        }
        return { modifiedCount };
      }
    };
  } };
  const result = await removeEditHistory(db);
  assert.equal(result.parentRecordsCleaned, 1);
  assert.equal(result.subItemRecordsCleaned, 1);
  assert.deepEqual(stored[0].releaseHistory, original[0].releaseHistory);
  assert.deepEqual(stored[0].subItems[0].releaseHistory, original[0].subItems[0].releaseHistory);
  assert.equal(stored[0].updatedAt.getTime(), original[0].updatedAt.getTime());
  const repeated = await removeEditHistory(db);
  assert.equal(repeated.parentRecordsCleaned, 0);
  assert.equal(repeated.subItemRecordsCleaned, 0);
});

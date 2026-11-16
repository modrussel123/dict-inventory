const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const InventoryOrder = require('../frontend/inventory-order');

const release = (id, date, quantity, price, serial) => ({
  id, date, quantity, unitPrice: price, remarks: id, releasedSerials: [serial]
});
const fixtures = [
  { id: 'created-only', name: 'Created in October', createdAt: '2026-10-15', price: 10, quantity: 3,
    releaseHistory: [release('old-created', '2026-09-25', 9, 10, 'OLD-CREATED')] },
  { id: 'mixed', name: 'Mixed releases', createdAt: '2026-09-15', price: 10, quantity: 5,
    releaseHistory: [release('last', '2026-10-31', 3, 10, 'IN-LAST'), release('first', '2026-10-10', 2, 10, 'IN-FIRST'), release('old', '2026-09-25', 7, 10, 'OUTSIDE')] },
  { id: 'bundle', name: 'Bundle', createdAt: '2026-09-10', price: 0, quantity: 1, releaseHistory: [], subItems: [
    { id: 'a', name: 'October child', price: 2, quantity: 6, releaseHistory: [release('a-release', '2026-10-15', 4, 2, 'CHILD-IN')] },
    { id: 'b', name: 'September child', price: 3, quantity: 8, releaseHistory: [release('b-release', '2026-09-15', 5, 3, 'CHILD-OUT')] }
  ] }
];

function harness(DateClass = Date) {
  const controls = new Map();
  const element = id => {
    if (!controls.has(id)) controls.set(id, { value: '', innerHTML: '', textContent: '', disabled: false, classList: { toggle() {} } });
    return controls.get(id);
  };
  const pdfs = [], books = [], messages = [], tableOptions = [];
  const context = vm.createContext({
    InventoryOrder, Date: DateClass, console, atob,
    document: { addEventListener() {}, getElementById: element },
    window: { jspdf: { jsPDF: function () {
      const tables = [];
      const doc = new Proxy({
        internal: { getNumberOfPages: () => 1 },
        lastAutoTable: { finalY: 80 },
        getTextWidth: text => String(text).length * 1.5,
        splitTextToSize: text => [text],
        autoTable(options) { tables.push(options.body); tableOptions.push(options); },
        save() { pdfs.push(tables); }
      }, { get(target, key) { return key in target ? target[key] : () => doc; } });
      return doc;
    } } },
    XLSX: {
      utils: {
        book_new: () => ({}),
        aoa_to_sheet: rows => {
          const sheet = { rows };
          rows.forEach((row, r) => row.forEach((v, c) => { sheet[`R${r}C${c}`] = { v, t: typeof v === 'number' ? 'n' : 's' }; }));
          return sheet;
        },
        encode_cell: ({ r, c }) => `R${r}C${c}`,
        book_append_sheet(book, sheet) { book.sheet = sheet; }
      },
      writeFile(book) { books.push(book); }
    },
    notify: text => messages.push(text)
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/export-records.js'), 'utf8'), context);
  context.fixtureData = structuredClone(fixtures);
  vm.runInContext('items = fixtureData; cachedLogoImg = {}; showToast = text => notify(text); saveAcknowledgementReceiptWorkbook = (book, filename) => XLSX.writeFile(book, filename);', context);
  const run = source => vm.runInContext(source, context);
  const set = (from, to, scope) => {
    element('exportDateFrom').value = from;
    element('exportDateTo').value = to;
    element('exportContentScope').value = scope;
  };
  return { context, run, set, element, pdfs, books, messages, tableOptions };
}

function serialFixture(h) {
  h.context.serialFixtures = [
    { id: 'mixed-serials', name: 'Mixed serials', createdAt: '2026-10-15', price: 10, quantity: 1,
      serialNumber: 'AVAILABLE\nRELEASED',
      releaseHistory: [{id:'old', date:'2026-09-01', quantity:1, releasedSerials:['RELEASED']}] },
    { id: 'bundle-serials', name: 'Bundle', createdAt: '2026-10-15', price: 0, quantity: 0,
      subItems: [
        {id:'child', name:'Child', quantity:0, price:5, serialNumber:'CHILD-RELEASED',
         releaseHistory:[{id:'child-release', date:'2026-10-15', quantity:1, releasedSerials:['CHILD-RELEASED']}]},
        {id:'active', name:'Active child', quantity:1, price:5, serialNumber:'CHILD-AVAILABLE', releaseHistory:[]}
      ] }
  ];
  h.run('items = serialFixtures');
}

test('Print All receipt PDF and Excel quantities show remaining stock for main items and sub-items', async () => {
  for (const range of [['', ''], ['2026-10-01', '2026-10-31']]) {
    const h = harness();
    serialFixture(h);
    const source = JSON.stringify(h.context.serialFixtures);
    h.set(...range, 'travel');
    h.run('updateExportRangeBadge()');
    await h.run('exportToPDF()');
    h.run('exportToExcel()');
    const pdfRows = h.pdfs[0][0];
    const excelRows = h.books[0].sheet.rows.filter(row => /^\d+\./.test(String(row[0])));
    const quantities = rows => Array.from(rows, row => [String(row[1]), String(row[2])]);
    const expected = [['Bundle', '0'], ['>> Child', '0'], ['>> Active child', '1'], ['Mixed serials', '1']];
    assert.deepEqual(quantities(pdfRows), expected);
    assert.deepEqual(quantities(excelRows), expected);
    assert.match(h.element('exportScopeHelp').textContent, /current remaining stock/);
    assert.equal(JSON.stringify(h.context.serialFixtures), source);
  }
});

test('Print All PDFs mark only deducted main and child serial numbers; released receipts stay plain', async () => {
  for (const scope of ['full', 'travel', 'travel_released']) {
    const h = harness();
    serialFixture(h);
    h.set('', '', scope);
    await h.run('exportToPDF()');
    const options = h.tableOptions[0];
    const serialColumn = scope === 'full' ? 2 : 3;
    const serials = options.body.map(row => row[serialColumn]);
    if (scope === 'travel_released') {
      assert.equal(serials.some(cell => cell?.serialMeta), false);
      assert.ok(serials.includes('RELEASED'));
    } else {
      const marked = serials.filter(cell => cell?.serialMeta);
      assert.equal(marked.length, 2);
      const mixed = marked.find(cell => cell.content.includes('AVAILABLE'));
      const child = marked.find(cell => cell.content === 'CHILD-RELEASED');
      assert.deepEqual(Array.from(mixed.serialMeta.lines, line => line.isDeducted), [false, true]);
      assert.equal(child.serialMeta.allDeducted, true);
      assert.ok(serials.includes('CHILD-AVAILABLE'));
      assert.equal(typeof options.didParseCell, 'function');
      assert.equal(typeof options.didDrawCell, 'function');
    }
  }
});

test('Print All Excel receipts cross out mixed and fully deducted serials, including outside the date range', () => {
  for (const range of [['', ''], ['2026-10-01', '2026-10-31']]) {
    const h = harness();
    serialFixture(h);
    h.set(...range, 'travel');
    h.run('exportToExcel()');
    const sheet = h.books[0].sheet;
    const serialCell = name => {
      const r = sheet.rows.findIndex(row => row[1] === name);
      return sheet[`R${r}C3`];
    };
    const mixed = serialCell('Mixed serials');
    assert.equal(mixed.v, 'AVAILABLE\nR\u0336E\u0336L\u0336E\u0336A\u0336S\u0336E\u0336D\u0336');
    assert.equal(mixed.s.font.strike, false);
    const child = serialCell('>> Child');
    assert.equal(child.v, 'CHILD-RELEASED');
    assert.equal(child.s.font.strike, true);
    assert.equal(serialCell('>> Active child').s.font.strike, undefined);
  }
  const h = harness();
  serialFixture(h);
  h.set('', '', 'travel_released');
  h.run('exportToExcel()');
  for (const cell of Object.values(h.books[0].sheet)) {
    if (cell?.s) assert.notEqual(cell.s.font?.strike, true);
    if (typeof cell?.v === 'string') assert.ok(!cell.v.includes('\u0336'));
  }
});

test('Print All receipts include every parent and child serial and cross out only their own deductions', async () => {
  for (const range of [['', ''], ['2026-10-01', '2026-10-31']]) {
    const h = harness();
    h.context.receiptItems = [{
      id: 'parent', name: 'Parent with serials', createdAt: '2026-10-15', price: 0, quantity: 2,
      serialNumber: 'PARENT-IN\nPARENT-OUT\nSHARED',
      releaseHistory: [
        {id:'parent-release', date:'2026-09-15', quantity:1, releasedSerials:['PARENT-OUT']},
        {id:'child-release-p', date:'2026-10-15', quantity:2, subItemId:'child', subItemName:'Child with serials', releasedSerials:['CHILD-OUT', 'SHARED']}
      ],
      subItems: [{
        id: 'child', name: 'Child with serials', price: 5, quantity: 1,
        serialNumber: 'CHILD-IN\nCHILD-OUT\nSHARED',
        releaseHistory: [{id:'child-release', date:'2026-10-15', quantity:2, releasedSerials:['CHILD-OUT', 'SHARED']}]
      }]
    }];
    h.run('items = receiptItems');
    h.set(...range, 'travel');
    await h.run('exportToPDF()');
    h.run('exportToExcel()');
    const pdfRows = h.pdfs[0][0];
    assert.equal(pdfRows[0][3].content, 'PARENT-IN\nPARENT-OUT\nSHARED');
    assert.deepEqual(Array.from(pdfRows[0][3].serialMeta.lines, line => line.isDeducted), [false, true, false]);
    assert.equal(pdfRows[1][3].content, 'CHILD-IN\nCHILD-OUT\nSHARED');
    assert.deepEqual(Array.from(pdfRows[1][3].serialMeta.lines, line => line.isDeducted), [false, true, true]);
    const sheet = h.books[0].sheet;
    const parent = sheet.rows.findIndex(row => row[1] === 'Parent with serials');
    const child = sheet.rows.findIndex(row => row[1] === '>> Child with serials');
    const strike = text => [...text].map(c => c + '\u0336').join('');
    assert.equal(sheet[`R${parent}C3`].v, `PARENT-IN\n${strike('PARENT-OUT')}\nSHARED`);
    assert.equal(sheet[`R${child}C3`].v, `CHILD-IN\n${strike('CHILD-OUT')}\n${strike('SHARED')}`);
    assert.equal(sheet[`R${parent}C3`].s.font.strike, false);
    assert.equal(sheet[`R${child}C3`].s.font.strike, false);
    assert.equal(h.context.receiptItems[0].serialNumber, 'PARENT-IN\nPARENT-OUT\nSHARED');
  }
});

test('PDF strikes follow wrapped deducted lines across page fragments without striking active serials', () => {
  const h = harness();
  const strokes = [];
  const doc = {
    internal: {scaleFactor: 2}, getLineHeightFactor: () => 1.15,
    splitTextToSize: text => text.match(/.{1,4}/g),
    getTextWidth: text => text.length,
    saveGraphicsState() {}, restoreGraphicsState() {}, setDrawColor() {}, setLineWidth() {},
    line: (...args) => strokes.push(args)
  };
  h.context.testDoc = doc;
  h.run(`hooks = _getPdfSerialHooks(testDoc); raw = _getPdfSerialCell(_getSerialExportMeta('ACTIVE\\nDEDUCTED', [{releasedSerials:['DEDUCTED']}]));`);
  const cell = { raw: h.context.raw, styles: {fontSize:10, halign:'center'}, getTextPos: () => ({x:50,y:20}) };
  h.context.hooks.didParseCell({section:'body', cell});
  const wrapped = cell.styles.overflow([], 20);
  assert.deepEqual(Array.from(wrapped), ['ACTI', 'VE', 'DEDU', 'CTED']);
  cell.text = wrapped.slice(0, 3);
  h.context.hooks.didDrawCell({section:'body', cell});
  assert.equal(strokes.length, 1);
  assert.deepEqual(strokes[0], [48, 34.25, 52, 34.25]);
  cell.text = wrapped.slice(3);
  h.context.hooks.didDrawCell({section:'body', cell});
  assert.equal(strokes.length, 2);
  assert.deepEqual(strokes[1], [48, 22.75, 52, 22.75]);
});

test('PDF cross-outs align with vertically centered Full Inventory serials', () => {
  const h = harness();
  const strokes = [];
  const doc = {
    internal: {scaleFactor: 2}, getLineHeightFactor: () => 1.15,
    splitTextToSize: text => [text], getTextWidth: text => text.length,
    saveGraphicsState() {}, restoreGraphicsState() {}, setDrawColor() {}, setLineWidth() {},
    line: (...args) => strokes.push(args)
  };
  h.context.testDoc = doc;
  h.run(`hooks = _getPdfSerialHooks(testDoc); raw = _getPdfSerialCell(_getSerialExportMeta('ACTIVE\\nDEDUCTED', [{releasedSerials:['DEDUCTED']}]));`);
  const cell = {
    raw: h.context.raw, styles: {fontSize:10, halign:'center', valign:'middle'},
    getTextPos: () => ({x:50,y:20})
  };
  h.context.hooks.didParseCell({section:'body', cell});
  cell.text = cell.styles.overflow([], 20);
  h.context.hooks.didDrawCell({section:'body', cell});
  assert.equal(strokes.length, 1);
  // The second line's baseline is 24.25; cross through the glyphs 1.5 units above it.
  assert.deepEqual(strokes[0], [46, 22.75, 54, 22.75]);
});

test('released scope uses release dates instead of dates items were added', () => {
  const h = harness();
  const source = JSON.stringify(h.context.fixtureData);
  h.run("result = getExportItems(items, '2026-10-01', '2026-10-31', 'travel_released')");
  const result = h.context.result;
  assert.deepEqual(Array.from(result, item => item.id), ['bundle', 'mixed']);
  assert.deepEqual(Array.from(result[0].subItems, sub => sub.id), ['a']);
  assert.equal(h.run('getItemReleasedQuantity(result[1])'), 5);
  assert.equal(h.run('getItemReleasedValue(result[1])'), 50);
  assert.equal(h.run('getItemReleasedQuantity(result[0])'), 4);
  assert.equal(JSON.stringify(h.context.fixtureData), source);
});

test('all-item scopes retain added-or-released membership and full inventory history', () => {
  const h = harness();
  for (const scope of ['full', 'travel']) {
    h.context.scope = scope;
    h.run("result = getExportItems(items, '2026-10-01', '2026-10-31', scope)");
    assert.deepEqual(Array.from(h.context.result, item => item.id), ['bundle', 'mixed', 'created-only']);
  }
  h.run("result = getExportItems(items, '2026-10-01', '2026-10-31', 'full')");
  assert.equal(h.run('getItemReleasedQuantity(result[1])'), 12);
  h.run("result = getExportItems(items, '2026-10-01', '2026-10-31', 'travel')");
  assert.equal(h.run('getItemReleasedQuantity(result[1])'), 5);
  assert.equal(h.run('getItemReleasedQuantity(result[2])'), 0);
});

test('mirrored parent/sub-item release records are not counted twice when filtering', () => {
  const h = harness();
  h.run(`
    const bundle = items.find(item => item.id === 'bundle');
    bundle.releaseHistory = bundle.subItems.flatMap(sub => sub.releaseHistory.map(release => ({
      ...release, id: release.id + '-p', subItemId: sub.id, subItemName: sub.name
    })));
    result = getExportItems(items, '2026-10-01', '2026-10-31', 'travel_released');
  `);
  assert.equal(h.run('getItemReleasedQuantity(result[0])'), 4);
  assert.equal(h.run('getItemReleasedValue(result[0])'), 8);
  assert.equal(h.context.result[0].subItems.length, 1);
});

test('blank, one-sided, single-day, inclusive boundaries and empty ranges work', () => {
  const h = harness();
  assert.equal(h.run("getExportItems(items, '', '', 'travel_released').length"), 3);
  assert.equal(h.run("getExportItems(items, '2026-10-01', '', 'travel_released').length"), 2);
  assert.equal(h.run("getExportItems(items, '', '2026-09-30', 'travel_released').length"), 3);
  assert.equal(h.run("getItemReleasedQuantity(getExportItems(items, '2026-10-10', '2026-10-10', 'travel_released')[0])"), 2);
  assert.equal(h.run("getExportItems(items, '2027-01-01', '2027-01-31', 'travel_released').length"), 0);
  assert.equal(h.run("isDateWithinRange(new Date(2026, 9, 31, 23, 59, 59, 999), '2026-10-01', '2026-10-31')"), true);
  assert.equal(h.run("isDateWithinRange(new Date(2026, 10, 1, 0, 0, 0), '2026-10-01', '2026-10-31')"), false);
  assert.equal(h.run("releaseMatchesExportDateRange({date:'2026-10-10', releasedAt:'2026-11-03'}, '2026-10-10', '2026-10-10')"), true);
});

test('PDF, Excel, preview, quantities, values and serials agree for a released date range', async () => {
  const h = harness();
  h.set('2026-10-01', '2026-10-31', 'travel_released');
  h.run('updateExportRangeBadge()');
  await h.run('exportToPDF()');
  h.run('exportToExcel()');
  const pdfRows = h.pdfs[0][0];
  const excelRows = h.books[0].sheet.rows.filter(row => /^\d+\./.test(String(row[0])));
  const normalized = rows => Array.from(rows, row => Array.from(row, value => String(value)));
  assert.deepEqual(normalized(pdfRows), normalized(excelRows));
  assert.equal(pdfRows.length, 3);
  assert.equal(pdfRows[1][2], '4');
  assert.equal(pdfRows[2][2], '5');
  assert.match(pdfRows[2][3], /IN-FIRST/);
  assert.match(pdfRows[2][3], /IN-LAST/);
  assert.doesNotMatch(JSON.stringify(pdfRows), /OUTSIDE|OLD-CREATED|September child/);
  assert.deepEqual(Array.from(h.context.window._previewFilteredItems, item => item.id), ['bundle', 'mixed']);
  assert.match(h.element('exportSummaryCards').innerHTML, />9<\/span>/);
  assert.match(h.element('exportSummaryCards').innerHTML, /PHP 58\.00/);
});

test('reversed dates and no matching releases prevent both exports', async () => {
  const h = harness();
  h.set('2026-11-03', '2026-10-01', 'travel_released');
  h.run('updateExportRangeBadge()');
  assert.equal(h.element('btnExportPDF').disabled, true);
  assert.equal(h.element('btnExportExcel').disabled, true);
  await h.run('exportToPDF()');
  h.run('exportToExcel()');
  assert.equal(h.pdfs.length + h.books.length, 0);
  assert.match(h.messages[0], /From date must be on or before To date/);
  h.set('2027-01-01', '2027-01-31', 'travel_released');
  await h.run('exportToPDF()');
  h.run('exportToExcel()');
  assert.equal(h.pdfs.length + h.books.length, 0);
  assert.match(h.messages.at(-1), /No releases match/);
});

test('quick presets and Clear Range update the range consistently', () => {
  const NativeDate = Date;
  class FixedDate extends NativeDate {
    constructor(...args) { super(...(args.length ? args : ['2026-11-03T12:00:00'])); }
  }
  const h = harness(FixedDate);
  for (const [preset, expectedFrom] of [['today', '2026-11-03'], ['this_week', '2026-11-02'], ['this_month', '2026-11-01'], ['this_year', '2026-01-01']]) {
    h.context.preset = preset;
    h.run('setExportDatePreset(preset)');
    assert.equal(h.element('exportDateFrom').value, expectedFrom);
    assert.equal(h.element('exportDateTo').value, '2026-11-03');
  }
  h.run('clearExportDateRange()');
  assert.equal(h.element('exportDateFrom').value, '');
  assert.equal(h.element('exportDateTo').value, '');
  assert.equal(h.element('btnExportPDF').disabled, false);
});

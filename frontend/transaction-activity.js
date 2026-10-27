/**
 * Transaction Activity Engine
 * DICT-NBP Inventory Management Suite
 */

(function () {
  'use strict';

  // ── Global State ───────────────────────────────────────────────────────────
  let rawInventoryItems = [];
  let currentGrouping = 'weeks'; // 'weeks' | 'months' | 'years'
  let currentMetricMode = 'qty'; // 'qty' | 'value'
  let filterDateFrom = '';
  let filterDateTo = '';
  let activePreset = 'all';
  let searchQuery = '';
  let filterType = 'all';

  // Chart.js Instances
  let trendsChart = null;
  let distributionChart = null;
  let topItemsChart = null;

  const CURRENCY_SYMBOL = '\u20B1';

  // ── Formatting Helpers ─────────────────────────────────────────────────────
  function formatQty(n) {
    return Number(n || 0).toLocaleString('en-US');
  }

  function formatMoney(n) {
    return `${CURRENCY_SYMBOL}${Number(n || 0).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })}`;
  }

  function formatDateIso(dateObj) {
    if (!dateObj || Number.isNaN(dateObj.getTime())) return '';
    const offset = new Date(dateObj.getTime() - dateObj.getTimezoneOffset() * 60000);
    return offset.toISOString().slice(0, 10);
  }

  function parseDate(val) {
    if (!val) return null;
    const d = new Date(val);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function formatDateDisplay(d) {
    if (!d) return '-';
    return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function extractReleasedSerialsList(release) {
    if (!release) return [];
    if (Array.isArray(release.releasedSerials)) {
      return release.releasedSerials
        .map((s) => (s !== null && s !== undefined ? String(s).trim() : ''))
        .filter(Boolean);
    }
    if (typeof release.releasedSerials === 'string' && release.releasedSerials.trim()) {
      return release.releasedSerials
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return [];
  }

  // ── Data Ingestion & Extraction ────────────────────────────────────────────
  /**
   * Transforms raw MongoDB inventory items into discrete transaction events
   * with full deduplication between parent items and child sub-items.
   */
  function extractTransactions(items) {
    const additions = [];
    const releases = [];
    const seenReleaseIds = new Set();

    function getCanonicalReleaseId(release) {
      return typeof release.id === 'string' ? release.id.replace(/-p$/, '') : '';
    }

    function isSubItemRelease(release, sub) {
      const normalizedSubName = String(sub.name || '').trim().toLowerCase();
      const recordedSubName = String(release.subItemName || '').trim().toLowerCase();
      return release.subItemId === sub.id ||
        (normalizedSubName !== '' && recordedSubName === normalizedSubName) ||
        (typeof release.remarks === 'string' && release.remarks.startsWith(`[Sub-item: ${sub.name}]`));
    }

    items.forEach((item) => {
      const price = Number(item.price) || 0;
      const createdDate = parseDate(item.createdAt);
      const hasSubs = Array.isArray(item.subItems) && item.subItems.length > 0;

      // 1. Record Additions (Initial stock entry)
      if (hasSubs) {
        // When item has sub-items, inventory additions are recorded per sub-item
        item.subItems.forEach((sub, sIdx) => {
          const sInStock = Number(sub.quantity) || 0;
          const sSold = Number(sub.soldQuantity) || 0;
          const sPrice = Number(sub.price) || 0;
          const sTotal = sInStock + sSold;
          const subUnit = sub.unitType || sub.unit || item.unitType || item.unit || 'pcs';

          additions.push({
            id: `add-sub-${item._id || item.id}-${sub.id || sIdx}`,
            itemId: item._id || item.id,
            subItemId: sub.id,
            name: `${item.name} — ${sub.name}`,
            type: 'added',
            unitType: subUnit,
            serialNumber: sub.serialNumber || item.serialNumber || '',
            date: createdDate,
            dateStr: formatDateIso(createdDate),
            quantity: sTotal,
            unitPrice: sPrice,
            value: sTotal * sPrice,
            remarks: sub.inventoryRemarks || sub.description || item.inventoryRemarks || 'Sub-item stock entry'
          });
        });
      } else {
        const inStock = Number(item.quantity) || 0;
        const sold = Number(item.soldQuantity) || 0;
        const totalCreatedQty = inStock + sold;
        const itemUnit = item.unitType || item.unit || 'pcs';

        additions.push({
          id: `add-${item._id || item.id}`,
          itemId: item._id || item.id,
          name: item.name,
          type: 'added',
          unitType: itemUnit,
          serialNumber: item.serialNumber || '',
          date: createdDate,
          dateStr: formatDateIso(createdDate),
          quantity: totalCreatedQty,
          unitPrice: price,
          value: totalCreatedQty * price,
          remarks: item.inventoryRemarks || item.description || 'Initial stock entry'
        });
      }

      // 2. Record Releases (Deduplicated)
      if (hasSubs) {
        // A. Sub-item releases
        item.subItems.forEach((sub, sIdx) => {
          const sPrice = Number(sub.price) || 0;
          const subRels = Array.isArray(sub.releaseHistory) ? sub.releaseHistory : [];
          const subUnit = sub.unitType || sub.unit || item.unitType || item.unit || 'pcs';

          subRels.forEach((subRel, rIdx) => {
            const relQty = Number(subRel.quantity) || 0;
            if (relQty <= 0) return;

            const cid = getCanonicalReleaseId(subRel) || `subrel-${sub.id || sIdx}-${rIdx}`;
            if (seenReleaseIds.has(cid)) return;
            seenReleaseIds.add(cid);

            const unitPrice = Number(subRel.unitPrice !== undefined ? subRel.unitPrice : sPrice) || 0;
            const relDate = parseDate(subRel.releasedAt || subRel.date);

            const serialsList = extractReleasedSerialsList(subRel);
            const relSerials = serialsList.join('\n');

            releases.push({
              id: cid,
              itemId: item._id || item.id,
              subItemId: sub.id,
              name: `${item.name} — ${sub.name}`,
              type: 'released',
              unitType: subRel.unitType || subUnit,
              serialNumber: relSerials,
              releasedSerials: serialsList,
              date: relDate,
              dateStr: formatDateIso(relDate),
              quantity: relQty,
              unitPrice: unitPrice,
              value: relQty * unitPrice,
              remarks: subRel.remarks || `Sub-item release: ${sub.name}`
            });
          });
        });

        // B. Main item releases (filter out any copied sub-item releases)
        const parentHistory = Array.isArray(item.releaseHistory) ? item.releaseHistory : [];
        parentHistory.forEach((rel, pIdx) => {
          const relQty = Number(rel.quantity) || 0;
          if (relQty <= 0) return;

          // Skip if this parent release belongs to a sub-item
          if (rel.subItemId || item.subItems.some((sub) => isSubItemRelease(rel, sub))) {
            return;
          }

          const cid = getCanonicalReleaseId(rel) || `rel-${item._id || item.id}-${pIdx}`;
          if (seenReleaseIds.has(cid)) return;
          seenReleaseIds.add(cid);

          const unitPrice = Number(rel.unitPrice !== undefined ? rel.unitPrice : price) || 0;
          const relDate = parseDate(rel.releasedAt || rel.date);
          const itemUnit = item.unitType || item.unit || 'pcs';
          const serialsList = extractReleasedSerialsList(rel);
          const relSerials = serialsList.join('\n');

          releases.push({
            id: cid,
            itemId: item._id || item.id,
            name: item.name,
            type: 'released',
            unitType: rel.unitType || itemUnit,
            serialNumber: relSerials,
            releasedSerials: serialsList,
            date: relDate,
            dateStr: formatDateIso(relDate),
            quantity: relQty,
            unitPrice: unitPrice,
            value: relQty * unitPrice,
            remarks: rel.remarks || 'Stock release'
          });
        });
      } else {
        // Items without sub-items
        if (Array.isArray(item.releaseHistory)) {
          item.releaseHistory.forEach((rel, relIdx) => {
            const relQty = Number(rel.quantity) || 0;
            if (relQty <= 0) return;

            const cid = getCanonicalReleaseId(rel) || `rel-${item._id || item.id}-${relIdx}`;
            if (seenReleaseIds.has(cid)) return;
            seenReleaseIds.add(cid);

            const unitPrice = Number(rel.unitPrice !== undefined ? rel.unitPrice : price) || 0;
            const relDate = parseDate(rel.releasedAt || rel.date);
            const itemUnit = item.unitType || item.unit || 'pcs';
            const serialsList = extractReleasedSerialsList(rel);
            const relSerials = serialsList.join('\n');

            releases.push({
              id: cid,
              itemId: item._id || item.id,
              name: item.name,
              type: 'released',
              unitType: rel.unitType || itemUnit,
              serialNumber: relSerials,
              releasedSerials: serialsList,
              date: relDate,
              dateStr: formatDateIso(relDate),
              quantity: relQty,
              unitPrice: unitPrice,
              value: relQty * unitPrice,
              remarks: rel.remarks || 'Stock release'
            });
          });
        }
      }
    });

    return { additions, releases };
  }

  // ── Date Filtering ─────────────────────────────────────────────────────────
  function isDateInRange(dateObj) {
    if (!dateObj) return true;
    const dateStr = formatDateIso(dateObj);
    if (filterDateFrom && dateStr < filterDateFrom) return false;
    if (filterDateTo && dateStr > filterDateTo) return false;
    return true;
  }

  function getFilteredTransactions() {
    const { additions, releases } = extractTransactions(rawInventoryItems);

    const filteredAdditions = additions.filter((a) => !a.date || isDateInRange(a.date));
    const filteredReleases = releases.filter((r) => !r.date || isDateInRange(r.date));

    return { filteredAdditions, filteredReleases };
  }

  // ── KPI Metrics Cards ──────────────────────────────────────────────────────
  function updateKpiCards() {
    let totalTypes = rawInventoryItems.length;
    let inStockQty = 0;
    let inStockValue = 0;
    let releasedQty = 0;
    let releasedValue = 0;

    rawInventoryItems.forEach((item) => {
      const price = Number(item.price) || 0;
      const hasSubs = Array.isArray(item.subItems) && item.subItems.length > 0;

      if (hasSubs) {
        item.subItems.forEach((sub) => {
          const sQty = Number(sub.quantity) || 0;
          const sSold = Number(sub.soldQuantity) || 0;
          const sPrice = Number(sub.price) || 0;
          inStockQty += sQty;
          inStockValue += sQty * sPrice;
          releasedQty += sSold;
          releasedValue += sSold * sPrice;
        });
      } else {
        const qty = Number(item.quantity) || 0;
        const sold = Number(item.soldQuantity) || 0;
        inStockQty += qty;
        inStockValue += qty * price;
        releasedQty += sold;
        releasedValue += sold * price;
      }
    });

    const totalHandledQty = inStockQty + releasedQty;
    const totalHandledValue = inStockValue + releasedValue;
    const turnover = totalHandledQty > 0 ? ((releasedQty / totalHandledQty) * 100).toFixed(1) : '0.0';

    // Update DOM if KPI cards exist
    const kpiRemainingQty = document.getElementById('kpiRemainingQty');
    if (!kpiRemainingQty) return;

    kpiRemainingQty.innerText = formatQty(inStockQty);
    document.getElementById('kpiRemainingValue').innerText = formatMoney(inStockValue);

    document.getElementById('kpiReleasedQty').innerText = formatQty(releasedQty);
    document.getElementById('kpiReleasedValue').innerText = formatMoney(releasedValue);

    document.getElementById('kpiTotalQty').innerText = formatQty(totalHandledQty);
    document.getElementById('kpiTotalValue').innerText = formatMoney(totalHandledValue);

    document.getElementById('kpiTurnoverRate').innerText = `${turnover}%`;
    document.getElementById('kpiItemTypes').innerText = `${totalTypes} Registered Item Types`;
  }

  // ── Time Grouping Aggregators (Weeks, Months, Years) ───────────────────────
  function getGroupKey(dateObj) {
    if (!dateObj || Number.isNaN(dateObj.getTime())) return 'Unknown Date';
    const y = dateObj.getFullYear();
    const m = dateObj.getMonth();

    if (currentGrouping === 'years') {
      return `${y}`;
    }

    if (currentGrouping === 'months') {
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${monthNames[m]} ${y}`;
    }

    // Default: 'weeks'
    // Calculate week number of year
    const startOfYear = new Date(y, 0, 1);
    const dayDiff = Math.floor((dateObj - startOfYear) / (24 * 60 * 60 * 1000));
    const weekNum = Math.ceil((dayDiff + startOfYear.getDay() + 1) / 7);
    return `Wk ${weekNum}, ${y}`;
  }

  function getGroupSortOrder(key) {
    // Helper to sort labels chronologically
    if (key.startsWith('Wk ')) {
      const parts = key.replace('Wk ', '').split(', ');
      return Number(parts[1] || 0) * 100 + Number(parts[0] || 0);
    }
    const monthsMap = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
    const mParts = key.split(' ');
    if (mParts.length === 2 && monthsMap[mParts[0]]) {
      return Number(mParts[1] || 0) * 100 + monthsMap[mParts[0]];
    }
    return Number(key) || 0;
  }

  // ── Chart 1: Main Trends Chart (Added vs Released) ─────────────────────────
  function renderMainTrendsChart(additions, releases) {
    const buckets = {};

    function ensureBucket(k) {
      if (!buckets[k]) {
        buckets[k] = { addedQty: 0, addedVal: 0, releasedQty: 0, releasedVal: 0 };
      }
    }

    additions.forEach((a) => {
      if (!a.date) return;
      const k = getGroupKey(a.date);
      ensureBucket(k);
      buckets[k].addedQty += a.quantity;
      buckets[k].addedVal += a.value;
    });

    releases.forEach((r) => {
      if (!r.date) return;
      const k = getGroupKey(r.date);
      ensureBucket(k);
      buckets[k].releasedQty += r.quantity;
      buckets[k].releasedVal += r.value;
    });

    // If no records in range, provide a clean empty bucket
    if (Object.keys(buckets).length === 0) {
      buckets['No Activity in Period'] = { addedQty: 0, addedVal: 0, releasedQty: 0, releasedVal: 0 };
    }

    const sortedKeys = Object.keys(buckets).sort((a, b) => getGroupSortOrder(a) - getGroupSortOrder(b));

    const addedData = sortedKeys.map((k) =>
      currentMetricMode === 'qty' ? buckets[k].addedQty : buckets[k].addedVal
    );
    const releasedData = sortedKeys.map((k) =>
      currentMetricMode === 'qty' ? buckets[k].releasedQty : buckets[k].releasedVal
    );

    const isVal = currentMetricMode === 'value';
    const canvas = document.getElementById('mainTrendsCanvas');
    if (!canvas) return;

    if (trendsChart) trendsChart.destroy();

    trendsChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: sortedKeys,
        datasets: [
          {
            label: isVal ? 'Items Added (₱ Value)' : 'Items Added (Qty)',
            data: addedData,
            backgroundColor: 'rgba(2, 132, 199, 0.8)',
            borderColor: '#0284c7',
            borderWidth: 1.5,
            borderRadius: 6,
            maxBarThickness: 42
          },
          {
            label: isVal ? 'Items Released (₱ Value)' : 'Items Released (Qty)',
            data: releasedData,
            backgroundColor: 'rgba(16, 185, 129, 0.8)',
            borderColor: '#10b981',
            borderWidth: 1.5,
            borderRadius: 6,
            maxBarThickness: 42
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            backgroundColor: 'rgba(15, 23, 42, 0.95)',
            padding: 12,
            titleFont: { size: 12, weight: 'bold' },
            bodyFont: { size: 12 },
            callbacks: {
              label: function (ctx) {
                const val = ctx.parsed.y;
                return isVal ? ` ${ctx.dataset.label}: ${formatMoney(val)}` : ` ${ctx.dataset.label}: ${formatQty(val)} units`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              font: { size: 11, family: 'Inter' },
              color: '#64748b'
            }
          },
          y: {
            beginAtZero: true,
            grid: { color: '#f1f5f9' },
            ticks: {
              font: { size: 11, family: 'Inter' },
              color: '#64748b',
              callback: function (val) {
                return isVal ? `${CURRENCY_SYMBOL}${val.toLocaleString()}` : val.toLocaleString();
              }
            }
          }
        }
      }
    });

    // Update title labels
    const title = document.getElementById('mainChartTitle');
    const subtitle = document.getElementById('mainChartSubtitle');
    if (title && subtitle) {
      const modeLabel = isVal ? 'Asset Valuation (₱)' : 'Stock Quantities';
      const groupLabel = currentGrouping.charAt(0).toUpperCase() + currentGrouping.slice(1);
      title.innerText = `Item Inflow vs Outflow — ${modeLabel}`;
      subtitle.innerText = `Aggregated by ${groupLabel} across selected timeline filter`;
    }
  }

  // ── Chart 2: Distribution Doughnut Chart ───────────────────────────────────
  function renderDistributionChart() {
    let inStockQty = 0;
    let inStockVal = 0;
    let releasedQty = 0;
    let releasedVal = 0;

    rawInventoryItems.forEach((item) => {
      const price = Number(item.price) || 0;
      const inStock = Number(item.quantity) || 0;
      const sold = Number(item.soldQuantity) || 0;

      if (Array.isArray(item.subItems) && item.subItems.length > 0) {
        item.subItems.forEach((s) => {
          const sQ = Number(s.quantity) || 0;
          const sS = Number(s.soldQuantity) || 0;
          const sP = Number(s.price) || 0;
          inStockQty += sQ;
          inStockVal += sQ * sP;
          releasedQty += sS;
          releasedVal += sS * sP;
        });
      } else {
        inStockQty += inStock;
        inStockVal += inStock * price;
        releasedQty += sold;
        releasedVal += sold * price;
      }
    });

    const isVal = currentMetricMode === 'value';
    const inStockData = isVal ? inStockVal : inStockQty;
    const releasedData = isVal ? releasedVal : releasedQty;

    const canvas = document.getElementById('distributionCanvas');
    if (!canvas) return;

    if (distributionChart) distributionChart.destroy();

    distributionChart = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: ['In Stock', 'Released'],
        datasets: [
          {
            data: [inStockData, releasedData],
            backgroundColor: ['#0284c7', '#10b981'],
            hoverBackgroundColor: ['#0369a1', '#059669'],
            borderWidth: 2,
            borderColor: '#ffffff'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '70%',
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(15, 23, 42, 0.95)',
            padding: 10,
            callbacks: {
              label: function (ctx) {
                const total = inStockData + releasedData;
                const val = ctx.parsed;
                const pct = total > 0 ? ((val / total) * 100).toFixed(1) : '0';
                return isVal
                  ? ` ${ctx.label}: ${formatMoney(val)} (${pct}%)`
                  : ` ${ctx.label}: ${formatQty(val)} units (${pct}%)`;
              }
            }
          }
        }
      }
    });

    // Update bottom legend
    const legendEl = document.getElementById('distributionLegend');
    if (legendEl) {
      legendEl.innerHTML = `
        <div class="flex items-center gap-2">
          <span class="w-3 h-3 rounded-full bg-sky-600"></span>
          <span>In Stock: <strong>${isVal ? formatMoney(inStockVal) : formatQty(inStockQty)}</strong></span>
        </div>
        <div class="flex items-center gap-2">
          <span class="w-3 h-3 rounded-full bg-emerald-500"></span>
          <span>Released: <strong>${isVal ? formatMoney(releasedVal) : formatQty(releasedQty)}</strong></span>
        </div>
      `;
    }
  }

  // ── Chart 3: Top Released Items Horizontal Bar Chart ───────────────────────
  function renderTopItemsChart(releases) {
    const itemMap = {};

    releases.forEach((r) => {
      const key = r.name;
      if (!itemMap[key]) itemMap[key] = { qty: 0, val: 0 };
      itemMap[key].qty += r.quantity;
      itemMap[key].val += r.value;
    });

    const isVal = currentMetricMode === 'value';
    const sorted = Object.keys(itemMap)
      .map((k) => ({ name: k, total: isVal ? itemMap[k].val : itemMap[k].qty }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 7);

    const labels = sorted.map((s) => s.name);
    const data = sorted.map((s) => s.total);

    const canvas = document.getElementById('topItemsCanvas');
    if (!canvas) return;

    if (topItemsChart) topItemsChart.destroy();

    topItemsChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: labels.length ? labels : ['No Releases in Period'],
        datasets: [
          {
            axis: 'y',
            label: isVal ? 'Total Released (₱)' : 'Total Released (Qty)',
            data: data.length ? data : [0],
            backgroundColor: 'rgba(245, 158, 11, 0.8)',
            borderColor: '#f59e0b',
            borderWidth: 1.5,
            borderRadius: 6
          }
        ]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(15, 23, 42, 0.95)',
            callbacks: {
              label: function (ctx) {
                return isVal
                  ? ` Released: ${formatMoney(ctx.parsed.x)}`
                  : ` Released: ${formatQty(ctx.parsed.x)} units`;
              }
            }
          }
        },
        scales: {
          x: {
            beginAtZero: true,
            grid: { color: '#f1f5f9' },
            ticks: {
              font: { size: 10, family: 'Inter' },
              color: '#64748b',
              callback: (val) => (isVal ? `${CURRENCY_SYMBOL}${val.toLocaleString()}` : val.toLocaleString())
            }
          },
          y: {
            grid: { display: false },
            ticks: {
              font: { size: 11, family: 'Inter' },
              color: '#334155'
            }
          }
        }
      }
    });
  }

  // ── Sorting State ──────────────────────────────────────────────────────────
  let currentSortColumn = 'date'; // 'date' | 'type' | 'name' | 'quantity' | 'unitPrice' | 'value'
  let currentSortDirection = 'desc'; // 'asc' | 'desc'

  function updateSortIcons() {
    const columns = ['date', 'type', 'name', 'unitType', 'quantity', 'unitPrice', 'value'];
    columns.forEach((col) => {
      const icon = document.getElementById(`sortIcon_${col}`);
      if (!icon) return;
      if (currentSortColumn === col) {
        if (currentSortDirection === 'asc') {
          icon.className = 'fa-solid fa-sort-up text-sky-600 text-[11px] font-bold';
        } else {
          icon.className = 'fa-solid fa-sort-down text-sky-600 text-[11px] font-bold';
        }
      } else {
        icon.className = 'fa-solid fa-sort text-slate-400 text-[10px]';
      }
    });
  }

  // ── Transaction Table ──────────────────────────────────────────────────────
  function renderTransactionTable() {
    const { filteredAdditions, filteredReleases } = getFilteredTransactions();
    const typeFilterEl = document.getElementById('tableTypeFilter');
    const selectedType = typeFilterEl ? typeFilterEl.value : 'all';

    let list = [];
    if (selectedType === 'all' || selectedType === 'added') {
      list.push(...filteredAdditions);
    }
    if (selectedType === 'all' || selectedType === 'released') {
      list.push(...filteredReleases);
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          (t.serialNumber && t.serialNumber.toLowerCase().includes(q)) ||
          (t.unitType && t.unitType.toLowerCase().includes(q)) ||
          (t.remarks && t.remarks.toLowerCase().includes(q))
      );
    }

    // Sort transactions
    list.sort((a, b) => {
      let cmp = 0;
      if (currentSortColumn === 'date') {
        const timeA = a.date ? a.date.getTime() : 0;
        const timeB = b.date ? b.date.getTime() : 0;
        cmp = timeA - timeB;
      } else if (currentSortColumn === 'type') {
        if (a.type !== b.type) {
          // 'added' before 'released' in asc
          cmp = a.type.localeCompare(b.type);
        } else {
          // Secondary sort by date (descending)
          const timeA = a.date ? a.date.getTime() : 0;
          const timeB = b.date ? b.date.getTime() : 0;
          return timeB - timeA;
        }
      } else if (currentSortColumn === 'name') {
        cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      } else if (currentSortColumn === 'unitType') {
        cmp = (a.unitType || '').localeCompare(b.unitType || '');
      } else if (currentSortColumn === 'quantity') {
        cmp = a.quantity - b.quantity;
      } else if (currentSortColumn === 'unitPrice') {
        cmp = a.unitPrice - b.unitPrice;
      } else if (currentSortColumn === 'value') {
        cmp = a.value - b.value;
      }

      return currentSortDirection === 'asc' ? cmp : -cmp;
    });

    const tbody = document.getElementById('transactionsTableBody');
    const countEl = document.getElementById('tableRecordCount');
    if (!tbody) return;

    if (list.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="9" class="py-12 text-center text-slate-400">
            <i class="fa-solid fa-inbox text-3xl mb-2 text-slate-300 block"></i>
            No transactions match the selected event type or search criteria.
          </td>
        </tr>
      `;
      if (countEl) countEl.innerText = '0 transactions found';
      return;
    }

    tbody.innerHTML = list
      .map((t, idx) => {
        const isAdd = t.type === 'added';
        const badge = isAdd
          ? `<span class="badge-added"><i class="fa-solid fa-plus text-[9px]"></i> Added</span>`
          : `<span class="badge-released"><i class="fa-solid fa-arrow-up-from-bracket text-[9px]"></i> Released</span>`;

        return `
          <tr class="hover:bg-slate-50/80 transition">
            <td class="py-2.5 px-3 text-center text-slate-400 font-mono text-[11px] font-medium whitespace-nowrap">${idx + 1}</td>
            <td class="py-2.5 px-3 text-slate-600 font-mono text-[11px] whitespace-nowrap">${formatDateDisplay(t.date)}</td>
            <td class="py-2.5 px-3 whitespace-nowrap">${badge}</td>
            <td class="py-2.5 px-3 font-medium text-slate-800 max-w-[320px] truncate" title="${t.name.replace(/"/g, '&quot;')}">${t.name}</td>
            <td class="py-2.5 px-3 text-center">
              ${t.serialNumber
            ? t.serialNumber.split('\n').filter(s => s.trim()).map(s => {
              const isRel = !isAdd;
              return `<span class="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 mb-0.5 rounded border leading-snug whitespace-nowrap ${isRel ? 'bg-rose-50 text-rose-500 border-rose-200 line-through' : 'bg-slate-100 text-slate-700 border-slate-200'}">${escapeHtml(s.trim())}${isRel ? ' <i class="fa-solid fa-xmark text-[8px] text-rose-400"></i>' : ''}</span>`;
            }).join('<br>')
            : '<span class="text-slate-300 text-xs">—</span>'}
            </td>
            <td class="py-2.5 px-3 text-center whitespace-nowrap">
              <span class="inline-block px-2 py-0.5 text-[11px] font-medium rounded bg-slate-100 text-slate-600 border border-slate-200/80">${t.unitType || 'pcs'}</span>
            </td>
            <td class="py-2.5 px-3 text-right font-semibold text-slate-800">${formatQty(t.quantity)}</td>
            <td class="py-2.5 px-3 text-right text-slate-600">${formatMoney(t.unitPrice)}</td>
            <td class="py-2.5 px-3 text-right font-bold ${isAdd ? 'text-sky-700' : 'text-emerald-700'}">${formatMoney(t.value)}</td>
          </tr>
        `;
      })
      .join('');

    const addCount = list.filter((t) => t.type === 'added').length;
    const relCount = list.filter((t) => t.type === 'released').length;

    if (countEl) {
      if (selectedType === 'added') {
        countEl.innerText = `Showing ${list.length} Added record${list.length === 1 ? '' : 's'}`;
      } else if (selectedType === 'released') {
        countEl.innerText = `Showing ${list.length} Released record${list.length === 1 ? '' : 's'}`;
      } else {
        countEl.innerText = `Showing ${list.length} transactions (${addCount} Added, ${relCount} Released)`;
      }
    }
  }

  // ── Public User Interactions ───────────────────────────────────────────────
  window.setTimeGrouping = function (group) {
    currentGrouping = group;
    ['weeks', 'months', 'years'].forEach((g) => {
      const btn = document.getElementById(`btnGroup${g.charAt(0).toUpperCase() + g.slice(1)}`);
      if (btn) {
        if (g === group) {
          btn.className = 'group-btn px-3 py-1 rounded-md transition font-semibold text-slate-700 bg-white shadow-xs cursor-pointer';
        } else {
          btn.className = 'group-btn px-3 py-1 rounded-md transition font-medium text-slate-600 hover:text-slate-900 cursor-pointer';
        }
      }
    });

    const { filteredAdditions, filteredReleases } = getFilteredTransactions();
    renderMainTrendsChart(filteredAdditions, filteredReleases);
  };

  window.setMetricMode = function (mode) {
    currentMetricMode = mode;
    const btnQty = document.getElementById('btnModeQty');
    const btnVal = document.getElementById('btnModeValue');

    if (btnQty && btnVal) {
      if (mode === 'qty') {
        btnQty.className = 'mode-btn px-3 py-1 rounded-md transition font-semibold text-sky-700 bg-white shadow-xs cursor-pointer';
        btnVal.className = 'mode-btn px-3 py-1 rounded-md transition font-medium text-slate-600 hover:text-slate-900 cursor-pointer';
      } else {
        btnQty.className = 'mode-btn px-3 py-1 rounded-md transition font-medium text-slate-600 hover:text-slate-900 cursor-pointer';
        btnVal.className = 'mode-btn px-3 py-1 rounded-md transition font-semibold text-emerald-700 bg-white shadow-xs cursor-pointer';
      }
    }

    updateAllViews();
  };

  window.onDateRangeChange = function () {
    const fromEl = document.getElementById('filterDateFrom');
    const toEl = document.getElementById('filterDateTo');
    filterDateFrom = fromEl ? fromEl.value : '';
    filterDateTo = toEl ? toEl.value : '';
    activePreset = 'custom';
    updateBadgeLabel();
    updateAllViews();
  };

  window.clearDateRange = function () {
    const fromEl = document.getElementById('filterDateFrom');
    const toEl = document.getElementById('filterDateTo');
    if (fromEl) fromEl.value = '';
    if (toEl) toEl.value = '';
    filterDateFrom = '';
    filterDateTo = '';
    activePreset = 'all';
    updateBadgeLabel();
    updateAllViews();
  };

  window.applyPreset = function (preset) {
    activePreset = preset;
    const now = new Date();
    const fromEl = document.getElementById('filterDateFrom');
    const toEl = document.getElementById('filterDateTo');

    if (preset === 'today') {
      const todayStr = formatDateIso(now);
      filterDateFrom = todayStr;
      filterDateTo = todayStr;
    } else if (preset === 'this_week') {
      const day = now.getDay();
      const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Monday
      const monday = new Date(now.setDate(diff));
      filterDateFrom = formatDateIso(monday);
      filterDateTo = formatDateIso(new Date());
    } else if (preset === 'this_month') {
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      filterDateFrom = formatDateIso(firstDay);
      filterDateTo = formatDateIso(new Date());
    } else if (preset === 'last_90_days') {
      const past90 = new Date();
      past90.setDate(past90.getDate() - 90);
      filterDateFrom = formatDateIso(past90);
      filterDateTo = formatDateIso(new Date());
    } else if (preset === 'this_year') {
      const firstOfYear = new Date(now.getFullYear(), 0, 1);
      filterDateFrom = formatDateIso(firstOfYear);
      filterDateTo = formatDateIso(new Date());
    } else {
      // 'all'
      filterDateFrom = '';
      filterDateTo = '';
    }

    if (fromEl) fromEl.value = filterDateFrom;
    if (toEl) toEl.value = filterDateTo;

    updateBadgeLabel();
    updateAllViews();
  };

  function updateBadgeLabel() {
    const badge = document.getElementById('activeRangeBadge');
    if (!badge) return;
    if (!filterDateFrom && !filterDateTo) {
      badge.innerText = 'Showing: All Time Records';
    } else if (filterDateFrom && filterDateTo && filterDateFrom === filterDateTo) {
      badge.innerText = `Showing: Single Date (${filterDateFrom})`;
    } else {
      badge.innerText = `Showing: ${filterDateFrom || 'Start'} to ${filterDateTo || 'Now'}`;
    }
  }

  window.onTableSearchChange = function () {
    const input = document.getElementById('tableSearchInput');
    searchQuery = input ? input.value : '';
    renderTransactionTable();
  };

  window.onTableFilterChange = function () {
    renderTransactionTable();
  };

  window.onTableSortChange = function () {
    const select = document.getElementById('tableSortSelect');
    if (!select) return;
    const val = select.value;
    if (val === 'date_desc') {
      currentSortColumn = 'date';
      currentSortDirection = 'desc';
    } else if (val === 'date_asc') {
      currentSortColumn = 'date';
      currentSortDirection = 'asc';
    } else if (val === 'type_added') {
      currentSortColumn = 'type';
      currentSortDirection = 'asc';
    } else if (val === 'type_released') {
      currentSortColumn = 'type';
      currentSortDirection = 'desc';
    } else if (val === 'qty_desc') {
      currentSortColumn = 'quantity';
      currentSortDirection = 'desc';
    } else if (val === 'qty_asc') {
      currentSortColumn = 'quantity';
      currentSortDirection = 'asc';
    } else if (val === 'value_desc') {
      currentSortColumn = 'value';
      currentSortDirection = 'desc';
    } else if (val === 'name_asc') {
      currentSortColumn = 'name';
      currentSortDirection = 'asc';
    }
    updateSortIcons();
    renderTransactionTable();
  };

  window.sortTableByColumn = function (col) {
    if (currentSortColumn === col) {
      currentSortDirection = currentSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      currentSortColumn = col;
      currentSortDirection = (col === 'name' || col === 'type') ? 'asc' : 'desc';
    }
    updateSortIcons();
    renderTransactionTable();
  };

  window.renderTransactionTable = renderTransactionTable;

  function updateAllViews() {
    updateKpiCards();
    const { filteredAdditions, filteredReleases } = getFilteredTransactions();
    renderMainTrendsChart(filteredAdditions, filteredReleases);
    renderDistributionChart();
    renderTopItemsChart(filteredReleases);
    renderTransactionTable();
  }

  // ── Live Backend Synchronization & Interactive Refresh ───────────────────
  window.refreshMonitorData = async function () {
    const btn = document.getElementById('btnRefreshData');
    const icon = document.getElementById('refreshIcon');
    const btnText = document.getElementById('refreshBtnText');
    const timeEl = document.getElementById('lastUpdatedTime');

    if (btn) btn.disabled = true;
    if (icon) {
      icon.className = 'fa-solid fa-rotate text-sky-600 fa-spin';
    }
    if (btnText) btnText.innerText = 'Refreshing...';

    try {
      const res = await fetch('/api/items?_t=' + Date.now());
      if (!res.ok) throw new Error('Network response failed: ' + res.status);
      const data = await res.json();
      rawInventoryItems = Array.isArray(data.items) ? data.items : [];

      const now = new Date();
      if (timeEl) {
        timeEl.innerText = `Updated at ${now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      }

      updateAllViews();
      updateSortIcons();

      if (btnText) btnText.innerText = 'Refreshed!';
      if (icon) {
        icon.className = 'fa-solid fa-check text-emerald-600';
      }
      setTimeout(() => {
        if (btnText) btnText.innerText = 'Refresh';
        if (icon) icon.className = 'fa-solid fa-rotate text-sky-600 transition-transform';
        if (btn) btn.disabled = false;
      }, 800);
    } catch (err) {
      console.error('Failed to load inventory monitor data:', err);
      if (btnText) btnText.innerText = 'Retry';
      if (timeEl) timeEl.innerText = 'Refresh failed (click retry)';
      if (icon) {
        icon.className = 'fa-solid fa-triangle-exclamation text-amber-500';
      }
      if (btn) btn.disabled = false;
      setTimeout(() => {
        if (btnText && btnText.innerText === 'Retry') {
          btnText.innerText = 'Refresh';
          if (icon) icon.className = 'fa-solid fa-rotate text-sky-600';
        }
      }, 3000);
    }
  };

  // ── SSE Live Updates (Sync with Dashboard changes in real-time) ───────────
  function initLiveUpdates() {
    if (!window.EventSource) return;
    const es = new EventSource('/api/events');
    es.addEventListener('inventory-updated', () => {
      console.log('Live inventory update event received in Monitor panel.');
      window.refreshMonitorData();
    });
    es.onerror = () => {
      console.warn('Live events connection retry in Monitor panel.');
    };
  }

  // Initialize
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('btnRefreshData');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        window.refreshMonitorData();
      });
    }
    updateSortIcons();
    window.refreshMonitorData();
    initLiveUpdates();
  });

})();

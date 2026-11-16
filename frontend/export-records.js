/**
 * Export Records Engine
 * DICT-NBP Inventory & Management Suite
 * 
 * Provides complete PDF and Excel report generation with date range filtering,
 * scope selection, real-time summary statistics, and an export history log.
 */

'use strict';

// ── Global State ─────────────────────────────────────────────────────────────
let items = [];
let totalSalesRevenue = 0;
let cachedLogoImg = null;
// ── Helpers ──────────────────────────────────────────────────────────────────
function formatMoney(n) {
  return 'PHP ' + Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatPdfDateTime(value) {
  if (!value || Number.isNaN(new Date(value).getTime())) return '-';
  const date = new Date(value);
  const day = date.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
  const time = date.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${day}\n${time}`;
}

function formatPdfReleaseDateTime(release) {
  if (!release?.date) return '-';
  const timestamp = release.releasedAt || release.createdAt;
  return timestamp && !Number.isNaN(new Date(timestamp).getTime())
    ? formatPdfDateTime(timestamp)
    : formatDate(release.date);
}

function formatReleaseDateTime(release) {
  if (!release?.date) return '-';
  const timestamp = release.releasedAt || release.createdAt;
  if (!timestamp || Number.isNaN(new Date(timestamp).getTime())) return formatDate(release.date);
  const time = new Date(timestamp).toLocaleTimeString('en-PH', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
  return `${formatDate(release.date)}, ${time}`;
}

function pdfText(value) {
  return String(value ?? '-')
    .replace(/[\u20B1]|&#8369;/g, 'PHP ')
    .replace(/[\u2192\u2794\u279C]/g, 'to')
    .replace(/[\u2014\u2013]/g, '-')
    .replace(/[^\x20-\x7E\n]/g, '?');
}

function loadLogoImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { cachedLogoImg = img; resolve(img); };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// ── Release and Value Calculations ───────────────────────────────────────────
function getReleaseHistory(item) {
  if (Array.isArray(item.releaseHistory) && item.releaseHistory.length > 0) {
    return item.releaseHistory;
  }
  if ((item.soldQuantity || 0) > 0) {
    return [{
      id: 'prior-release',
      quantity: item.soldQuantity,
      date: item.releaseDate || '',
      remarks: item.remarks || '',
      createdAt: null
    }];
  }
  return [];
}

function getCanonicalReleaseId(release) {
  return typeof release.id === 'string' ? release.id.replace(/-p$/, '') : '';
}

function dedupeReleaseHistory(releases) {
  const seen = new Set();
  return releases.filter(release => {
    const id = getCanonicalReleaseId(release);
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function isSubItemRelease(release, sub) {
  const normalizedSubName = String(sub.name || '').trim().toLocaleLowerCase();
  const recordedSubName = String(release.subItemName || '').trim().toLocaleLowerCase();
  return release.subItemId === sub.id ||
    (normalizedSubName !== '' && recordedSubName === normalizedSubName) ||
    (typeof release.remarks === 'string' && release.remarks.startsWith(`[Sub-item: ${sub.name}]`));
}

function getMainItemReleaseHistory(item) {
  const releaseHistory = Array.isArray(item.releaseHistory) ? item.releaseHistory : [];
  if (releaseHistory.length) {
    const mainHistory = dedupeReleaseHistory(releaseHistory.filter(release =>
      !release.subItemId &&
      !(item.subItems || []).some(sub => isSubItemRelease(release, sub))
    ));
    if (mainHistory.length) return mainHistory;
    return [];
  }
  if (Array.isArray(item.subItems) && item.subItems.length) return [];
  return getReleaseHistory(item);
}

function getReleasedQuantity(releases) {
  return releases.reduce((total, release) => total + (Number(release.quantity) || 0), 0);
}

function getMainItemReleasedQuantity(item) {
  return getReleasedQuantity(getMainItemReleaseHistory(item));
}

function getSubItemReleaseHistory(item, sub) {
  const history = dedupeReleaseHistory(Array.isArray(sub.releaseHistory) ? sub.releaseHistory : []);
  const allParentHistory = Array.isArray(item.releaseHistory) ? item.releaseHistory : [];
  const matchingParentHistory = dedupeReleaseHistory(
    allParentHistory.filter(release => isSubItemRelease(release, sub))
  );
  const parentHistory = matchingParentHistory.map(release => {
    const subRemarksPrefix = `[Sub-item: ${sub.name}]`;
    const remarks = typeof release.remarks === 'string' && release.remarks.startsWith(subRemarksPrefix)
      ? release.remarks.slice(subRemarksPrefix.length).trim()
      : release.remarks;
    return {
      ...release,
      id: release.id?.endsWith('-p') ? release.id.slice(0, -2) : release.id,
      remarks
    };
  });

  const latestHistoryQuantity = Number(history[0]?.quantity) || 0;
  const recordedSoldQuantity = Number(sub.soldQuantity) || 0;
  if (parentHistory.length && getReleasedQuantity(parentHistory) !== getReleasedQuantity(history)) {
    return parentHistory;
  }
  if (history.length && (latestHistoryQuantity > 0 || recordedSoldQuantity === 0)) return history;
  if (parentHistory.length) return parentHistory;

  if (recordedSoldQuantity > 0) {
    return [{
      id: `legacy-sub-release-${sub.id}`,
      quantity: recordedSoldQuantity,
      date: item.releaseDate || '',
      remarks: item.remarks || '',
      unitPrice: Number(sub.price) || 0
    }];
  }
  return [];
}

function getSubItemReleasedQuantity(item, sub) {
  return getReleasedQuantity(getSubItemReleaseHistory(item, sub));
}

function getItemReleasedQuantity(item) {
  if (!Array.isArray(item.subItems) || !item.subItems.length) {
    return getMainItemReleasedQuantity(item);
  }
  return getMainItemReleasedQuantity(item) + item.subItems.reduce((total, sub) =>
    total + getSubItemReleasedQuantity(item, sub), 0);
}

function getReleaseValue(releases, fallbackUnitPrice) {
  return releases.reduce((value, release) => {
    const quantity = Number(release.quantity) || 0;
    const unitPrice = Number(release.unitPrice ?? fallbackUnitPrice) || 0;
    return value + quantity * unitPrice;
  }, 0);
}

function getItemReleasedValue(item) {
  if (Array.isArray(item.subItems) && item.subItems.length) {
    const parentReleaseValue = getReleaseValue(getMainItemReleaseHistory(item), Number(item.price) || 0);
    const subItemReleaseValue = item.subItems.reduce((total, sub) =>
      total + getReleaseValue(getSubItemReleaseHistory(item, sub), Number(sub.price) || 0), 0);
    return parentReleaseValue + subItemReleaseValue;
  }
  return getReleaseValue(getReleaseHistory(item).filter(release => !release.subItemId), Number(item.price) || 0);
}

function getItemTotalQuantityValue(item) {
  if (Array.isArray(item.subItems) && item.subItems.length) {
    const subItemsValue = item.subItems.reduce((total, sub) =>
      total + ((Number(sub.quantity) || 0) + getSubItemReleasedQuantity(item, sub)) * (Number(sub.price) || 0), 0);
    if (subItemsValue > 0) return subItemsValue;
  }
  return ((Number(item.quantity) || 0) + getMainItemReleasedQuantity(item)) * (Number(item.price) || 0);
}

function getLatestRelease(item) {
  const releases = Array.isArray(item.subItems) && item.subItems.length
    ? getMainItemReleaseHistory(item)
    : getReleaseHistory(item);
  return releases[0] || null;
}

function _getReleasedSerialsForItem(releaseHistory) {
  const released = new Set();
  (releaseHistory || []).forEach(r => (r.releasedSerials || []).forEach(s => released.add(s.trim())));
  return released;
}

function _getSerialExportMeta(serialNumber, releaseHistory) {
  if (!serialNumber || !serialNumber.trim()) {
    return { text: '-', lines: [], hasDeducted: false, allDeducted: false };
  }
  const releasedSet = _getReleasedSerialsForItem(releaseHistory);
  const rawParts = serialNumber.split('\n').map(s => s.trim()).filter(Boolean);
  if (!rawParts.length) {
    return { text: '-', lines: [], hasDeducted: false, allDeducted: false };
  }
  const lines = rawParts.map(s => ({
    text: s,
    isDeducted: releasedSet.has(s)
  }));
  const hasDeducted = lines.some(l => l.isDeducted);
  const allDeducted = lines.length > 0 && lines.every(l => l.isDeducted);
  return {
    text: rawParts.join(' / '),
    lines,
    hasDeducted,
    allDeducted
  };
}

function _getXlsSerialText(serialMeta) {
  if (!serialMeta || !serialMeta.lines || serialMeta.lines.length === 0) return '-';
  if (serialMeta.allDeducted || !serialMeta.hasDeducted) {
    return serialMeta.lines.map(l => l.text).join('\n');
  }
  return serialMeta.lines.map(l => l.isDeducted ? l.text.split('').map(c => c + '\u0336').join('') : l.text).join('\n');
}

function _getPdfSerialCell(serialMeta) {
  const content = serialMeta.lines.map(line => pdfText(line.text)).join('\n') || '-';
  return serialMeta.hasDeducted ? { content, serialMeta } : content;
}

// Keep deduction flags alongside wrapped lines. AutoTable shares the raw cell
// when a row continues on another page, so each fragment consumes its own lines.
function _getPdfSerialHooks(doc) {
  const renderedLines = new WeakMap();
  return {
    didParseCell({ section, cell }) {
      const meta = cell.raw?.serialMeta;
      if (section !== 'body' || !meta?.hasDeducted) return;
      cell.styles.overflow = (_text, width) => {
        const lines = meta.lines.flatMap(line =>
          doc.splitTextToSize(pdfText(line.text), width + 1 / doc.internal.scaleFactor)
            .map(text => ({ text, isDeducted: line.isDeducted }))
        );
        renderedLines.set(cell.raw, { lines, offset: 0 });
        return lines.map(line => line.text);
      };
    },
    didDrawCell({ section, cell }) {
      const state = section === 'body' && renderedLines.get(cell.raw);
      if (!state) return;
      const fontHeight = cell.styles.fontSize / doc.internal.scaleFactor;
      const lineHeight = fontHeight * doc.getLineHeightFactor();
      const { x, y } = cell.getTextPos();
      // AutoTable's text position is an alignment anchor. Its text renderer
      // shifts multiline text upward for middle/bottom alignment before drawing.
      const textHeight = cell.text.length * lineHeight;
      const verticalOffset = cell.styles.valign === 'middle' ? textHeight / 2
        : cell.styles.valign === 'bottom' ? textHeight : 0;
      doc.saveGraphicsState();
      doc.setDrawColor(220, 38, 38);
      doc.setLineWidth(0.2);
      cell.text.forEach((text, index) => {
        if (!state.lines[state.offset + index]?.isDeducted) return;
        const width = doc.getTextWidth(text);
        const left = cell.styles.halign === 'center' ? x - width / 2
          : cell.styles.halign === 'right' ? x - width : x;
        const lineY = y - verticalOffset + fontHeight * 0.55 + index * lineHeight;
        doc.line(left, lineY, left + width, lineY);
      });
      doc.restoreGraphicsState();
      state.offset += cell.text.length;
    }
  };
}

function _styleXlsDeductedSerial(cell, meta) {
  if (!meta?.hasDeducted) return;
  cell.s.font = { ...cell.s.font, bold: true, color: { rgb: 'DC2626' }, strike: meta.allDeducted };
  cell.s.fill = { patternType: 'solid', fgColor: { rgb: meta.allDeducted ? 'FEE2E2' : 'FEF2F2' } };
}

function getReleasedItemSerialText(target, releaseHistory, dateFromVal, dateToVal) {
  const hasDateFilter = Boolean(dateFromVal || dateToVal);
  const serials = [];
  (releaseHistory || []).forEach(r => {
    if (hasDateFilter && !releaseMatchesExportDateRange(r, dateFromVal, dateToVal)) {
      return;
    }
    if (Array.isArray(r.releasedSerials)) {
      r.releasedSerials.forEach(s => {
        if (s && String(s).trim()) serials.push(String(s).trim());
      });
    } else if (typeof r.releasedSerials === 'string' && r.releasedSerials.trim()) {
      serials.push(r.releasedSerials.trim());
    }
  });

  const unique = [...new Set(serials)];
  if (unique.length > 0) {
    return unique.join('\n');
  }

  // When no serial numbers were recorded as released, return '-'
  // (Do not dump unreleased inventory serial numbers)
  return '-';
}

// ── Date Range Matching ──────────────────────────────────────────────────────
function isDateWithinRange(dateVal, fromStr, toStr) {
  if (!fromStr && !toStr) return true;
  if (!dateVal) return false;
  const d = dateVal instanceof Date
    ? dateVal
    : /^\d{4}-\d{2}-\d{2}$/.test(String(dateVal))
      ? (() => {
        const [year, month, day] = String(dateVal).split('-').map(Number);
        return new Date(year, month - 1, day);
      })()
      : new Date(dateVal);
  const time = d.getTime();
  if (Number.isNaN(time)) return false;

  if (fromStr) {
    const [fy, fm, fd] = fromStr.split('-').map(Number);
    const fromTime = new Date(fy, fm - 1, fd, 0, 0, 0, 0).getTime();
    if (time < fromTime) return false;
  }
  if (toStr) {
    const [ty, tm, td] = toStr.split('-').map(Number);
    const toTime = new Date(ty, tm - 1, td, 23, 59, 59, 999).getTime();
    if (time > toTime) return false;
  }
  return true;
}

function releaseMatchesExportDateRange(release, fromStr, toStr) {
  return isDateWithinRange(
    release.date || release.releasedAt || release.createdAt,
    fromStr,
    toStr
  );
}

function itemMatchesExportDateRange(item, fromStr, toStr) {
  if (!fromStr && !toStr) return true;

  const createdMatches = isDateWithinRange(item.createdAt, fromStr, toStr);
  const legacyReleaseMatches = Boolean(item.releaseDate && isDateWithinRange(item.releaseDate, fromStr, toStr));
  const hasReleaseMatches = () => {
    if (legacyReleaseMatches) return true;
    const parentReleases = getReleaseHistory(item);
    if (parentReleases.some(release => releaseMatchesExportDateRange(release, fromStr, toStr))) {
      return true;
    }
    if (Array.isArray(item.subItems)) {
      for (const sub of item.subItems) {
        const subReleases = getSubItemReleaseHistory(item, sub);
        if (subReleases.some(release => releaseMatchesExportDateRange(release, fromStr, toStr))) {
          return true;
        }
      }
    }
    return false;
  };

  return createdMatches || hasReleaseMatches();
}

function isExportRangeValid(fromStr, toStr) {
  return !fromStr || !toStr || fromStr <= toStr;
}

function getExportItems(list, fromStr, toStr, scope = 'full') {
  if (!isExportRangeValid(fromStr, toStr)) return [];
  const releasedOnly = scope === 'travel_released';
  const hasRange = Boolean(fromStr || toStr);
  const matchingReleases = history => history.filter(release =>
    Number(release.quantity) > 0 && releaseMatchesExportDateRange(release, fromStr, toStr)
  );

  return InventoryOrder.oldestFirst(list).filter(item =>
    releasedOnly || itemMatchesExportDateRange(item, fromStr, toStr)
  ).map(item => {
    if (scope === 'full' || (!hasRange && !releasedOnly)) return item;
    // Report-only copies: never trim the stored inventory or release history.
    const mainHistory = matchingReleases(getMainItemReleaseHistory(item));
    const subItems = (item.subItems || []).map(sub => {
      const history = matchingReleases(getSubItemReleaseHistory(item, sub));
      return {
        ...sub, releaseHistory: history, soldQuantity: getReleasedQuantity(history),
        // Print All serial status uses the complete history, even with a date range.
        _serialExportMeta: _getSerialExportMeta(sub.serialNumber, getSubItemReleaseHistory(item, sub))
      };
    }).filter(sub => !releasedOnly || sub.soldQuantity > 0);
    const history = [
      ...mainHistory,
      ...subItems.flatMap(sub => sub.releaseHistory.map(release => ({
        ...release,
        subItemId: sub.id,
        subItemName: sub.name,
        remarks: `[Sub-item: ${sub.name}]${release.remarks ? ` ${release.remarks}` : ''}`
      })))
    ];
    return {
      ...item,
      _serialExportMeta: _getSerialExportMeta(item.serialNumber, getMainItemReleaseHistory(item)),
      subItems,
      releaseHistory: history,
      soldQuantity: getReleasedQuantity(history),
      releaseDate: history[0]?.date || '',
      remarks: history[0]?.remarks || ''
    };
  }).filter(item => !releasedOnly || getItemReleasedQuantity(item) > 0);
}

function setExportDatePreset(preset) {
  const fromInput = document.getElementById('exportDateFrom');
  const toInput = document.getElementById('exportDateTo');
  if (!fromInput || !toInput) return;

  const now = new Date();
  const formatDateInput = (d) => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  if (preset === 'today') {
    const todayStr = formatDateInput(now);
    fromInput.value = todayStr;
    toInput.value = todayStr;
  } else if (preset === 'this_week') {
    const d = new Date(now);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(d.setDate(diff));
    fromInput.value = formatDateInput(monday);
    toInput.value = formatDateInput(now);
  } else if (preset === 'this_month') {
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    fromInput.value = formatDateInput(firstDay);
    toInput.value = formatDateInput(now);
  } else if (preset === 'this_year') {
    const firstDay = new Date(now.getFullYear(), 0, 1);
    fromInput.value = formatDateInput(firstDay);
    toInput.value = formatDateInput(now);
  }
  updateExportRangeBadge();
}

function clearExportDateRange() {
  const fromInput = document.getElementById('exportDateFrom');
  const toInput = document.getElementById('exportDateTo');
  if (fromInput) fromInput.value = '';
  if (toInput) toInput.value = '';
  updateExportRangeBadge();
}

function updateExportRangeBadge() {
  const fromInput = document.getElementById('exportDateFrom');
  const toInput = document.getElementById('exportDateTo');
  const badge = document.getElementById('exportRangeBadge');
  const from = fromInput?.value || '';
  const to = toInput?.value || '';
  const isActive = Boolean(from || to);
  const valid = isExportRangeValid(from, to);
  const error = document.getElementById('exportRangeError');
  const help = document.getElementById('exportScopeHelp');
  if (badge) badge.classList.toggle('hidden', !isActive || !valid);
  if (error) error.classList.toggle('hidden', valid);
  if (help) help.textContent = document.getElementById('exportContentScope')?.value === 'travel_released'
    ? 'Date range filters release dates, quantities, and released serial numbers.'
    : document.getElementById('exportContentScope')?.value === 'travel'
      ? 'Includes items added or released within the selected dates; receipt quantities show current remaining stock.'
      : 'Includes items added or released within the selected dates. Stock columns show current inventory.';
  ['btnExportPDF', 'btnExportExcel'].forEach(id => {
    const button = document.getElementById(id);
    if (button) button.disabled = !valid;
  });
  renderSummaryCards();
  renderPreviewTable();
}

// ── UI Feedback ──────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  const icon = document.getElementById('toastIcon');
  const msg = document.getElementById('toastMessage');
  if (!toast) return;

  clearTimeout(toastTimer);
  if (icon) {
    icon.className = isError
      ? 'fa-solid fa-triangle-exclamation text-rose-400'
      : 'fa-solid fa-circle-check text-emerald-400';
  }
  if (msg) msg.textContent = message;

  toast.classList.remove('opacity-0', 'translate-y-20', 'pointer-events-none');
  toast.classList.add('opacity-100', 'translate-y-0');

  toastTimer = setTimeout(() => {
    toast.classList.remove('opacity-100', 'translate-y-0');
    toast.classList.add('opacity-0', 'translate-y-20', 'pointer-events-none');
  }, 3500);
}



// ── Summary Cards Rendering ──────────────────────────────────────────────────
function renderSummaryCards() {
  const container = document.getElementById('exportSummaryCards');
  if (!container) return;

  const dateFromVal = document.getElementById('exportDateFrom')?.value || '';
  const dateToVal = document.getElementById('exportDateTo')?.value || '';
  const scopeVal = document.getElementById('exportContentScope')?.value || 'full';
  const hasDateFilter = Boolean(dateFromVal || dateToVal);

  const filtered = getExportItems(items, dateFromVal, dateToVal, scopeVal);
  let totalSoldQty = 0;
  let effectiveSales = 0;
  filtered.forEach(item => {
    const addReleases = (history, price) => {
      const matching = history.filter(release => releaseMatchesExportDateRange(release, dateFromVal, dateToVal));
      totalSoldQty += getReleasedQuantity(matching);
      effectiveSales += getReleaseValue(matching, price);
    };
    addReleases(getMainItemReleaseHistory(item), item.price);
    (item.subItems || []).forEach(sub => addReleases(getSubItemReleaseHistory(item, sub), sub.price));
  });

  container.innerHTML = `
    <div class="er-summary-card">
      <span class="er-summary-card-label">Matching Items</span>
      <span class="er-summary-card-value text-slate-800">${filtered.length.toLocaleString('en-US')}</span>
      <span class="er-summary-card-sub">of ${items.length.toLocaleString('en-US')} total</span>
    </div>
    <div class="er-summary-card">
      <span class="er-summary-card-label">Released Qty${hasDateFilter ? ' (In Range)' : ''}</span>
      <span class="er-summary-card-value text-indigo-600">${totalSoldQty.toLocaleString('en-US')}</span>
      <span class="er-summary-card-sub">transacted units</span>
    </div>
    <div class="er-summary-card">
      <span class="er-summary-card-label">Released Value${hasDateFilter ? ' (In Range)' : ''}</span>
      <span class="er-summary-card-value text-emerald-600">${formatMoney(effectiveSales)}</span>
      <span class="er-summary-card-sub">disbursed total</span>
    </div>
  `;
}

// ── Backend Synchronization ──────────────────────────────────────────────────
async function loadExportData(forceRefresh = false) {
  const badge = document.getElementById('dataStatusBadge');
  const badgeText = document.getElementById('dataStatusText');
  const btn = document.getElementById('btnRefreshData');
  const icon = document.getElementById('refreshIcon');
  const btnText = document.getElementById('refreshBtnText');

  if (btn) btn.disabled = true;
  if (icon) icon.className = 'fa-solid fa-rotate text-brand-500 fa-spin';
  if (btnText) btnText.innerText = 'Refreshing...';
  if (badgeText) badgeText.innerText = 'Fetching latest data...';

  try {
    const res = await fetch('/api/items?_t=' + Date.now());
    if (!res.ok) throw new Error('Server returned ' + res.status);
    const data = await res.json();
    items = InventoryOrder.oldestFirst(data.items);
    totalSalesRevenue = Number(data.totalSalesRevenue) || 0;

    if (badge) {
      badge.className = 'inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-700';
    }
    if (badgeText) {
      badgeText.innerHTML = `<i class="fa-solid fa-circle-check text-emerald-500"></i> ${items.length} items synced`;
    }

    renderSummaryCards();
    renderPreviewTable();
    if (forceRefresh) showToast('Inventory data refreshed successfully.');
  } catch (err) {
    console.error('Failed to load inventory data:', err);
    if (badge) {
      badge.className = 'inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-700';
    }
    if (badgeText) badgeText.innerText = 'Failed to load data (retrying...)';
    showToast('Failed to load inventory data from server.', true);
  } finally {
    if (btn) btn.disabled = false;
    if (icon) icon.className = 'fa-solid fa-rotate text-brand-500';
    if (btnText) btnText.innerText = 'Refresh Data';
  }
}

// ── PDF Export Function ──────────────────────────────────────────────────────
async function exportToPDF() {
  if (items.length === 0) {
    showToast('No items available to export.', true);
    return;
  }

  if (!window.jspdf || !window.jspdf.jsPDF) {
    showToast('PDF library loading... please try again in a moment.', true);
    return;
  }

  const dateFromVal = document.getElementById('exportDateFrom')?.value || '';
  const dateToVal = document.getElementById('exportDateTo')?.value || '';
  const scopeVal = document.getElementById('exportContentScope')?.value || 'full';
  const isTravelExport = scopeVal === 'travel' || scopeVal === 'travel_released';
  const isReleasedOnly = scopeVal === 'travel_released';
  const hasDateFilter = Boolean(dateFromVal || dateToVal);

  if (!isExportRangeValid(dateFromVal, dateToVal)) {
    showToast('From date must be on or before To date.', true);
    return;
  }
  const sortedItems = getExportItems(items, dateFromVal, dateToVal, scopeVal);
  if (!sortedItems.length) {
    showToast(isReleasedOnly ? 'No releases match the selected date range.' : 'No items match the selected export date range.', true);
    return;
  }

  let dateRangeLabel = '';
  const isSameDayRange = Boolean(dateFromVal && dateToVal && dateFromVal === dateToVal);
  if (isSameDayRange) {
    dateRangeLabel = `Date: ${formatDate(dateFromVal)}`;
  } else if (dateFromVal && dateToVal) {
    dateRangeLabel = `Period: ${formatDate(dateFromVal)} - ${formatDate(dateToVal)}`;
  } else if (dateFromVal && !dateToVal) {
    dateRangeLabel = `Period: From ${formatDate(dateFromVal)}`;
  } else if (!dateFromVal && dateToVal) {
    dateRangeLabel = `Period: Up to ${formatDate(dateToVal)}`;
  }

  const { jsPDF } = window.jspdf;
  const logoImg = cachedLogoImg || await loadLogoImage('logo/dict-main-logo.png');
  const formatPdfMoney = (val) => 'PHP ' + Number(val || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fileDateSuffix = (dateFromVal && dateToVal && !isSameDayRange)
    ? `${dateFromVal}_to_${dateToVal}`
    : (dateFromVal || dateToVal || new Date().toISOString().slice(0, 10));

  // ══════════════════════════════════════════════════════════════════════════
  // ACKNOWLEDGEMENT RECEIPT — Portrait A4
  // ══════════════════════════════════════════════════════════════════════════
  if (isTravelExport) {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    // Portrait A4: 210 × 297 mm
    const PW = 210;
    const PH = 297;
    const ML = 15; // left margin
    const MR = 15; // right margin
    const TW = PW - ML - MR; // table width
    const FOOTER_Y = PH - 25;
    // The reference footer is inset further than the item table.
    const FOOTER_LEFT = 44;
    const FOOTER_RIGHT = PW - 32;

    // ── Header / Footer helpers ──────────────────────────────────────────────
    function drawAckHeader(d) {
      if (logoImg) {
        try {
          const logoNativeW = 795, logoNativeH = 144;
          const lw = TW;
          const lh = lw * (logoNativeH / logoNativeW);
          d.addImage(logoImg, 'PNG', ML, 8, lw, lh);
        } catch (e) { console.warn('logo error', e); }
      }
    }

    function drawAckFooter(d, pageNum, totalPages) {
      // Inset blue rule and two address/contact columns, as on the receipt template.
      const lineY = FOOTER_Y - 3;
      d.setDrawColor(120, 155, 215);
      d.setLineWidth(0.25);
      d.line(FOOTER_LEFT, lineY, FOOTER_RIGHT, lineY);

      d.setTextColor(48, 85, 150);

      // Line 1: Normal font weight
      d.setFont(undefined, 'normal');
      d.setFontSize(7.5);
      d.text('DICT Regional Office 1', FOOTER_LEFT, FOOTER_Y);
      d.text('https://www.dict.gov.ph', FOOTER_RIGHT, FOOTER_Y, { align: 'right' });

      // Line 2
      d.text('3F Kenny Plaza Bldg., M.L. Quezon Ave.,', FOOTER_LEFT, FOOTER_Y + 3.6);
      d.text('region1@dict.gov.ph', FOOTER_RIGHT, FOOTER_Y + 3.6, { align: 'right' });

      // Line 3
      d.text('San Fernando City, La Union 2500', FOOTER_LEFT, FOOTER_Y + 7.2);

      // Right-align the complete caption, including the final page count.
      const line4Y = FOOTER_Y + 10.8;
      d.setFont(undefined, 'italic');
      const caption = 'Acknowledgement Receipt';
      const captionW = d.getTextWidth(caption);
      d.setFont(undefined, 'normal');
      const separator = '  |  ';
      const separatorW = d.getTextWidth(separator);
      d.setFont(undefined, 'italic');
      const pageW = d.getTextWidth('Page ');
      d.setFont(undefined, 'bold');
      const count = `${pageNum} of ${totalPages}`;
      const countW = d.getTextWidth(count);
      const captionX = FOOTER_RIGHT - captionW - separatorW - pageW - countW;
      d.setFont(undefined, 'italic');
      d.text(caption, captionX, line4Y);
      d.setFont(undefined, 'normal');
      d.text(separator, captionX + captionW, line4Y);
      d.setFont(undefined, 'italic');
      d.text('Page ', FOOTER_RIGHT - pageW - countW, line4Y);
      d.setFont(undefined, 'bold');
      d.text(count, FOOTER_RIGHT - countW, line4Y);
    }

    // Logo height
    const logoNativeW = 795, logoNativeH = 144;
    const logoH = TW * (logoNativeH / logoNativeW);
    const CONTENT_TOP = 8 + logoH + 5; // y just below logo

    // ── Draw header on page 1 ────────────────────────────────────────────────
    drawAckHeader(doc);

    // Thin separator line below header
    doc.setDrawColor(30, 64, 175);
    doc.setLineWidth(0.4);
    doc.line(ML, CONTENT_TOP - 1, ML + TW, CONTENT_TOP - 1);

    // ── Title ────────────────────────────────────────────────────────────────
    doc.setFontSize(11);
    doc.setFont(undefined, 'bold');
    doc.setTextColor(15, 23, 42);
    doc.text('ACKNOWLEDGEMENT RECIEPT', ML, CONTENT_TOP + 7);

    // ── Date blank ───────────────────────────────────────────────────────────
    doc.setFontSize(10);
    doc.setFont(undefined, 'normal');
    const dateLabel = 'Date:';
    doc.text(dateLabel, ML, CONTENT_TOP + 15);
    const dateLabelW = doc.getTextWidth(dateLabel);
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.3);
    doc.line(ML + dateLabelW + 1.5, CONTENT_TOP + 15, ML + 75, CONTENT_TOP + 15);

    // ── Acknowledgement body text ─────────────────────────────────────────────
    const bodyY = CONTENT_TOP + 23;
    doc.setFontSize(10);
    doc.setFont(undefined, 'normal');
    doc.setTextColor(15, 23, 42);

    // "I, ___________, hereby acknowledge..."
    const ackLine1 = 'I,';
    doc.text(ackLine1, ML, bodyY);
    const ackLine1W = doc.getTextWidth(ackLine1);
    const iBlankStart = ML + ackLine1W + 1.5;
    const iBlankEnd = ML + 95;
    doc.line(iBlankStart, bodyY, iBlankEnd, bodyY);
    doc.text(', hereby acknowledge the receipt of the', iBlankEnd + 0.8, bodyY);

    doc.text('following Materials/items from the department of the information and communications', ML, bodyY + 6);
    const techLine = 'Technology on this day,';
    doc.text(techLine, ML, bodyY + 12);
    const techLineW = doc.getTextWidth(techLine);
    const dayBlankStart = ML + techLineW + 1.5;
    const dayBlankEnd = dayBlankStart + 42;
    doc.line(dayBlankStart, bodyY + 12, dayBlankEnd, bodyY + 12);
    doc.text(':', dayBlankEnd + 0.8, bodyY + 12);

    const TABLE_TOP = bodyY + 18;

    // ── Build table rows ──────────────────────────────────────────────────────
    const ackRows = [];
    let rowNum = 0;
    let totalReleasedQty = 0;
    let totalReleasedValue = 0;

    sortedItems.forEach((item, itemIndex) => {
      const hasSubs = Array.isArray(item.subItems) && item.subItems.length > 0;
      const itemReleasedQty = getItemReleasedQuantity(item);
      const serialMeta = item._serialExportMeta || _getSerialExportMeta(item.serialNumber, getMainItemReleaseHistory(item));
      const remarks = isReleasedOnly ? pdfText(item.inventoryRemarks || item.remarks || (getLatestRelease(item)?.remarks || '')) : '';

      if (!hasSubs) {
        if (isReleasedOnly && itemReleasedQty <= 0) return;
        rowNum++;
        totalReleasedQty += itemReleasedQty;
        totalReleasedValue += getItemReleasedValue(item);
        const dispSerial = isReleasedOnly
          ? pdfText(getReleasedItemSerialText(item, getReleaseHistory(item), dateFromVal, dateToVal))
          : _getPdfSerialCell(serialMeta);
        ackRows.push([
          `${rowNum}.`,
          pdfText(item.name + (item.description ? '\n' + item.description : '')),
          isReleasedOnly ? String(itemReleasedQty) : String(Number(item.quantity) || 0),
          dispSerial,
          remarks
        ]);
      } else {
        const subItemsToProcess = isReleasedOnly
          ? item.subItems.filter(sub => getReleasedQuantity(getSubItemReleaseHistory(item, sub)) > 0)
          : item.subItems;

        if (isReleasedOnly && subItemsToProcess.length === 0) return;

        // Keep parent serials visible in Print All, alongside the sub-item rows.
        rowNum++;
        ackRows.push([
          `${rowNum}.`,
          pdfText(item.name + (item.description ? '\n' + item.description : '')),
          isReleasedOnly ? '' : String(Number(item.quantity) || 0),
          isReleasedOnly ? '-' : _getPdfSerialCell(serialMeta),
          remarks
        ]);
        // Sub-items
        subItemsToProcess.forEach((sub, subIdx) => {
          const subReleaseHistory = getSubItemReleaseHistory(item, sub);
          const subReleasedQty = getReleasedQuantity(subReleaseHistory);
          const subPrice = Number(sub.price) || 0;
          totalReleasedQty += subReleasedQty;
          totalReleasedValue += (subReleasedQty * subPrice);
          const subSerialMeta = sub._serialExportMeta || _getSerialExportMeta(sub.serialNumber, subReleaseHistory);
          const dispSubSerial = isReleasedOnly
            ? pdfText(getReleasedItemSerialText(sub, subReleaseHistory, dateFromVal, dateToVal))
            : _getPdfSerialCell(subSerialMeta);
          ackRows.push([
            `${rowNum}.${subIdx + 1}`,
            pdfText('>> ' + sub.name + (sub.description ? '\n' + sub.description : '')),
            isReleasedOnly ? String(subReleasedQty) : String(Number(sub.quantity) || 0),
            dispSubSerial,
            isReleasedOnly ? pdfText(sub.inventoryRemarks || sub.remarks || '') : ''
          ]);
        });
      }
    });

    if (isReleasedOnly && ackRows.length === 0) {
      showToast('No released items found to export in Acknowledgement Receipt.', true);
      return;
    }

    // ── autoTable ─────────────────────────────────────────────────────────────
    doc.autoTable({
      ..._getPdfSerialHooks(doc),
      head: [['Item No.', 'Description of Item', 'Quantity', 'Serial Number', 'Remarks']],
      body: ackRows,
      startY: TABLE_TOP,
      theme: 'grid',
      headStyles: {
        fillColor: [255, 255, 255],
        textColor: [0, 0, 0],
        fontStyle: 'bold',
        fontSize: 9,
        cellPadding: 2.5,
        halign: 'center',
        valign: 'middle',
        lineWidth: 0.3,
        lineColor: [0, 0, 0]
      },
      styles: {
        fontSize: 9,
        cellPadding: 2.5,
        halign: 'left',
        valign: 'top',
        overflow: 'linebreak',
        textColor: [0, 0, 0],
        lineWidth: 0.3,
        lineColor: [0, 0, 0],
        fillColor: [255, 255, 255]
      },
      alternateRowStyles: {
        fillColor: [255, 255, 255]
      },
      margin: { top: 52, left: ML, right: MR, bottom: 35 },
      tableWidth: TW,
      rowPageBreak: 'auto',
      columnStyles: {
        0: { cellWidth: 18, halign: 'center', fontStyle: 'bold' },
        1: { cellWidth: 70, halign: 'left' },
        2: { cellWidth: 20, halign: 'center' },
        3: { cellWidth: 47, halign: 'left', fontSize: 8 },
        4: { cellWidth: 25, halign: 'left' }
      },
      didDrawPage: function (data) {
        if (data.pageNumber > 1) {
          drawAckHeader(doc);
          // Separator line below header
          const sepY = 8 + logoH + 4;
          doc.setDrawColor(30, 64, 175);
          doc.setLineWidth(0.4);
          doc.line(ML, sepY, ML + TW, sepY);
        }
      }
    });

    // ── Responsibility Statement & Signatures Block ─────────────────────────
    // If the table has enough space below it, place the block on the same page.
    // Otherwise, push it to a new concluding page.
    const SIGNATURE_BLOCK_HEIGHT = 99; // statement plus Received By and Issued By fields
    const GAP_BELOW_TABLE = 8;
    const SAFE_BOTTOM = (FOOTER_Y - 3) - 6; // at least 6mm breathing room above footer divider line
    const tableFinalY = (doc.lastAutoTable && doc.lastAutoTable.finalY) ? doc.lastAutoTable.finalY : TABLE_TOP;

    let startY;
    if (tableFinalY + GAP_BELOW_TABLE + SIGNATURE_BLOCK_HEIGHT <= SAFE_BOTTOM) {
      // Enough space: place directly below the table on the current page
      startY = tableFinalY + GAP_BELOW_TABLE;
    } else {
      // Space is too small: create a new page with header
      doc.addPage();
      drawAckHeader(doc);
      const lastPageSepY = 8 + logoH + 4;
      doc.setDrawColor(30, 64, 175);
      doc.setLineWidth(0.4);
      doc.line(ML, lastPageSepY, ML + TW, lastPageSepY);
      startY = lastPageSepY + 14;
    }
    doc.setFontSize(10);
    doc.setFont(undefined, 'normal');
    doc.setTextColor(15, 23, 42);
    doc.text('These items have been received in good condition and will be used/stored/handled as agreed', ML, startY);
    doc.text('upon. I accept responsibility for the items listed above.', ML, startY + 5.5);

    function drawFormField(label, y) {
      doc.setFontSize(10);
      doc.setFont(undefined, 'normal');
      doc.setTextColor(15, 23, 42);
      doc.text(label, ML, y);
      const lw = doc.getTextWidth(label) + 1.5;
      doc.setDrawColor(0, 0, 0);
      doc.setLineWidth(0.35);
      doc.line(ML + lw, y + 0.5, ML + 115, y + 0.5);
    }

    ['Received By:', 'Issued By:'].forEach((heading, index) => {
      const signatureY = startY + 18 + index * 48;
      doc.setFontSize(10.5);
      doc.setFont(undefined, 'bold');
      doc.setTextColor(15, 23, 42);
      doc.text(heading, ML, signatureY);

      drawFormField('Name:', signatureY + 8);
      drawFormField('Signature:', signatureY + 16);
      drawFormField('Destination:', signatureY + 24);
      drawFormField('Contact No.:', signatureY + 32);
    });

    // ── Footers on all pages ──────────────────────────────────────────────────
    const totalPdfPages = doc.internal.getNumberOfPages();
    for (let p = 1; p <= totalPdfPages; p++) {
      doc.setPage(p);
      drawAckFooter(doc, p, totalPdfPages);
    }

    const ackFilename = isReleasedOnly
      ? `acknowledgement_receipt_released_${fileDateSuffix}.pdf`
      : `acknowledgement_receipt_${fileDateSuffix}.pdf`;
    doc.save(ackFilename);
    showToast(`Acknowledgement Receipt (${isReleasedOnly ? 'Released Items' : 'All Items'})${hasDateFilter ? ' filtered' : ''} PDF export generated.`);
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FULL INVENTORY SUMMARY — Landscape A4
  // ══════════════════════════════════════════════════════════════════════════
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

  // ── Header / Footer helper ────────────────────────────────────────────────
  const PAGE_W = 297; // A4 landscape width in mm
  const PAGE_H = 210; // A4 landscape height in mm
  const MARGIN_L = 7;
  const FOOTER_Y = PAGE_H - 8; // footer baseline
  const HEADER_W = 140;
  const HEADER_H = HEADER_W * (144 / 795);
  const HEADER_Y = 7;
  const CONTENT_START_Y = HEADER_Y + HEADER_H + 3;

  function drawPageHeader(pageDoc) {
    if (logoImg) {
      try {
        pageDoc.addImage(logoImg, 'PNG', (PAGE_W - HEADER_W) / 2, HEADER_Y, HEADER_W, HEADER_H);
      } catch (err) {
        console.warn('Could not render logo in PDF:', err);
      }
    }
  }

  function drawPageFooter(pageDoc, pageNum, totalPages) {
    pageDoc.setDrawColor(180, 180, 180);
    pageDoc.setLineWidth(0.25);
    pageDoc.line(MARGIN_L, FOOTER_Y - 4, PAGE_W - MARGIN_L, FOOTER_Y - 4);

    pageDoc.setFontSize(7.5);
    pageDoc.setFont(undefined, 'normal');
    pageDoc.setTextColor(100, 116, 139);

    const addrLeft = 'DICT Regional Office 1  |  3F Kenny Plaza Bldg., M.L. Quezon Ave., San Fernando City, La Union 2500';
    const addrRight = 'https://www.dict.gov.ph  |  region1@dict.gov.ph';
    pageDoc.text(addrLeft, MARGIN_L, FOOTER_Y);
    pageDoc.text(addrRight, PAGE_W - MARGIN_L, FOOTER_Y, { align: 'right' });

    pageDoc.setFont(undefined, 'bold');
    pageDoc.setTextColor(71, 85, 105);
    pageDoc.text(`Page ${pageNum} of ${totalPages}`, PAGE_W / 2, FOOTER_Y, { align: 'center' });
  }

  // Draw header on page 1
  drawPageHeader(doc);

  doc.setFontSize(15);
  doc.setTextColor(15, 23, 42);
  doc.setFont(undefined, 'bold');
  doc.text('Inventory & Stock Summary Report', PAGE_W / 2, CONTENT_START_Y + 5, { align: 'center' });

  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.setFont(undefined, 'normal');
  const subtitle = `Generated on: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}${dateRangeLabel ? `   |   ${dateRangeLabel}` : ''}`;
  doc.text(subtitle, PAGE_W / 2, CONTENT_START_Y + 11, { align: 'center' });

  const TABLE_START_Y = CONTENT_START_Y + 16;

  const tableColumn = ['#', 'Item & Description', 'Serial Number', 'Unit Type', 'Per Unit Price', 'Total Qty', 'Total Qty Value', 'Released Qty', 'Released Qty Value', 'Remaining In\nStock Qty', 'Remaining In\nStock Value', 'Date Released', 'Remarks'];
  const tableRows = [];
  const releaseHistoryRows = [];

  let totalQty = 0;
  let totalSoldQty = 0;
  let totalQtyValue = 0;
  let totalReleasedValue = 0;
  let grandTotal = 0;
  let totalReleaseValue = 0;
  let totalReleaseQty = 0;

  sortedItems.forEach((item, itemIndex) => {
    const hasSubs = Array.isArray(item.subItems) && item.subItems.length > 0;
    const subSum = hasSubs ? item.subItems.reduce((acc, s) => acc + ((Number(s.price) || 0) * (Number(s.quantity) || 0)), 0) : 0;
    const lineTotal = hasSubs ? (subSum > 0 ? subSum : (item.price * item.quantity)) : (item.price * item.quantity);
    const latestRelease = getLatestRelease(item);
    totalQtyValue += getItemTotalQuantityValue(item);
    totalReleasedValue += getItemReleasedValue(item);
    const itemReleasedQty = getItemReleasedQuantity(item);
    const pdfInStockQty = hasSubs
      ? item.subItems.reduce((s, sub) => s + (Number(sub.quantity) || 0), 0)
      : Number(item.quantity) || 0;
    const pdfTotalQty = hasSubs
      ? item.subItems.reduce((s, sub) => s + (Number(sub.quantity) || 0) + getReleasedQuantity(getSubItemReleaseHistory(item, sub)), 0)
      : pdfInStockQty + itemReleasedQty;
    if (!hasSubs) {
      totalQty += item.quantity;
      totalSoldQty += getMainItemReleasedQuantity(item);
    }
    grandTotal += lineTotal;

    const namePart = `Name: ${item.name}` + (hasSubs ? ` [${item.subItems.length} Sub-Items]` : '');
    const descPart = item.description ? `Desc: ${item.description}` : '';
    const addedPart = `Added: ${formatDate(item.createdAt)}`;
    const details = [namePart, descPart, addedPart].filter(Boolean).join('\n\n');
    const itemRowNumber = itemIndex + 1;
    const serialCellPdf = _getPdfSerialCell(_getSerialExportMeta(item.serialNumber, getReleaseHistory(item)));

    const fullItemData = [
      itemRowNumber,
      pdfText(details),
      serialCellPdf,
      pdfText(item.unitType || item.category || 'pcs'),
      hasSubs && subSum > 0 && Number(item.price) === 0 ? formatPdfMoney(subSum / (item.quantity || 1)) : formatPdfMoney(Number(item.price) || 0),
      pdfTotalQty.toLocaleString('en-US'),
      formatPdfMoney(getItemTotalQuantityValue(item)),
      itemReleasedQty.toLocaleString('en-US'),
      formatPdfMoney(getItemReleasedValue(item)),
      pdfInStockQty > 0 ? pdfInStockQty.toLocaleString('en-US') : 'Out of stock',
      formatPdfMoney(lineTotal),
      formatPdfReleaseDateTime(latestRelease || (item.releaseDate ? { date: item.releaseDate } : null)),
      pdfText(item.inventoryRemarks || '-')
    ];
    tableRows.push(fullItemData);

    if (hasSubs) {
      item.subItems.forEach((sub, subIdx) => {
        const subPrice = Number(sub.price) || 0;
        const subQty = Number(sub.quantity) || 0;
        const subReleaseHistory = getSubItemReleaseHistory(item, sub);
        const subReleasedQty = getReleasedQuantity(subReleaseHistory);
        const subLatest = subReleaseHistory[0] || null;
        const subSerialCellPdf = _getPdfSerialCell(_getSerialExportMeta(sub.serialNumber, subReleaseHistory));

        totalQty += subQty;
        totalSoldQty += subReleasedQty;
        tableRows.push([
          `${itemRowNumber}.${subIdx + 1}`,
          pdfText(`  >> ${sub.name}`),
          subSerialCellPdf,
          pdfText(sub.unitType || 'pcs'),
          formatPdfMoney(subPrice),
          (subQty + subReleasedQty).toLocaleString('en-US'),
          formatPdfMoney((subQty + subReleasedQty) * subPrice),
          subReleasedQty.toLocaleString('en-US'),
          formatPdfMoney(getReleaseValue(subReleaseHistory, subPrice)),
          subQty > 0 ? subQty.toLocaleString('en-US') : 'Out of stock',
          formatPdfMoney(subQty * subPrice),
          subLatest ? formatPdfReleaseDateTime(subLatest) : '-',
          pdfText(sub.inventoryRemarks || '-')
        ]);
      });
    }

    // Release history rows
    getMainItemReleaseHistory(item).forEach(release => {
      if (hasDateFilter && !releaseMatchesExportDateRange(release, dateFromVal, dateToVal)) return;
      const releaseUnitPrice = Number(release.unitPrice ?? item.price);
      const rQty = parseInt(release.quantity) || 0;
      const releaseValue = rQty * releaseUnitPrice;
      totalReleaseValue += releaseValue;
      totalReleaseQty += rQty;
      const relSerials = (release.releasedSerials && release.releasedSerials.length) ? ` | Serials: ${release.releasedSerials.join(', ')}` : '';
      releaseHistoryRows.push([
        releaseHistoryRows.length + 1,
        pdfText(item.name),
        '-',
        pdfText(item.unitType || item.category || 'pcs'),
        formatPdfReleaseDateTime(release),
        pdfText((release.remarks || '') + relSerials || '-'),
        rQty.toLocaleString('en-US'),
        formatPdfMoney(releaseUnitPrice),
        formatPdfMoney(releaseValue)
      ]);
    });

    if (hasSubs) {
      item.subItems.forEach(sub => {
        const subRelHist = getSubItemReleaseHistory(item, sub);
        subRelHist.forEach(release => {
          if (hasDateFilter && !releaseMatchesExportDateRange(release, dateFromVal, dateToVal)) return;
          const releaseUnitPrice = Number(release.unitPrice ?? sub.price ?? 0);
          const rQty = parseInt(release.quantity) || 0;
          const releaseValue = rQty * releaseUnitPrice;
          totalReleaseValue += releaseValue;
          totalReleaseQty += rQty;
          const relSerials = (release.releasedSerials && release.releasedSerials.length) ? ` | Serials: ${release.releasedSerials.join(', ')}` : '';
          releaseHistoryRows.push([
            releaseHistoryRows.length + 1,
            pdfText(item.name),
            pdfText(sub.name),
            pdfText(sub.unitType || 'pcs'),
            formatPdfReleaseDateTime(release),
            pdfText((release.remarks || '') + relSerials || '-'),
            rQty.toLocaleString('en-US'),
            formatPdfMoney(releaseUnitPrice),
            formatPdfMoney(releaseValue)
          ]);
        });
      });
    }
  });

  doc.autoTable({
    ..._getPdfSerialHooks(doc),
    head: [tableColumn],
    body: tableRows,
    startY: TABLE_START_Y,
    theme: 'striped',
    headStyles: {
      fillColor: [2, 132, 199],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 7.5,
      cellPadding: 1.2,
      minCellHeight: 11,
      halign: 'center',
      valign: 'middle',
      overflow: 'linebreak'
    },
    styles: {
      fontSize: 7.5,
      cellPadding: 1.6,
      halign: 'center',
      valign: 'middle',
      overflow: 'linebreak'
    },
    margin: { top: CONTENT_START_Y + 3, left: MARGIN_L, right: MARGIN_L, bottom: 14 },
    tableWidth: PAGE_W - MARGIN_L * 2,
    rowPageBreak: 'auto',
    columnStyles: {
      0: { cellWidth: 9, halign: 'center', overflow: 'visible' },
      1: { cellWidth: 42, halign: 'left' },
      2: { cellWidth: 32, halign: 'center', fontSize: 6.5 },
      3: { cellWidth: 14, halign: 'center' },
      4: { cellWidth: 20, halign: 'center' },
      5: { cellWidth: 15, halign: 'center' },
      6: { cellWidth: 23, halign: 'center' },
      7: { cellWidth: 16, halign: 'center' },
      8: { cellWidth: 23, halign: 'center' },
      9: { cellWidth: 18, halign: 'center' },
      10: { cellWidth: 23, halign: 'center' },
      11: { cellWidth: 22, halign: 'center' },
      12: { cellWidth: 26, halign: 'center' }
    },
    didDrawPage: function (data) {
      if (data.pageNumber > 1) {
        drawPageHeader(doc);
      }
    }
  });

  let finalY = doc.lastAutoTable.finalY + 8;
  const effectiveSales = hasDateFilter ? totalReleaseValue : totalSalesRevenue;

  if (finalY + 65 > FOOTER_Y - 16) {
    doc.addPage();
    drawPageHeader(doc);
    finalY = CONTENT_START_Y + 5;
  }

  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  doc.setFont(undefined, 'bold');
  doc.text(`Total Items: ${sortedItems.length.toLocaleString('en-US')}   |   In Stock Qty: ${totalQty.toLocaleString('en-US')}   |   Total Released Qty: ${(hasDateFilter ? totalReleaseQty : totalSoldQty).toLocaleString('en-US')}`, MARGIN_L, finalY);

  doc.setFontSize(11);
  doc.setTextColor(16, 185, 129);
  doc.text(`Total Released Qty Value: ${formatPdfMoney(effectiveSales)}`, MARGIN_L, finalY + 14);

  doc.setFontSize(11);
  doc.setTextColor(2, 132, 199);
  doc.text(`Grand Total Inventory Value (In-Stock): ${formatPdfMoney(grandTotal)}`, MARGIN_L, finalY + 7);

  // Release history page
  doc.addPage();
  drawPageHeader(doc);
  const rhY = CONTENT_START_Y + 3;
  doc.setFontSize(14);
  doc.setTextColor(15, 23, 42);
  doc.setFont(undefined, 'bold');
  doc.text(`Complete Release History${dateRangeLabel ? ` (${dateRangeLabel.trim()})` : ''}`, MARGIN_L, rhY);

  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.setFont(undefined, 'normal');
  doc.text(`Total released quantity: ${totalReleaseQty}   |   Total released value: ${formatPdfMoney(totalReleaseValue)}`, MARGIN_L, rhY + 7);

  if (releaseHistoryRows.length > 0) {
    doc.autoTable({
      head: [['#', 'Item Name', 'Sub-Item', 'Unit Type', 'Date Released', 'Remarks', 'Released\nQty', 'Unit Price', 'Released\nQty Value']],
      body: releaseHistoryRows,
      startY: rhY + 13,
      theme: 'striped',
      headStyles: {
        fillColor: [79, 70, 229],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        fontSize: 7.5,
        cellPadding: 1.5,
        halign: 'center',
        valign: 'middle',
        overflow: 'linebreak'
      },
      styles: {
        fontSize: 7.5,
        cellPadding: 1.8,
        halign: 'center',
        valign: 'middle',
        overflow: 'linebreak'
      },
      margin: { top: CONTENT_START_Y + 3, left: MARGIN_L, right: MARGIN_L, bottom: 14 },
      tableWidth: PAGE_W - MARGIN_L * 2,
      rowPageBreak: 'auto',
      columnStyles: {
        0: { cellWidth: 10, halign: 'center', cellPadding: { top: 2, right: 1, bottom: 2, left: 1 } },
        1: { cellWidth: 46, halign: 'left' },
        2: { cellWidth: 32, halign: 'center' },
        3: { cellWidth: 18, halign: 'center' },
        4: { cellWidth: 38, halign: 'center' },
        5: { cellWidth: 55, halign: 'center' },
        6: { cellWidth: 22, halign: 'center' },
        7: { cellWidth: 31, halign: 'center' },
        8: { cellWidth: 31, halign: 'center' }
      },
      didDrawPage: function (data) {
        if (data.pageNumber > 1) {
          drawPageHeader(doc);
        }
      }
    });
  } else {
    doc.setFontSize(11);
    doc.setTextColor(100, 116, 139);
    doc.text('No release transactions have been recorded for this period.', MARGIN_L, rhY + 20);
  }

  // ── Draw footers on all pages ─────────────────────────────────────────────
  const totalPdfPages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= totalPdfPages; p++) {
    doc.setPage(p);
    drawPageFooter(doc, p, totalPdfPages);
  }

  const filename = `inventory_summary_${fileDateSuffix}.pdf`;
  doc.save(filename);

  showToast(hasDateFilter
    ? (isSameDayRange
      ? `Filtered PDF export for ${formatDate(dateFromVal)} generated.`
      : `Filtered PDF export (${dateFromVal || 'Start'} to ${dateToVal || 'Now'}) generated.`)
    : 'Detailed PDF export generated with release history.');
}

// ── Acknowledgement Receipt Excel Export (Portrait) ─────────────────────────
// xlsx-js-style does not serialize native page setup or header/footer settings.
// Add those OOXML parts using the ZIP utilities already bundled with XLSX.
function saveAcknowledgementReceiptWorkbook(wb, filename) {
  const archive = XLSX.CFB.read(new Uint8Array(XLSX.write(wb, { bookType: 'xlsx', type: 'array' })), { type: 'array' });
  const readPart = name => new TextDecoder().decode(XLSX.CFB.find(archive, '/' + name).content);
  const writePart = (name, xml) => XLSX.CFB.utils.cfb_add(archive, '/' + name, new TextEncoder().encode(xml));
  const escapeXml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const footer = '&L&"Arial"&8&K305596\nDICT Regional Office 1\n3F Kenny Plaza Bldg., M.L. Quezon Ave.,\nSan Fernando City, La Union 2500\n'
    + '&R&"Arial"&8&K305596\nhttps://www.dict.gov.ph\nregion1@dict.gov.ph\n\n&IAcknowledgement Receipt | Page &B&P of &N'
    + '&C&8&G\n\n\n\n';
  const relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  let sheetXml = readPart('xl/worksheets/sheet1.xml');
  sheetXml = sheetXml.replace(/<pageSetup\b[^>]*\/>/g, '');
  // Insert sheetPr before dimension/sheetViews, and the print parts after pageMargins.
  sheetXml = sheetXml.replace(/(<worksheet\b[^>]*>)/, '$1<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>');
  const printXml = '<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/>'
    + `<headerFooter alignWithMargins="1" scaleWithDoc="0"><oddFooter>${escapeXml(footer)}</oddFooter></headerFooter>`;
  sheetXml = sheetXml.replace(/<pageMargins\b[^>]*\/>/, match => match + printXml);
  sheetXml = sheetXml.replace('</worksheet>', `<legacyDrawingHF xmlns:r="${relNs}" r:id="receiptFooterDrawing"/></worksheet>`);
  writePart('xl/worksheets/sheet1.xml', sheetXml);

  // A stretched blue pixel makes a true separator rule in Excel's repeated footer.
  // The center section is padded to the same five lines as the address/contact sections.
  const packageNs = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const rulePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAANSURBVBhXY6iYff0/AAZjAuo8J/uVAAAAAElFTkSuQmCC';
  XLSX.CFB.utils.cfb_add(archive, 'xl/media/receipt-footer-rule.png', Uint8Array.from(atob(rulePng), ch => ch.charCodeAt(0)));
  writePart('xl/drawings/receiptFooter.vml', '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">'
    + '<o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout>'
    + '<v:shapetype id="_x0000_t75" coordsize="21600,21600" o:spt="75" o:preferrelative="t" path="m0,0l21600,0,21600,21600,0,21600xe" filled="f" stroked="f">'
    + '<v:stroke joinstyle="miter"/><v:path o:extrusionok="f" gradientshapeok="t" o:connecttype="rect"/><o:lock v:ext="edit" aspectratio="t"/></v:shapetype>'
    + '<v:shape id="CF" o:spid="_x0000_s1025" type="#_x0000_t75" style="position:absolute;margin-left:0;margin-top:0;width:379.84pt;height:0.7pt;z-index:1">'
    + '<v:imagedata o:relid="receiptFooterRule" o:title="Footer separator"/><o:lock v:ext="edit" rotation="t"/></v:shape></xml>');
  writePart('xl/drawings/_rels/receiptFooter.vml.rels', `<Relationships xmlns="${packageNs}"><Relationship Id="receiptFooterRule" Type="${relNs}/image" Target="../media/receipt-footer-rule.png"/></Relationships>`);
  const sheetRelsPath = 'xl/worksheets/_rels/sheet1.xml.rels';
  const sheetRels = XLSX.CFB.find(archive, '/' + sheetRelsPath)
    ? readPart(sheetRelsPath) : `<Relationships xmlns="${packageNs}"></Relationships>`;
  writePart(sheetRelsPath, sheetRels.replace('</Relationships>', `<Relationship Id="receiptFooterDrawing" Type="${relNs}/vmlDrawing" Target="../drawings/receiptFooter.vml"/></Relationships>`));
  let contentTypes = readPart('[Content_Types].xml');
  if (!/Extension="vml"/.test(contentTypes)) contentTypes = contentTypes.replace('</Types>', '<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/></Types>');
  if (!/Extension="png"/.test(contentTypes)) contentTypes = contentTypes.replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>');
  writePart('[Content_Types].xml', contentTypes);

  const bytes = XLSX.CFB.write(archive, { type: 'array', fileType: 'zip', compression: true });
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportAcknowledgementReceiptToExcel(sortedItems, dateFromVal, dateToVal, hasDateFilter, isSameDayRange, isReleasedOnly = false) {
  const wb = XLSX.utils.book_new();
  const wsData = [];
  const rowMeta = [];

  const mkBorder = (c = '000000') => ({
    top: { style: 'thin', color: { rgb: c } },
    bottom: { style: 'thin', color: { rgb: c } },
    left: { style: 'thin', color: { rgb: c } },
    right: { style: 'thin', color: { rgb: c } }
  });

  // Top header matching official DICT letterhead
  wsData.push(['REPUBLIC OF THE PHILIPPINES']);
  rowMeta.push({ type: 'top-title-1' });

  wsData.push(['DEPARTMENT OF INFORMATION AND COMMUNICATIONS TECHNOLOGY']);
  rowMeta.push({ type: 'top-title-2' });

  wsData.push([]);
  rowMeta.push({ type: 'empty' });

  wsData.push(['ACKNOWLEDGEMENT RECIEPT']);
  rowMeta.push({ type: 'doc-title' });

  wsData.push(['Date: ________________________']);
  rowMeta.push({ type: 'text-left' });

  wsData.push(['I, ____________________________________________, hereby acknowledge the receipt of the following Materials/items from the department of the information and communications Technology on this day, ____________________:']);
  rowMeta.push({ type: 'ack-body' });

  wsData.push([]);
  rowMeta.push({ type: 'empty' });

  // Table header matching image (5 columns)
  const tableHeaders = ['Item No.', 'Description of Item', 'Quantity', 'Serial Number', 'Remarks'];
  wsData.push(tableHeaders);
  rowMeta.push({ type: 'table-header' });

  let rowNum = 0;
  let totalReleasedQty = 0;
  let totalReleasedValue = 0;

  sortedItems.forEach((item) => {
    const hasSubs = Array.isArray(item.subItems) && item.subItems.length > 0;
    const itemReleasedQty = getItemReleasedQuantity(item);
    const serialMeta = item._serialExportMeta || _getSerialExportMeta(item.serialNumber, getMainItemReleaseHistory(item));
    const remarks = isReleasedOnly ? (item.inventoryRemarks || item.remarks || (getLatestRelease(item)?.remarks || '')) : '';

    if (!hasSubs) {
      if (isReleasedOnly && itemReleasedQty <= 0) return;
      rowNum++;
      totalReleasedQty += itemReleasedQty;
      totalReleasedValue += getItemReleasedValue(item);
      const dispSerial = isReleasedOnly
        ? getReleasedItemSerialText(item, getReleaseHistory(item), dateFromVal, dateToVal)
        : _getXlsSerialText(serialMeta);
      wsData.push([
        `${rowNum}.`,
        item.name + (item.description ? '\n' + item.description : ''),
        isReleasedOnly ? itemReleasedQty : Number(item.quantity) || 0,
        dispSerial,
        remarks
      ]);
      rowMeta.push({ type: 'table-data', serialMeta: isReleasedOnly ? null : serialMeta });
    } else {
      const subItemsToProcess = isReleasedOnly
        ? item.subItems.filter(sub => getReleasedQuantity(getSubItemReleaseHistory(item, sub)) > 0)
        : item.subItems;

      if (isReleasedOnly && subItemsToProcess.length === 0) return;

      rowNum++;
      wsData.push([
        `${rowNum}.`,
        item.name + (item.description ? '\n' + item.description : ''),
        isReleasedOnly ? '' : Number(item.quantity) || 0,
        isReleasedOnly ? '-' : _getXlsSerialText(serialMeta),
        remarks
      ]);
      rowMeta.push({ type: 'table-data-group', serialMeta: isReleasedOnly ? null : serialMeta });

      subItemsToProcess.forEach((sub, subIdx) => {
        const subReleaseHistory = getSubItemReleaseHistory(item, sub);
        const subReleasedQty = getReleasedQuantity(subReleaseHistory);
        const subPrice = Number(sub.price) || 0;
        totalReleasedQty += subReleasedQty;
        totalReleasedValue += (subReleasedQty * subPrice);
        const subSerialMeta = sub._serialExportMeta || _getSerialExportMeta(sub.serialNumber, subReleaseHistory);
        const dispSubSerial = isReleasedOnly
          ? getReleasedItemSerialText(sub, subReleaseHistory, dateFromVal, dateToVal)
          : _getXlsSerialText(subSerialMeta);
        const subRemarks = isReleasedOnly ? (sub.inventoryRemarks || sub.remarks || '') : '';
        wsData.push([
          `${rowNum}.${subIdx + 1}`,
          '>> ' + sub.name + (sub.description ? '\n' + sub.description : ''),
          isReleasedOnly ? subReleasedQty : Number(sub.quantity) || 0,
          dispSubSerial,
          subRemarks
        ]);
        rowMeta.push({ type: 'table-data', serialMeta: isReleasedOnly ? null : subSerialMeta });
      });
    }
  });

  if (isReleasedOnly && rowNum === 0) {
    showToast('No released items found to export in Acknowledgement Receipt.', true);
    return;
  }

  // Empty row
  wsData.push([]);
  rowMeta.push({ type: 'empty' });

  // Last Part: Responsibility Statement & Signatures (Matching Image 5)
  wsData.push(['These items have been received in good condition and will be used/stored/handled as agreed upon. I accept responsibility for the items listed above.']);
  rowMeta.push({ type: 'resp-statement' });

  wsData.push([]);
  rowMeta.push({ type: 'empty' });

  ['Received By:', 'Issued By:'].forEach(heading => {
    wsData.push([heading]);
    rowMeta.push({ type: 'sig-head' });

    wsData.push(['Name:', '_____________________________________________']);
    rowMeta.push({ type: 'sig-field' });

    wsData.push(['Signature:', '__________________________________________']);
    rowMeta.push({ type: 'sig-field' });

    wsData.push(['Destination:', '________________________________________']);
    rowMeta.push({ type: 'sig-field' });

    wsData.push(['Contact No.:', '_______________________________________']);
    rowMeta.push({ type: 'sig-field' });

    wsData.push([]);
    rowMeta.push({ type: 'empty' });
  });

  // Build sheet
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Column widths (Item No., Description, Quantity, Serial Number, Remarks)
  const colWidths = [12, 45, 12, 35, 25];
  ws['!cols'] = colWidths.map(w => ({ wch: w }));

  // Inset print margins and footer position match the official receipt template.
  // Excel stores margins in inches. Leave 35 mm below content for the footer.
  ws['!margins'] = { left: 44 / 25.4, right: 32 / 25.4, top: 8 / 25.4, bottom: 35 / 25.4, header: 3 / 25.4, footer: 14 / 25.4 };

  // Merges
  const merges = [];
  rowMeta.forEach((meta, r) => {
    if (meta.type === 'top-title-1' || meta.type === 'top-title-2' || meta.type === 'doc-title' || meta.type === 'text-left' || meta.type === 'ack-body' || meta.type === 'resp-statement') {
      merges.push({ s: { r, c: 0 }, e: { r, c: 4 } });
    } else if (meta.type === 'sig-head') {
      merges.push({ s: { r, c: 0 }, e: { r, c: 4 } });
    } else if (meta.type === 'sig-field') {
      merges.push({ s: { r, c: 1 }, e: { r, c: 4 } });
    }
  });
  ws['!merges'] = merges;

  // Styling cells
  rowMeta.forEach((meta, r) => {
    if (meta.type === 'empty') return;
    for (let c = 0; c < 5; c++) {
      const ref = XLSX.utils.encode_cell({ r, c });
      if (!ws[ref]) ws[ref] = { v: '', t: 's' };

      switch (meta.type) {
        case 'top-title-1':
          ws[ref].s = {
            font: { bold: true, sz: 10, color: { rgb: '0F4C81' } },
            alignment: { horizontal: 'center', vertical: 'center' }
          };
          break;
        case 'top-title-2':
          ws[ref].s = {
            font: { bold: true, sz: 11, color: { rgb: '0F4C81' } },
            alignment: { horizontal: 'center', vertical: 'center' }
          };
          break;
        case 'doc-title':
          ws[ref].s = {
            font: { bold: true, sz: 14, color: { rgb: '000000' } },
            alignment: { horizontal: 'center', vertical: 'center' }
          };
          break;
        case 'text-left':
          ws[ref].s = {
            font: { sz: 10, color: { rgb: '000000' } },
            alignment: { horizontal: 'left', vertical: 'center' }
          };
          break;
        case 'ack-body':
        case 'resp-statement':
          ws[ref].s = {
            font: { sz: 10, color: { rgb: '000000' } },
            alignment: { horizontal: 'left', vertical: 'top', wrapText: true }
          };
          break;
        case 'sig-head':
          ws[ref].s = {
            font: { bold: true, sz: 10.5, color: { rgb: '000000' } },
            alignment: { horizontal: 'left', vertical: 'center' }
          };
          break;
        case 'sig-field':
          ws[ref].s = {
            font: { sz: 10, bold: (c === 0), color: { rgb: '000000' } },
            alignment: { horizontal: 'left', vertical: 'center' }
          };
          break;
        case 'table-header':
          ws[ref].s = {
            font: { bold: true, sz: 10, color: { rgb: '000000' } },
            fill: { patternType: 'solid', fgColor: { rgb: 'F8FAFC' } },
            alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
            border: mkBorder('000000')
          };
          break;
        case 'table-data':
        case 'table-data-group':
          ws[ref].s = {
            font: { sz: 9.5, bold: (c === 0 || meta.type === 'table-data-group'), color: { rgb: '000000' } },
            fill: { patternType: 'solid', fgColor: { rgb: 'FFFFFF' } },
            alignment: {
              horizontal: (c === 0 || c === 2) ? 'center' : 'left',
              vertical: 'top',
              wrapText: true
            },
            border: mkBorder('000000')
          };
          break;
      }
      if (c === 3) _styleXlsDeductedSerial(ws[ref], meta.serialMeta);
    }
  });

  // Dynamic row heights
  ws['!rows'] = rowMeta.map((meta, r) => {
    if (meta.type === 'top-title-1') return { hpt: 18 };
    if (meta.type === 'top-title-2') return { hpt: 20 };
    if (meta.type === 'doc-title') return { hpt: 24 };
    if (meta.type === 'text-left') return { hpt: 18 };
    if (meta.type === 'ack-body') return { hpt: 38 };
    if (meta.type === 'resp-statement') return { hpt: 32 };
    if (meta.type === 'sig-head') return { hpt: 22 };
    if (meta.type === 'sig-field') return { hpt: 20 };
    if (meta.type === 'table-header') return { hpt: 26 };
    if (meta.type === 'empty') return { hpt: 8 };
    if (meta.type === 'table-data' || meta.type === 'table-data-group') {
      const row = wsData[r];
      let maxLines = 1;
      row.forEach((cell, ci) => {
        if (!cell) return;
        const text = String(cell);
        const cw = (colWidths[ci] || 15) - 2;
        const lines = text.split('\n');
        let count = 0;
        lines.forEach(l => { count += Math.max(1, Math.ceil(l.length / (cw || 1))); });
        if (count > maxLines) maxLines = count;
      });
      return { hpt: Math.min(300, Math.max(20, maxLines * 14 + 6)) };
    }
    return { hpt: 18 };
  });

  XLSX.utils.book_append_sheet(wb, ws, isReleasedOnly ? 'Released Receipt' : 'Acknowledgement Receipt');
  const fileDateSuffix = (dateFromVal && dateToVal && !isSameDayRange)
    ? `${dateFromVal}_to_${dateToVal}`
    : (dateFromVal || dateToVal || new Date().toISOString().slice(0, 10));
  const filename = isReleasedOnly
    ? `acknowledgement_receipt_released_${fileDateSuffix}.xlsx`
    : `acknowledgement_receipt_${fileDateSuffix}.xlsx`;
  saveAcknowledgementReceiptWorkbook(wb, filename);

  showToast(`Acknowledgement Receipt (${isReleasedOnly ? 'Released Items' : 'All Items'})${hasDateFilter ? ' filtered' : ''} Excel export generated successfully.`);
}

// ── Excel Export Function ────────────────────────────────────────────────────
function exportToExcel() {
  if (items.length === 0) {
    showToast('No items available to export.', true);
    return;
  }
  if (typeof XLSX === 'undefined') {
    showToast('Excel library still loading - please try again.', true);
    return;
  }

  const dateFromVal = document.getElementById('exportDateFrom')?.value || '';
  const dateToVal = document.getElementById('exportDateTo')?.value || '';
  const scopeVal = document.getElementById('exportContentScope')?.value || 'full';
  const isTravelExport = scopeVal === 'travel' || scopeVal === 'travel_released';
  const isReleasedOnly = scopeVal === 'travel_released';
  const hasDateFilter = Boolean(dateFromVal || dateToVal);

  if (!isExportRangeValid(dateFromVal, dateToVal)) {
    showToast('From date must be on or before To date.', true);
    return;
  }
  const sortedItems = getExportItems(items, dateFromVal, dateToVal, scopeVal);
  if (!sortedItems.length) {
    showToast(isReleasedOnly ? 'No releases match the selected date range.' : 'No items match the selected export date range.', true);
    return;
  }

  let dateRangeLabel = '';
  const isSameDayRange = Boolean(dateFromVal && dateToVal && dateFromVal === dateToVal);
  if (isSameDayRange) {
    dateRangeLabel = ` [Date: ${dateFromVal}]`;
  } else if (dateFromVal && dateToVal) {
    dateRangeLabel = ` [Period: ${dateFromVal} to ${dateToVal}]`;
  } else if (dateFromVal && !dateToVal) {
    dateRangeLabel = ` [Period: From ${dateFromVal}]`;
  } else if (!dateFromVal && dateToVal) {
    dateRangeLabel = ` [Period: Up to ${dateToVal}]`;
  }

  // If Acknowledgement Receipt is selected, export using dedicated portrait format
  if (isTravelExport) {
    exportAcknowledgementReceiptToExcel(sortedItems, dateFromVal, dateToVal, hasDateFilter, isSameDayRange, isReleasedOnly);
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FULL INVENTORY (PRINT ALL) — Landscape A4
  // ══════════════════════════════════════════════════════════════════════════
  const wb = XLSX.utils.book_new();
  const wsData = [];
  const rowMeta = [];

  const S_INV = 'inv', S_REL = 'rel', S_TOT = 'tot';

  function addRow(values, type, section, opts = {}) {
    wsData.push(values);
    rowMeta.push({ type, section, ...opts });
  }

  // -- INVENTORY SUMMARY --
  const inventoryColumns = [
    '#', 'Date Added', 'Item Name', 'Description', 'Serial Number', 'Unit Type', 'Per Unit Price', 'Total Qty',
    'Total Qty Value', 'Released Qty', 'Released Qty Value', 'Remaining In Stock Qty', 'Remaining In Stock Qty Value', 'Date Released', 'Item Remarks'
  ];
  const inventoryColumnCount = inventoryColumns.length;
  addRow([`INVENTORY SUMMARY${dateRangeLabel}`], 'title', S_INV, { rgb: '0F4C81', cols: inventoryColumnCount });
  addRow(inventoryColumns, 'header', S_INV, { rgb: '0284C7', cols: inventoryColumnCount });

  let totalQty = 0, totalSoldQty = 0, totalQtyValue = 0, totalReleasedValue = 0, grandTotal = 0, totalReleaseValue = 0, totalReleaseQty = 0, invIdx = 0;

  sortedItems.forEach((item, index) => {
    const hasSubs = Array.isArray(item.subItems) && item.subItems.length > 0;
    const subSum = hasSubs ? item.subItems.reduce((a, s) => a + (Number(s.price) || 0) * (Number(s.quantity) || 0), 0) : 0;
    const lineTotal = hasSubs ? (subSum > 0 ? subSum : (item.price || 0) * (item.quantity || 0)) : item.price * item.quantity;
    const latestRelease = getLatestRelease(item);
    totalQtyValue += getItemTotalQuantityValue(item);
    totalReleasedValue += getItemReleasedValue(item);
    grandTotal += lineTotal;
    const itemReleasedQty = getItemReleasedQuantity(item);
    const xlsInStockQty = hasSubs
      ? item.subItems.reduce((s, sub) => s + (Number(sub.quantity) || 0), 0)
      : Number(item.quantity) || 0;
    const xlsTotalQty = hasSubs
      ? item.subItems.reduce((s, sub) => s + (Number(sub.quantity) || 0) + getReleasedQuantity(getSubItemReleaseHistory(item, sub)), 0)
      : xlsInStockQty + itemReleasedQty;
    if (!hasSubs) {
      totalQty += item.quantity;
      totalSoldQty += getMainItemReleasedQuantity(item);
    }
    invIdx++;

    const serialMeta = _getSerialExportMeta(item.serialNumber, getReleaseHistory(item));
    const serialText = _getXlsSerialText(serialMeta);
    const lineCount = serialText.split('\n').length;
    addRow([
      index + 1,
      formatDate(item.createdAt),
      item.name + (hasSubs ? ` [${item.subItems.length} Sub-Items]` : ''),
      item.description || '',
      serialText,
      item.unitType || item.category || 'pcs',
      hasSubs && subSum > 0 && Number(item.price) === 0 ? (subSum / (item.quantity || 1)) : (Number(item.price) || 0),
      xlsTotalQty,
      getItemTotalQuantityValue(item),
      itemReleasedQty,
      getItemReleasedValue(item),
      xlsInStockQty,
      lineTotal,
      formatReleaseDateTime(latestRelease || (item.releaseDate ? { date: item.releaseDate } : null)),
      item.inventoryRemarks || ''
    ], invIdx % 2 === 1 ? 'data-odd' : 'data-even', S_INV, { cols: inventoryColumnCount, serialMeta, lineCount });

    if (hasSubs) {
      item.subItems.forEach((sub, subIdx) => {
        const sp = Number(sub.price) || 0, sq = Number(sub.quantity) || 0;
        const subReleaseHistory = getSubItemReleaseHistory(item, sub);
        const subReleasedQty = getReleasedQuantity(subReleaseHistory);
        const subLast = subReleaseHistory[0] || null;
        const subSerialMeta = _getSerialExportMeta(sub.serialNumber, subReleaseHistory);
        const subSerialText = _getXlsSerialText(subSerialMeta);
        const subLineCount = subSerialText.split('\n').length;
        totalQty += sq;
        totalSoldQty += subReleasedQty;
        addRow([
          `${index + 1}.${subIdx + 1}`,
          '-',
          `   >> ${sub.name}`,
          sub.description || '',
          subSerialText,
          sub.unitType || 'pcs',
          sp,
          sq + subReleasedQty,
          (sq + subReleasedQty) * sp,
          subReleasedQty,
          getReleaseValue(subReleaseHistory, sp),
          sq,
          sq * sp,
          subLast ? formatReleaseDateTime(subLast) : '-',
          sub.inventoryRemarks || ''
        ], 'subitem', S_INV, { cols: inventoryColumnCount, serialMeta: subSerialMeta, lineCount: subLineCount });
      });
    }
  });

  addRow([], 'empty', null);

  // -- COMPLETE RELEASE HISTORY --
  addRow([`COMPLETE RELEASE HISTORY${dateRangeLabel}`], 'title', S_REL, { rgb: '3730A3', cols: 9 });
  addRow(['#', 'Date Released & Time', 'Item Name', 'Sub-Item', 'Remarks', 'Unit Type',
    'Released Qty', 'Unit Price', 'Released Qty Value'],
    'header', S_REL, { rgb: '4F46E5', cols: 9 });

  let relIdx = 0;
  sortedItems.forEach(item => {
    getMainItemReleaseHistory(item).forEach(release => {
      if (hasDateFilter && !releaseMatchesExportDateRange(release, dateFromVal, dateToVal)) {
        return;
      }
      relIdx++;
      const rup = Number(release.unitPrice ?? item.price);
      const rQty = parseInt(release.quantity) || 0;
      const rv = rQty * rup;
      totalReleaseValue += rv;
      totalReleaseQty += rQty;
      const relSerials = (release.releasedSerials && release.releasedSerials.length) ? ` | Serials: ${release.releasedSerials.join(', ')}` : '';
      addRow([relIdx, formatReleaseDateTime(release), item.name, '-', (release.remarks || '') + relSerials,
        item.unitType || item.category || 'pcs', rQty, rup, rv],
        relIdx % 2 === 1 ? 'data-odd' : 'data-even', S_REL, { cols: 9 });
    });
    if (Array.isArray(item.subItems)) {
      item.subItems.forEach(sub => {
        const subRelHist = getSubItemReleaseHistory(item, sub);
        subRelHist.forEach(release => {
          if (hasDateFilter && !releaseMatchesExportDateRange(release, dateFromVal, dateToVal)) {
            return;
          }
          relIdx++;
          const rup = Number(release.unitPrice ?? sub.price ?? 0);
          const rQty = parseInt(release.quantity) || 0;
          const rv = rQty * rup;
          totalReleaseValue += rv;
          totalReleaseQty += rQty;
          const relSerials = (release.releasedSerials && release.releasedSerials.length) ? ` | Serials: ${release.releasedSerials.join(', ')}` : '';
          addRow([relIdx, formatReleaseDateTime(release), item.name, sub.name, (release.remarks || '') + relSerials,
            sub.unitType || 'pcs', rQty, rup, rv],
            relIdx % 2 === 1 ? 'data-odd' : 'data-even', S_REL, { cols: 9 });
        });
      });
    }
  });
  if (relIdx === 0) addRow(['No release transactions match this date range.'], 'message', S_REL, { cols: 9 });
  addRow([], 'empty', null);



  // -- BUILD WORKSHEET --
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  const mkBorder = (c = 'D1D5DB') => ({
    top: { style: 'thin', color: { rgb: c } },
    bottom: { style: 'thin', color: { rgb: c } },
    left: { style: 'thin', color: { rgb: c } },
    right: { style: 'thin', color: { rgb: c } }
  });

  const COL_ALIGN = {
    [S_INV]: ['center', 'center', 'left', 'left', 'left', 'center', 'right', 'center', 'right', 'center', 'right', 'center', 'right', 'center', 'left'],
    // #, Date Released & Time, Item Name, Sub-Item, Remarks, Unit Type, Released Qty, Unit Price, Released Qty Value
    [S_REL]: ['center', 'left', 'left', 'left', 'left', 'center', 'center', 'right', 'right'],
    [S_TOT]: ['left', 'right']
  };
  function ha(c, section, type) {
    if (type === 'title' || type === 'message') return 'left';
    const map = COL_ALIGN[section];
    return (map && map[c]) || 'left';
  }

  rowMeta.forEach(({ type, section, rgb, cols }, r) => {
    if (type === 'empty') return;
    const nc = cols || 15;
    for (let c = 0; c < nc; c++) {
      const ref = XLSX.utils.encode_cell({ r, c });
      if (!ws[ref]) ws[ref] = { v: '', t: 's' };
      const align = ha(c, section, type);

      // Apply Excel number format for numeric cells so decimals & commas display cleanly
      if (typeof ws[ref].v === 'number') {
        const isCurrencyCol = (section === S_INV && [6, 8, 10, 12].includes(c)) || (section === S_REL && (c === 7 || c === 8));
        ws[ref].z = isCurrencyCol ? '#,##0.00' : '#,##0';
      }

      switch (type) {
        case 'title':
          ws[ref].s = {
            font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 12 },
            fill: { patternType: 'solid', fgColor: { rgb } },
            alignment: { horizontal: isTravelExport && section === S_INV ? 'center' : 'left', vertical: 'center' }
          }; break;
        case 'header':
          ws[ref].s = {
            font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 9 },
            fill: { patternType: 'solid', fgColor: { rgb } },
            alignment: { horizontal: align, vertical: 'center', wrapText: true },
            border: mkBorder('4B5563')
          }; break;
        case 'message':
          ws[ref].s = {
            font: { italic: true, color: { rgb: '92400E' }, sz: 9 },
            fill: { patternType: 'solid', fgColor: { rgb: 'FEF3C7' } },
            alignment: { horizontal: 'left', vertical: 'center' },
            border: mkBorder('FCD34D')
          }; break;
        case 'data-odd':
          ws[ref].s = {
            font: { sz: 9 },
            fill: { patternType: 'solid', fgColor: { rgb: 'FFFFFF' } },
            alignment: { horizontal: align, vertical: 'top', wrapText: true },
            border: mkBorder('E5E7EB')
          }; break;
        case 'data-even':
          ws[ref].s = {
            font: { sz: 9 },
            fill: { patternType: 'solid', fgColor: { rgb: 'F1F5F9' } },
            alignment: { horizontal: align, vertical: 'top', wrapText: true },
            border: mkBorder('E5E7EB')
          }; break;
        case 'subitem':
          ws[ref].s = {
            font: { sz: 9, italic: true, color: { rgb: '3730A3' } },
            fill: { patternType: 'solid', fgColor: { rgb: 'EEF2FF' } },
            alignment: { horizontal: align, vertical: 'top', wrapText: true },
            border: mkBorder('C7D2FE')
          }; break;
        case 'totals':
          ws[ref].s = {
            font: { bold: true, sz: 9, color: { rgb: c === 1 ? '065F46' : '1F2937' } },
            fill: { patternType: 'solid', fgColor: { rgb: c === 0 ? 'D1FAE5' : 'ECFDF5' } },
            alignment: { horizontal: align, vertical: 'center' },
            border: mkBorder('6EE7B7')
          }; break;
      }

      if (c === 4 && rowMeta[r] && rowMeta[r].serialMeta && rowMeta[r].serialMeta.hasDeducted) {
        const sm = rowMeta[r].serialMeta;
        if (sm.allDeducted) {
          ws[ref].s.font = { sz: 9, bold: true, strike: true, color: { rgb: 'DC2626' } };
          ws[ref].s.fill = { patternType: 'solid', fgColor: { rgb: 'FEE2E2' } };
          ws[ref].s.border = mkBorder('FECDD3');
        } else {
          ws[ref].s.font = { sz: 9, bold: true, color: { rgb: 'DC2626' } };
          ws[ref].s.fill = { patternType: 'solid', fgColor: { rgb: 'FEF2F2' } };
          ws[ref].s.border = mkBorder('FECDD3');
        }
        ws[ref].s.alignment = { horizontal: align, vertical: 'top', wrapText: true };
      }
    }
  });

  // Merge title + message rows across all columns
  ws['!merges'] = rowMeta.reduce((acc, { type, cols }, r) => {
    if (type === 'title' || type === 'message')
      acc.push({ s: { r, c: 0 }, e: { r, c: (cols || 15) - 1 } });
    return acc;
  }, []);

  // Col widths for Full Inventory (15 columns)
  const colWidths = [8, 22, 38, 38, 26, 12, 14, 12, 16, 13, 16, 22, 24, 18, 25];
  ws['!cols'] = colWidths.map(w => ({ wch: w }));

  // Page setup: Landscape A4 for Full Inventory (Print All)
  ws['!pageSetup'] = { orientation: 'landscape', paperSize: 9 };

  // Dynamic row heights — count actual lines per row to avoid clipping wrapped text
  function calcRowHpt(rowIdx) {
    const meta = rowMeta[rowIdx];
    if (!meta || meta.type === 'title') return 22;
    if (meta.type === 'header') return 30;
    if (meta.type === 'empty') return 8;
    const row = wsData[rowIdx];
    if (!Array.isArray(row)) return 18;
    let maxLines = 1;
    row.forEach((cell, ci) => {
      if (cell == null || typeof cell === 'number') return;
      const text = String(cell);
      const cw = (colWidths[ci] || 14) - 2;
      const explicit = text.split('\n');
      let lineCount = 0;
      explicit.forEach(part => {
        lineCount += Math.max(1, Math.ceil(part.length / (cw || 1)));
      });
      if (lineCount > maxLines) maxLines = lineCount;
    });
    return Math.min(400, Math.max(18, maxLines * 15 + 4));
  }
  ws['!rows'] = rowMeta.map((_, r) => ({ hpt: calcRowHpt(r) }));

  XLSX.utils.book_append_sheet(wb, ws, 'Inventory Report');
  const fileDateSuffix = (dateFromVal && dateToVal && !isSameDayRange)
    ? `${dateFromVal}_to_${dateToVal}`
    : (dateFromVal || dateToVal || new Date().toISOString().slice(0, 10));
  const filename = `inventory_report_${fileDateSuffix}.xlsx`;
  XLSX.writeFile(wb, filename);

  showToast(hasDateFilter
    ? (isSameDayRange
      ? `Filtered Excel export for ${dateFromVal} generated successfully.`
      : `Filtered Excel export (${dateFromVal || 'Start'} to ${dateToVal || 'Now'}) generated successfully.`)
    : 'Full Inventory Excel export generated successfully.');
}

// -- Preview Table --
function renderPreviewTable() {
  const tbody = document.getElementById('exportTableBody');
  const emptyState = document.getElementById('exportTableEmpty');
  const countBadge = document.getElementById('previewCountBadge');
  const subtitle = document.getElementById('previewTableSubtitle');
  if (!tbody) return;

  const dateFromVal = document.getElementById('exportDateFrom')?.value || '';
  const dateToVal = document.getElementById('exportDateTo')?.value || '';
  const scopeVal = document.getElementById('exportContentScope')?.value || 'full';
  const isReleasedOnly = scopeVal === 'travel_released';
  const hasDateFilter = Boolean(dateFromVal || dateToVal);

  const filtered = getExportItems(items, dateFromVal, dateToVal, scopeVal);

  if (subtitle) {
    if (isReleasedOnly) {
      subtitle.textContent = hasDateFilter
        ? 'Showing released records filtered by selected date range'
        : 'Showing all released inventory records';
    } else {
      subtitle.textContent = hasDateFilter
        ? 'Showing records filtered by selected date range'
        : 'Showing all inventory records';
    }
  }

  let tblTotalQty = 0, tblTotalQtyValue = 0, tblReleasedQty = 0, tblReleasedValue = 0, tblRemainingQty = 0, tblRemainingValue = 0;
  const rowsHtml = [];

  filtered.forEach((item, idx) => {
    const hasSubs = Array.isArray(item.subItems) && item.subItems.length > 0;
    const subSum = hasSubs ? item.subItems.reduce((a, s) => a + (Number(s.price) || 0) * (Number(s.quantity) || 0), 0) : 0;
    const lineTotal = hasSubs ? (subSum > 0 ? subSum : (Number(item.price) || 0) * (Number(item.quantity) || 0)) : (Number(item.price) || 0) * (Number(item.quantity) || 0);
    const latestRelease = getLatestRelease(item);
    const releaseHistory = getReleaseHistory(item);
    const itemReleasedQty = getItemReleasedQuantity(item);
    const inStockQty = hasSubs
      ? item.subItems.reduce((s, sub) => s + (Number(sub.quantity) || 0), 0)
      : Number(item.quantity) || 0;
    const totalQty = hasSubs
      ? item.subItems.reduce((s, sub) => s + (Number(sub.quantity) || 0) + getReleasedQuantity(getSubItemReleaseHistory(item, sub)), 0)
      : inStockQty + itemReleasedQty;
    const totalQtyValue = getItemTotalQuantityValue(item);
    const releasedValue = getItemReleasedValue(item);
    const isOutOfStock = inStockQty <= 0;
    const unitTypeLabel = item.unitType || item.category || 'pcs';

    let unitPriceDisplay = 'PHP ' + (Number(item.price) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (hasSubs) {
      if (Number(item.price) > 0) {
        unitPriceDisplay = 'PHP ' + Number(item.price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      } else if (subSum > 0) {
        unitPriceDisplay = 'PHP ' + (subSum / (item.quantity || 1)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      } else {
        unitPriceDisplay = 'PHP 0.00';
      }
    }

    if (!hasSubs) {
      tblTotalQty += totalQty;
      tblReleasedQty += itemReleasedQty;
      tblRemainingQty += inStockQty;
    } else {
      item.subItems.forEach(sub => {
        const sq = Number(sub.quantity) || 0;
        const sReleased = getSubItemReleasedQuantity(item, sub);
        tblTotalQty += sq + sReleased;
        tblReleasedQty += sReleased;
        tblRemainingQty += sq;
      });
    }
    tblTotalQtyValue += totalQtyValue;
    tblReleasedValue += releasedValue;
    tblRemainingValue += lineTotal;

    const itemNum = idx + 1;
    const dateRelStr = formatReleaseDateTime(latestRelease || (item.releaseDate ? { date: item.releaseDate } : null));

    rowsHtml.push(
      '<tr class="hover:bg-slate-50/80 transition group border-b border-slate-100">' +
      '<td class="py-2 px-3 text-center text-xs font-semibold whitespace-nowrap select-none text-slate-400">' + itemNum + '</td>' +
      '<td class="py-2 px-3">' +
      '<div class="flex items-center gap-1.5 flex-wrap">' +
      '<span class="font-semibold text-slate-900 text-xs leading-snug">' + item.name + '</span>' +
      (hasSubs ? '<span class="text-[9px] font-bold bg-indigo-50 text-indigo-700 px-1.5 py-0.5 rounded-full border border-indigo-200 whitespace-nowrap">' + item.subItems.length + ' Sub-items</span>' : '') +
      (isOutOfStock ? '<span class="text-[9px] font-bold bg-rose-100 text-rose-700 px-1.5 py-0.5 rounded-full border border-rose-200 whitespace-nowrap">Out of Stock</span>' : '') +
      '</div>' +
      (item.description ? '<p class="text-[10px] text-slate-500 mt-0.5 leading-snug">' + item.description + '</p>' : '') +
      '<p class="text-[9px] text-slate-400 mt-0.5 font-medium">Date Added: ' + formatDate(item.createdAt) + '</p>' +
      '</td>' +
      '<td class="py-2 px-2 text-center">' + (() => {
        if (!item.serialNumber) return '<span class="text-slate-300">-</span>';
        const allReleased = _getReleasedSerialsForItem(getReleaseHistory(item));
        return item.serialNumber.split('\n').filter(s => s.trim()).map(s => {
          const isRel = allReleased.has(s.trim());
          return '<span class="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 mb-0.5 rounded border leading-snug whitespace-nowrap ' + (isRel ? 'bg-rose-50 text-rose-400 border-rose-200 line-through' : 'bg-slate-100 text-slate-700 border-slate-200') + '">' + s.trim() + (isRel ? ' <i class="fa-solid fa-xmark text-[8px] text-rose-400"></i>' : '') + '</span>';
        }).join('<br>');
      })() + '</td>' +
      '<td class="py-2 px-2 text-center whitespace-nowrap"><span class="text-[10px] font-medium bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full border border-slate-200">' + unitTypeLabel + '</span></td>' +
      '<td class="py-2 px-2 text-center font-medium text-xs text-slate-700 whitespace-nowrap">' + unitPriceDisplay + '</td>' +
      '<td class="py-2 px-2 text-center font-semibold text-xs text-sky-600 whitespace-nowrap">' + totalQty.toLocaleString('en-US') + '</td>' +
      '<td class="py-2 px-2 text-center font-bold text-xs ' + (isOutOfStock ? 'text-sky-300' : 'text-sky-700') + ' whitespace-nowrap">PHP ' + totalQtyValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</td>' +
      '<td class="py-2 px-2 text-center font-semibold text-xs text-emerald-600 whitespace-nowrap">' + itemReleasedQty.toLocaleString('en-US') + '</td>' +
      '<td class="py-2 px-2 text-center font-semibold text-xs text-emerald-700 whitespace-nowrap">PHP ' + releasedValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</td>' +
      '<td class="py-2 px-2 text-center whitespace-nowrap"><span class="font-semibold text-xs ' + (isOutOfStock ? 'text-rose-600 bg-rose-50 border-rose-200' : 'text-amber-700 bg-amber-50 border-amber-200') + ' px-2.5 py-0.5 rounded-md border">' + inStockQty.toLocaleString('en-US') + '</span></td>' +
      '<td class="py-2 px-2 text-center font-bold text-xs ' + (isOutOfStock ? 'text-amber-300' : 'text-amber-700') + ' whitespace-nowrap">PHP ' + lineTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</td>' +
      '<td class="py-2 px-2 text-center text-[10px] text-slate-600 whitespace-nowrap">' + dateRelStr + '</td>' +
      '<td class="py-2 px-2 text-center text-[10px] whitespace-nowrap">' +
      (releaseHistory.length ? '<button type="button" onclick="openReleaseHistory(' + idx + ')" class="block mx-auto text-[10px] font-semibold text-brand-600 hover:text-brand-700 hover:underline cursor-pointer">View release history</button>' : '') +
      (!releaseHistory.length ? '<span class="text-slate-400">-</span>' : '') +
      '</td>' +
      '<td class="py-2 px-2 text-[10px] text-slate-600 text-center break-words min-w-[200px] max-w-[280px]">' + (item.inventoryRemarks ? item.inventoryRemarks : '<span class="text-slate-400">-</span>') + '</td>' +
      '</tr>'
    );

    if (hasSubs) {
      item.subItems.forEach((sub, subIdx) => {
        const sp = Number(sub.price) || 0;
        const sq = Number(sub.quantity) || 0;
        const subIsOOS = sq <= 0;
        const subRelHist = getSubItemReleaseHistory(item, sub);
        const subRelQty = getReleasedQuantity(subRelHist);
        const subLatest = subRelHist.length > 0 ? subRelHist[0] : null;
        const subRelVal = getReleaseValue(subRelHist, sp);

        rowsHtml.push(
          '<tr class="bg-slate-50/70 hover:bg-indigo-50/30 transition border-b border-slate-100 text-xs">' +
          '<td class="py-1.5 px-3 text-center text-[10px] font-semibold text-slate-400 whitespace-nowrap select-none">' + itemNum + '.' + (subIdx + 1) + '</td>' +
          '<td class="py-1.5 px-3">' +
          '<div class="flex items-center gap-2 pl-4">' +
          '<i class="fa-solid fa-arrow-turn-down-right text-indigo-400 text-xs flex-shrink-0"></i>' +
          '<div class="min-w-0">' +
          '<div class="flex items-center gap-1.5 flex-wrap">' +
          '<span class="font-medium text-slate-800 text-xs">' + sub.name + '</span>' +
          (subIsOOS ? '<span class="text-[8px] font-bold bg-rose-100 text-rose-700 px-1.5 rounded-full border border-rose-200">Out of Stock</span>' : '') +
          '</div>' +
          (sub.description ? '<p class="text-[10px] text-slate-400 truncate max-w-xs">' + sub.description + '</p>' : '') +
          '</div>' +
          '</div>' +
          '</td>' +
          '<td class="py-1.5 px-2 text-center">' + (() => {
            if (!sub.serialNumber) return '<span class="text-slate-300">&mdash;</span>';
            const allReleased = _getReleasedSerialsForItem(subRelHist);
            return sub.serialNumber.split('\n').filter(s => s.trim()).map(s => {
              const isRel = allReleased.has(s.trim());
              return '<span class="inline-flex items-center gap-1 text-[9px] font-mono px-1 py-0.5 mb-0.5 rounded border leading-snug whitespace-nowrap ' + (isRel ? 'bg-rose-50 text-rose-400 border-rose-200 line-through' : 'bg-slate-100 text-slate-600 border-slate-200') + '">' + s.trim() + (isRel ? ' <i class="fa-solid fa-xmark text-[7px] text-rose-400"></i>' : '') + '</span>';
            }).join('<br>');
          })() + '</td>' +
          '<td class="py-1.5 px-2 text-center whitespace-nowrap"><span class="text-[9px] font-medium bg-white text-slate-600 px-1.5 py-0.5 rounded border border-slate-200">' + (sub.unitType || 'pcs') + '</span></td>' +
          '<td class="py-1.5 px-2 text-center text-xs text-slate-600 whitespace-nowrap">PHP ' + sp.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</td>' +
          '<td class="py-1.5 px-2 text-center font-semibold text-xs text-sky-600 whitespace-nowrap">' + (sq + subRelQty).toLocaleString('en-US') + '</td>' +
          '<td class="py-1.5 px-2 text-center font-semibold text-xs ' + (subIsOOS ? 'text-sky-300' : 'text-sky-700') + ' whitespace-nowrap">PHP ' + ((sq + subRelQty) * sp).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</td>' +
          '<td class="py-1.5 px-2 text-center text-xs font-semibold text-emerald-600 whitespace-nowrap">' + subRelQty.toLocaleString('en-US') + '</td>' +
          '<td class="py-1.5 px-2 text-center font-semibold text-xs text-emerald-700 whitespace-nowrap">PHP ' + subRelVal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</td>' +
          '<td class="py-1.5 px-2 text-center whitespace-nowrap"><span class="font-semibold text-xs ' + (subIsOOS ? 'text-rose-600 bg-rose-50 border-rose-200' : 'text-amber-700 bg-amber-50 border-amber-200') + ' px-2 py-0.5 rounded border">' + sq.toLocaleString('en-US') + '</span></td>' +
          '<td class="py-1.5 px-2 text-center font-semibold text-xs ' + (subIsOOS ? 'text-amber-300' : 'text-amber-700') + ' whitespace-nowrap">PHP ' + (sq * sp).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</td>' +
          '<td class="py-1.5 px-2 text-center text-[10px] text-slate-600 whitespace-nowrap">' + (subLatest ? formatReleaseDateTime(subLatest) : '<span class="text-slate-400">&mdash;</span>') + '</td>' +
          '<td class="py-1.5 px-2 text-center text-[10px] whitespace-nowrap">' + (subRelHist.length > 0 ? '<button type="button" onclick="openSubReleaseHistoryPreview(' + idx + ',' + subIdx + ')" class="block mx-auto text-[10px] font-semibold text-brand-600 hover:text-brand-700 hover:underline cursor-pointer">View release history</button>' : '<span class="text-slate-400">&mdash;</span>') + '</td>' +
          '<td class="py-1.5 px-2 text-[10px] text-slate-600 text-center break-words min-w-[200px] max-w-[280px]">' + (sub.inventoryRemarks ? sub.inventoryRemarks : '<span class="text-slate-400">&mdash;</span>') + '</td>' +
          '</tr>'
        );
      });
    }
  });

  tbody.innerHTML = rowsHtml.join('');

  const hasRows = filtered.length > 0;
  const tableEl = document.getElementById('inventoryTable');
  if (tableEl) tableEl.classList.toggle('hidden', !hasRows);
  if (emptyState) emptyState.classList.toggle('hidden', hasRows);
  if (countBadge) countBadge.textContent = filtered.length + ' item' + (filtered.length !== 1 ? 's' : '');

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('tblTotalItems', filtered.length.toLocaleString('en-US'));
  set('tblTotalQty', tblTotalQty.toLocaleString('en-US'));
  set('tblTotalQtyValue', formatMoney(tblTotalQtyValue));
  set('tblReleasedQty', tblReleasedQty.toLocaleString('en-US'));
  set('tblReleasedValue', formatMoney(tblReleasedValue));
  set('tblRemainingQty', tblRemainingQty.toLocaleString('en-US'));
  set('tblRemainingValue', formatMoney(tblRemainingValue));

  window._previewFilteredItems = filtered;
}

// ── Release History Modal ─────────────────────────────────────────────────────
function openReleaseHistory(idx) {
  const item = (window._previewFilteredItems || [])[idx];
  if (!item) return;
  const modal = document.getElementById('releaseHistoryModal');
  const nameEl = document.getElementById('releaseHistoryItemName');
  const tbody = document.getElementById('releaseHistoryTableBody');
  const emptyEl = document.getElementById('releaseHistoryEmpty');
  if (!modal || !tbody) return;

  if (nameEl) nameEl.textContent = item.name;

  const hasSubs = Array.isArray(item.subItems) && item.subItems.length > 0;
  const allReleases = [];

  getMainItemReleaseHistory(item).forEach(rel => {
    allReleases.push({ label: item.name, release: rel, unitPrice: Number(rel.unitPrice ?? item.price) || 0 });
  });
  if (hasSubs) {
    item.subItems.forEach(sub => {
      getSubItemReleaseHistory(item, sub).forEach(rel => {
        allReleases.push({ label: `${item.name} › ${sub.name}`, release: rel, unitPrice: Number(rel.unitPrice ?? sub.price) || 0 });
      });
    });
  }

  if (allReleases.length === 0) {
    tbody.innerHTML = '';
    if (emptyEl) emptyEl.classList.remove('hidden');
  } else {
    if (emptyEl) emptyEl.classList.add('hidden');
    tbody.innerHTML = allReleases.map((entry, i) => {
      const rel = entry.release;
      const qty = Number(rel.quantity) || 0;
      const val = qty * entry.unitPrice;
      return `
        <tr class="${i % 2 === 0 ? 'bg-white' : 'bg-slate-50'} text-xs">
          <td class="py-2.5 px-4 text-slate-600">
            <div class="font-semibold text-slate-700">${formatReleaseDateTime(rel)}</div>
            <div class="text-[10px] text-slate-400 mt-0.5 italic">${entry.label}</div>
          </td>
          <td class="py-2.5 px-4 text-center font-bold text-emerald-700">${qty.toLocaleString('en-US')}</td>
          <td class="py-2.5 px-4 text-slate-600">
            <div>${rel.remarks || '-'}</div>
            ${entry.unitPrice > 0 ? `<div class="text-[10px] text-slate-400 mt-0.5">Value: ${formatMoney(val)}</div>` : ''}
          </td>
        </tr>
      `;
    }).join('');
  }

  modal.classList.remove('hidden');
  requestAnimationFrame(() => {
    modal.classList.add('opacity-100');
    const inner = modal.querySelector('div');
    if (inner) inner.classList.remove('scale-95');
  });
}

function closeReleaseHistoryModal() {
  const modal = document.getElementById('releaseHistoryModal');
  if (!modal) return;
  modal.classList.remove('opacity-100');
  const inner = modal.querySelector('div');
  if (inner) inner.classList.add('scale-95');
  setTimeout(() => modal.classList.add('hidden'), 200);
}

// ── Sub-Item Release History Modal ──────────────────────────────────────────
function openSubReleaseHistoryPreview(itemIdx, subIdx) {
  const item = (window._previewFilteredItems || [])[itemIdx];
  if (!item) return;
  const sub = (item.subItems || [])[subIdx];
  if (!sub) return;

  const modal = document.getElementById('releaseHistoryModal');
  const nameEl = document.getElementById('releaseHistoryItemName');
  const tbody = document.getElementById('releaseHistoryTableBody');
  const emptyEl = document.getElementById('releaseHistoryEmpty');
  if (!modal || !tbody) return;

  if (nameEl) nameEl.textContent = item.name + ' › ' + sub.name;

  const subReleaseHistory = getSubItemReleaseHistory(item, sub);
  const sp = Number(sub.price) || 0;

  if (subReleaseHistory.length === 0) {
    tbody.innerHTML = '';
    if (emptyEl) emptyEl.classList.remove('hidden');
  } else {
    if (emptyEl) emptyEl.classList.add('hidden');
    tbody.innerHTML = subReleaseHistory.map((rel, i) => {
      const qty = Number(rel.quantity) || 0;
      const unitPrice = Number(rel.unitPrice ?? sp) || 0;
      const val = qty * unitPrice;
      return '<tr class="' + (i % 2 === 0 ? 'bg-white' : 'bg-slate-50') + ' text-xs">' +
        '<td class="py-2.5 px-4 text-slate-600"><div class="font-semibold text-slate-700">' + formatReleaseDateTime(rel) + '</div></td>' +
        '<td class="py-2.5 px-4 text-center font-bold text-emerald-700">' + qty.toLocaleString('en-US') + '</td>' +
        '<td class="py-2.5 px-4 text-slate-600"><div>' + (rel.remarks || '-') + '</div>' + (unitPrice > 0 ? '<div class="text-[10px] text-slate-400 mt-0.5">Value: ' + formatMoney(val) + '</div>' : '') + '</td>' +
        '</tr>';
    }).join('');
  }

  modal.classList.remove('hidden');
  requestAnimationFrame(() => {
    modal.classList.add('opacity-100');
    const inner = modal.querySelector('div');
    if (inner) inner.classList.remove('scale-95');
  });
}

// ── SSE Live Updates ─────────────────────────────────────────────────────────
function initLiveUpdates() {
  if (!window.EventSource) return;
  const es = new EventSource('/api/events');
  es.addEventListener('inventory-updated', () => {
    console.log('Live inventory update received in Export Records panel.');
    loadExportData(false);
  });
  es.onerror = () => {
    console.warn('Live events connection retry in Export panel.');
  };
}

// ── Initialization ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadLogoImage('logo/dict-main-logo.png');
  loadExportData(false);
  initLiveUpdates();

  const contentScopeEl = document.getElementById('exportContentScope');
  if (contentScopeEl) {
    contentScopeEl.addEventListener('change', () => {
      updateExportRangeBadge();
    });
  }
});

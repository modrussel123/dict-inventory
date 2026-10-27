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
let reportSignatories = {
  preparedBy: atob('TWEuIEFubiBDLiBQYXNjdWE='),
  approvedBy: atob('SmVzdXMgUy4gQWdsaWFtIEpyLg==')
};
const exportLog = [];

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

function formatDateTime(value) {
  if (!value || Number.isNaN(new Date(value).getTime())) return '-';
  return new Date(value).toLocaleString('en-PH', {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
  });
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

async function loadReportSignatories() {
  try {
    const res = await fetch('/api/config/signatories');
    if (res.ok) {
      const data = await res.json();
      if (data.preparedBy) reportSignatories.preparedBy = data.preparedBy;
      if (data.approvedBy) reportSignatories.approvedBy = data.approvedBy;
    }
  } catch (err) {
    console.warn('Could not fetch signatories from API, using default configuration.');
  }
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

function getEditHistory(item) {
  return Array.isArray(item.editHistory) ? item.editHistory : [];
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

function itemMatchesExportDateRange(item, fromStr, toStr, filterType = 'any') {
  if (!fromStr && !toStr) return true;

  const createdMatches = isDateWithinRange(item.createdAt, fromStr, toStr);
  const hasReleaseMatches = () => {
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

  if (filterType === 'created') return createdMatches;
  if (filterType === 'released') return hasReleaseMatches();
  return createdMatches || hasReleaseMatches();
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
  const isActive = Boolean((fromInput && fromInput.value) || (toInput && toInput.value));
  if (badge) badge.classList.toggle('hidden', !isActive);
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

const EXPORT_LOG_STORAGE_KEY = 'dict_nbp_export_log';

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function loadStoredExportLog() {
  try {
    const raw = localStorage.getItem(EXPORT_LOG_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        exportLog.length = 0;
        exportLog.push(...parsed);
      }
    }
  } catch (e) {
    console.warn('Could not read export log from localStorage:', e);
  }
}

function saveExportLog() {
  try {
    localStorage.setItem(EXPORT_LOG_STORAGE_KEY, JSON.stringify(exportLog));
  } catch (e) {
    console.warn('Could not save export log to localStorage:', e);
  }
}

function renderExportLog() {
  const listEl = document.getElementById('exportLogList');
  if (!listEl) return;

  if (exportLog.length === 0) {
    listEl.innerHTML = '<div class="p-4 text-xs text-slate-400 text-center italic">No exports yet. Generate a report above.</div>';
    return;
  }

  listEl.innerHTML = exportLog.map(entry => {
    const isPdf = entry.type === 'pdf';
    return `
      <div class="er-log-item">
        <div class="er-log-item-icon ${isPdf ? 'bg-rose-100 text-rose-600' : 'bg-emerald-100 text-emerald-600'}">
          <i class="fa-solid ${isPdf ? 'fa-file-pdf' : 'fa-file-excel'}"></i>
        </div>
        <div class="er-log-item-content">
          <div class="er-log-item-title" title="${escapeHtml(entry.filename || '')}">${escapeHtml(entry.filename || '')}</div>
          <div class="er-log-item-time">${escapeHtml(entry.time || '')}</div>
        </div>
      </div>
    `;
  }).join('');
}

function addToExportLog(type, filename) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  exportLog.unshift({ type, filename, time: timeStr });
  saveExportLog();
  renderExportLog();
}

function clearExportLog() {
  exportLog.length = 0;
  saveExportLog();
  renderExportLog();
  showToast('Export log cleared.');
}

// ── Summary Cards Rendering ──────────────────────────────────────────────────
function renderSummaryCards() {
  const container = document.getElementById('exportSummaryCards');
  if (!container) return;

  const dateFromVal = document.getElementById('exportDateFrom')?.value || '';
  const dateToVal = document.getElementById('exportDateTo')?.value || '';
  const dateFilterType = document.getElementById('exportDateFilterType')?.value || 'any';
  const hasDateFilter = Boolean(dateFromVal || dateToVal);

  let filtered = items;
  if (hasDateFilter) {
    filtered = items.filter(item => itemMatchesExportDateRange(item, dateFromVal, dateToVal, dateFilterType));
  }

  let totalQty = 0;
  let totalSoldQty = 0;
  let grandTotal = 0;
  let totalReleaseValue = 0;

  filtered.forEach(item => {
    const hasSubs = Array.isArray(item.subItems) && item.subItems.length > 0;
    const subSum = hasSubs ? item.subItems.reduce((acc, s) => acc + ((Number(s.price) || 0) * (Number(s.quantity) || 0)), 0) : 0;
    const lineTotal = hasSubs ? (subSum > 0 ? subSum : (item.price * item.quantity)) : (item.price * item.quantity);
    grandTotal += lineTotal;

    if (!hasSubs) {
      totalQty += Number(item.quantity) || 0;
      totalSoldQty += getMainItemReleasedQuantity(item);
    } else {
      item.subItems.forEach(sub => {
        totalQty += Number(sub.quantity) || 0;
        totalSoldQty += getSubItemReleasedQuantity(item, sub);
      });
    }

    // Release value
    getMainItemReleaseHistory(item).forEach(release => {
      if (hasDateFilter && !releaseMatchesExportDateRange(release, dateFromVal, dateToVal)) return;
      const rQty = parseInt(release.quantity) || 0;
      const rPrice = Number(release.unitPrice ?? item.price) || 0;
      totalReleaseValue += rQty * rPrice;
    });

    if (hasSubs) {
      item.subItems.forEach(sub => {
        getSubItemReleaseHistory(item, sub).forEach(release => {
          if (hasDateFilter && !releaseMatchesExportDateRange(release, dateFromVal, dateToVal)) return;
          const rQty = parseInt(release.quantity) || 0;
          const rPrice = Number(release.unitPrice ?? sub.price ?? 0) || 0;
          totalReleaseValue += rQty * rPrice;
        });
      });
    }
  });

  const effectiveSales = hasDateFilter ? totalReleaseValue : totalSalesRevenue;

  container.innerHTML = `
    <div class="er-summary-card">
      <span class="er-summary-card-label">Matching Items</span>
      <span class="er-summary-card-value text-slate-800">${filtered.length.toLocaleString('en-US')}</span>
      <span class="er-summary-card-sub">of ${items.length.toLocaleString('en-US')} total</span>
    </div>
    <div class="er-summary-card">
      <span class="er-summary-card-label">Released Qty</span>
      <span class="er-summary-card-value text-indigo-600">${totalSoldQty.toLocaleString('en-US')}</span>
      <span class="er-summary-card-sub">transacted units</span>
    </div>
    <div class="er-summary-card">
      <span class="er-summary-card-label">Released Value</span>
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
    items = Array.isArray(data.items) ? data.items : [];
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
  const dateFilterType = document.getElementById('exportDateFilterType')?.value || 'any';
  const isTravelExport = document.getElementById('exportContentScope')?.value === 'travel';
  const hasDateFilter = Boolean(dateFromVal || dateToVal);

  let sortedItems = [...items];
  if (hasDateFilter) {
    sortedItems = sortedItems.filter(item => itemMatchesExportDateRange(item, dateFromVal, dateToVal, dateFilterType));
    if (sortedItems.length === 0) {
      showToast('No items match the selected export date range.', true);
      return;
    }
  }

  let dateRangeLabel = '';
  const isSameDayRange = Boolean(dateFromVal && dateToVal && dateFromVal === dateToVal);
  if (dateFromVal && dateToVal && !isSameDayRange) {
    dateRangeLabel = `Period: ${formatDate(dateFromVal)} - ${formatDate(dateToVal)}`;
  } else if (dateFromVal && !dateToVal) {
    dateRangeLabel = `Period: From ${formatDate(dateFromVal)}`;
  } else if (!dateFromVal && dateToVal) {
    dateRangeLabel = `Period: Up to ${formatDate(dateToVal)}`;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const formatPdfMoney = (val) => 'PHP ' + Number(val || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Centered DICT Main Logo
  const logoImg = cachedLogoImg || await loadLogoImage('logo/dict-main-logo.png');
  if (logoImg) {
    try {
      const logoW = 105;
      const logoH = 105 / (795 / 144);
      const logoX = (297 - logoW) / 2;
      doc.addImage(logoImg, 'PNG', logoX, 8, logoW, logoH);
    } catch (err) {
      console.warn('Could not render logo in PDF:', err);
    }
  }

  const isReleaseOnlyFilter = hasDateFilter && dateFilterType === 'released';
  doc.setFontSize(16);
  doc.setTextColor(15, 23, 42);
  doc.setFont(undefined, 'bold');
  doc.text(isTravelExport
    ? "Travel Inventory Report"
    : (isReleaseOnlyFilter ? "Inventory Release & Disbursement Report" : "Inventory & Stock Summary Report"), 148.5, 33, { align: 'center' });

  doc.setFontSize(9.5);
  doc.setTextColor(100, 116, 139);
  doc.setFont(undefined, 'normal');
  const subtitle = `Generated on: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}${dateRangeLabel ? `   |   ${dateRangeLabel}` : ''}`;
  doc.text(subtitle, 148.5, 39, { align: 'center' });

  const tableColumn = isTravelExport
    ? ['#', 'Item & Description', 'Serial Number', 'Unit Type', 'Per Unit Price', 'Released Qty', 'Released Qty Value', 'Date Released', 'Remarks']
    : ['#', 'Item & Description', 'Serial Number', 'Unit Type', 'Per Unit Price', 'Total Qty', 'Total Qty Value', 'Released Qty', 'Released Qty Value', 'Remaining In\nStock Qty', 'Remaining In\nStock Value', 'Date Released', 'Remarks'];
  const tableRows = [];
  const releaseHistoryRows = [];
  const editHistoryRows = [];

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
    const itemSerialLines = (item.serialNumber || '').split('\n').map(s => s.trim()).filter(Boolean);
    const serialCellPdf = itemSerialLines.length > 0 ? pdfText(itemSerialLines.join('\n')) : '-';

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
    tableRows.push(isTravelExport
      ? [fullItemData[0], fullItemData[1], fullItemData[2], fullItemData[3], fullItemData[4], fullItemData[7], fullItemData[8], fullItemData[11], fullItemData[12]]
      : fullItemData);

    // Sub-item rows
    if (hasSubs) {
      item.subItems.forEach((sub, subIdx) => {
        const subPrice = Number(sub.price) || 0;
        const subQty = Number(sub.quantity) || 0;
        const subReleaseHistory = getSubItemReleaseHistory(item, sub);
        const subReleasedQty = getReleasedQuantity(subReleaseHistory);
        const subLatest = subReleaseHistory[0] || null;
        const subSerialLines = (sub.serialNumber || '').split('\n').map(s => s.trim()).filter(Boolean);
        const subSerialCellPdf = subSerialLines.length > 0 ? pdfText(subSerialLines.join('\n')) : '-';

        totalQty += subQty;
        totalSoldQty += subReleasedQty;
        const fullSubItemData = [
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
        ];
        tableRows.push(isTravelExport
          ? [fullSubItemData[0], fullSubItemData[1], fullSubItemData[2], fullSubItemData[3], fullSubItemData[4], fullSubItemData[7], fullSubItemData[8], fullSubItemData[11], fullSubItemData[12]]
          : fullSubItemData);
      });
    }

    // Parent release history
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

    // Sub-item release history
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

    // Edit history
    getEditHistory(item).forEach(edit => {
      if (hasDateFilter && !isDateWithinRange(edit.changedAt, dateFromVal, dateToVal)) return;
      (edit.changes || []).forEach(change => {
        editHistoryRows.push([
          editHistoryRows.length + 1,
          pdfText(item.name),
          pdfText(item.unitType || item.category || 'pcs'),
          formatPdfDateTime(edit.changedAt),
          pdfText(change.label || 'Change'),
          pdfText(change.from || '-'),
          pdfText(change.to || '-')
        ]);
      });
    });
  });

  doc.autoTable({
    head: [tableColumn],
    body: tableRows,
    startY: 44,
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
    margin: { left: 7, right: 7 },
    tableWidth: 283,
    rowPageBreak: 'auto',
    columnStyles: isTravelExport ? {
      0: { cellWidth: 10, halign: 'center', overflow: 'visible' },
      1: { cellWidth: 62, halign: 'left' },
      2: { cellWidth: 35, halign: 'center', fontSize: 7 },
      3: { cellWidth: 16, halign: 'center' },
      4: { cellWidth: 26, halign: 'center' },
      5: { cellWidth: 22, halign: 'center' },
      6: { cellWidth: 30, halign: 'center' },
      7: { cellWidth: 36, halign: 'center' },
      8: { cellWidth: 46, halign: 'center' }
    } : {
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
    }
  });

  let finalY = doc.lastAutoTable.finalY + 8;
  const effectiveSales = hasDateFilter ? totalReleaseValue : totalSalesRevenue;

  if (finalY + (isReleaseOnlyFilter ? 50 : 65) > 200) {
    doc.addPage();
    finalY = 20;
  }

  if (isReleaseOnlyFilter) {
    doc.setFontSize(10);
    doc.setTextColor(15, 23, 42);
    doc.setFont(undefined, 'bold');
    doc.text(`Total Released Items: ${sortedItems.length.toLocaleString('en-US')}   |   Total Released Qty (Selected Period): ${totalReleaseQty.toLocaleString('en-US')}`, 7, finalY);

    doc.setFontSize(11);
    doc.setTextColor(16, 185, 129);
    doc.text(`Total Released Qty Value: ${formatPdfMoney(totalReleaseValue)}`, 7, finalY + 7);
  } else {
    doc.setFontSize(10);
    doc.setTextColor(15, 23, 42);
    doc.setFont(undefined, 'bold');
    doc.text(isTravelExport
      ? `Total Items: ${sortedItems.length.toLocaleString('en-US')}   |   Total Released Qty: ${(hasDateFilter ? totalReleaseQty : totalSoldQty).toLocaleString('en-US')}`
      : `Total Items: ${sortedItems.length.toLocaleString('en-US')}   |   In Stock Qty: ${totalQty.toLocaleString('en-US')}   |   Total Released Qty: ${(hasDateFilter ? totalReleaseQty : totalSoldQty).toLocaleString('en-US')}`, 7, finalY);

    doc.setFontSize(11);
    doc.setTextColor(16, 185, 129);
    doc.text(`Total Released Qty Value: ${formatPdfMoney(effectiveSales)}`, 7, finalY + (isTravelExport ? 7 : 14));
    if (!isTravelExport) {
      doc.setFontSize(11);
      doc.setTextColor(2, 132, 199);
      doc.text(`Grand Total Inventory Value (In-Stock): ${formatPdfMoney(grandTotal)}`, 7, finalY + 7);
    }
  }

  // Signatories
  let signY = finalY + (isReleaseOnlyFilter || isTravelExport ? 20 : 27);
  if (signY + 34 > 200) {
    doc.addPage();
    signY = 22;
  }

  doc.setFontSize(9.5);
  doc.setFont(undefined, 'bold');
  doc.setTextColor(71, 85, 105);
  doc.text('Prepared By:', 7, signY);

  doc.setFontSize(10.5);
  doc.setFont(undefined, 'bold');
  doc.setTextColor(15, 23, 42);
  doc.text(reportSignatories.preparedBy, 7, signY + 6.5);

  doc.setFontSize(9.5);
  doc.setFont(undefined, 'bold');
  doc.setTextColor(71, 85, 105);
  doc.text('Approved By:', 7, signY + 20);

  doc.setFontSize(10.5);
  doc.setFont(undefined, 'bold');
  doc.setTextColor(15, 23, 42);
  doc.text(reportSignatories.approvedBy, 7, signY + 26.5);

  doc.setFontSize(9.5);
  doc.setFont(undefined, 'bold');
  doc.setTextColor(71, 85, 105);
  doc.text('Received By:', 225, signY);

  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.3);
  doc.line(225, signY + 14, 285, signY + 14);

  if (!isTravelExport) {
    doc.addPage();
    doc.setFontSize(16);
    doc.setTextColor(15, 23, 42);
    doc.text(`Complete Release History${dateRangeLabel ? ` (${dateRangeLabel.trim()})` : ''}`, 7, 20);

    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.text(`Total released quantity: ${totalReleaseQty}   |   Total released value: ${formatPdfMoney(totalReleaseValue)}`, 7, 27);

    if (releaseHistoryRows.length > 0) {
      doc.autoTable({
        head: [['#', 'Item Name', 'Sub-Item', 'Unit Type', 'Date Released', 'Remarks', 'Released\nQty', 'Unit Price', 'Released\nQty Value']],
        body: releaseHistoryRows,
        startY: 33,
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
        margin: { left: 7, right: 7 },
        tableWidth: 283,
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
        }
      });
    } else {
      doc.setFontSize(11);
      doc.setTextColor(100, 116, 139);
      doc.text('No release transactions have been recorded for this period.', 7, 40);
    }

    doc.addPage();
    doc.setFontSize(16);
    doc.setTextColor(15, 23, 42);
    doc.text(`Complete Edit History${dateRangeLabel ? ` (${dateRangeLabel.trim()})` : ''}`, 7, 20);

    if (editHistoryRows.length > 0) {
      doc.autoTable({
        head: [['#', 'Item Name', 'Unit Type', 'Edited At', 'Field Changed', 'Previous Value', 'Updated Value']],
        body: editHistoryRows,
        startY: 28,
        theme: 'striped',
        headStyles: {
          fillColor: [2, 132, 199],
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
        margin: { left: 7, right: 7 },
        tableWidth: 283,
        rowPageBreak: 'auto',
        columnStyles: {
          0: { cellWidth: 10, halign: 'center', cellPadding: { top: 2, right: 1, bottom: 2, left: 1 } },
          1: { cellWidth: 52, halign: 'left' },
          2: { cellWidth: 20, halign: 'center' },
          3: { cellWidth: 40, halign: 'center' },
          4: { cellWidth: 35, halign: 'center' },
          5: { cellWidth: 63, halign: 'center' },
          6: { cellWidth: 63, halign: 'center' }
        }
      });
    } else {
      doc.setFontSize(11);
      doc.setTextColor(100, 116, 139);
      doc.text('No edits have been recorded for this period.', 7, 40);
    }
  }

  const fileDateSuffix = (dateFromVal && dateToVal && !isSameDayRange)
    ? `${dateFromVal}_to_${dateToVal}`
    : (dateFromVal || dateToVal || new Date().toISOString().slice(0, 10));
  const filename = `${isTravelExport ? 'travel_inventory' : 'inventory_summary'}_${fileDateSuffix}.pdf`;
  doc.save(filename);
  addToExportLog('pdf', filename);

  showToast(isTravelExport
    ? `Travel inventory ${hasDateFilter ? 'filtered ' : ''}PDF export generated.`
    : (hasDateFilter
      ? (isSameDayRange
        ? `Filtered PDF export for ${formatDate(dateFromVal)} generated.`
        : `Filtered PDF export (${dateFromVal || 'Start'} to ${dateToVal || 'Now'}) generated.`)
      : 'Detailed PDF export generated with release and edit history.'));
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
  const dateFilterType = document.getElementById('exportDateFilterType')?.value || 'any';
  const isTravelExport = document.getElementById('exportContentScope')?.value === 'travel';
  const hasDateFilter = Boolean(dateFromVal || dateToVal);

  let sortedItems = [...items];
  if (hasDateFilter) {
    sortedItems = sortedItems.filter(item => itemMatchesExportDateRange(item, dateFromVal, dateToVal, dateFilterType));
    if (sortedItems.length === 0) {
      showToast('No items match the selected export date range.', true);
      return;
    }
  }

  let dateRangeLabel = '';
  const isSameDayRange = Boolean(dateFromVal && dateToVal && dateFromVal === dateToVal);
  if (dateFromVal && dateToVal && !isSameDayRange) {
    dateRangeLabel = ` [Period: ${dateFromVal} to ${dateToVal}]`;
  } else if (dateFromVal && !dateToVal) {
    dateRangeLabel = ` [Period: From ${dateFromVal}]`;
  } else if (!dateFromVal && dateToVal) {
    dateRangeLabel = ` [Period: Up to ${dateToVal}]`;
  }

  const wb = XLSX.utils.book_new();
  const wsData = [];
  const rowMeta = [];

  const S_INV = 'inv', S_REL = 'rel', S_EDIT = 'edit', S_TOT = 'tot';

  function addRow(values, type, section, opts = {}) {
    wsData.push(values);
    rowMeta.push({ type, section, ...opts });
  }

  // -- INVENTORY SUMMARY --
  const isReleaseOnlyFilter = hasDateFilter && dateFilterType === 'released';
  const inventoryColumns = isTravelExport
    ? ['#', 'Date Added', 'Item Name', 'Description', 'Serial Number', 'Unit Type', 'Per Unit Price', 'Released Qty', 'Released Qty Value', 'Date Released', 'Remarks']
    : ['#', 'Date Added', 'Item Name', 'Description', 'Serial Number', 'Unit Type', 'Per Unit Price', 'Total Qty',
      'Total Qty Value', 'Released Qty', 'Released Qty Value', 'Remaining In Stock Qty', 'Remaining In Stock Qty Value', 'Date Released', 'Item Remarks'];
  const inventoryColumnCount = inventoryColumns.length;
  addRow([`${isTravelExport ? 'TRAVEL INVENTORY' : (isReleaseOnlyFilter ? 'INVENTORY RELEASE & DISBURSEMENT SUMMARY' : 'INVENTORY SUMMARY')}${dateRangeLabel}`], 'title', S_INV, { rgb: '0F4C81', cols: inventoryColumnCount });
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

  // -- COMPLETE EDIT HISTORY --
  addRow([`COMPLETE EDIT HISTORY${dateRangeLabel}`], 'title', S_EDIT, { rgb: '0369A1', cols: 11 });
  addRow(['#', 'Edited Date & Time', 'Item Name', 'Field Changed', 'Before', 'After', 'Unit Type'],
    'header', S_EDIT, { rgb: '0C5E9E', cols: 7 });

  let editIdx = 0;
  sortedItems.forEach(item => {
    getEditHistory(item).forEach(edit => {
      if (hasDateFilter && !isDateWithinRange(edit.changedAt, dateFromVal, dateToVal)) {
        return;
      }
      (edit.changes || []).forEach(change => {
        editIdx++;
        addRow([editIdx, formatDateTime(edit.changedAt), item.name, change.label || 'Change',
          change.from || '-', change.to || '-', item.unitType || item.category || 'pcs'],
          editIdx % 2 === 1 ? 'data-odd' : 'data-even', S_EDIT, { cols: 7 });
      });
    });
  });
  if (!editIdx) addRow(['No edits match this date range.'], 'message', S_EDIT, { cols: 7 });
  addRow([], 'empty', null);

  // -- REPORT TOTALS --
  addRow(['REPORT TOTALS'], 'title', S_TOT, { rgb: '064E3B', cols: 3 });
  const effectiveSales = hasDateFilter ? totalReleaseValue : totalSalesRevenue;

  if (isReleaseOnlyFilter) {
    [
      ['Total Released Items', sortedItems.length.toLocaleString('en-US')],
      ['Total Released Quantity (Selected Period)', totalReleaseQty.toLocaleString('en-US')],
      ['Total Released Qty Value', `PHP ${totalReleaseValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`]
    ].forEach(row => addRow(row, 'totals', S_TOT, { cols: 2 }));
  } else {
    [
      ['Total Items', sortedItems.length.toLocaleString('en-US')],
      ['Total In-Stock Quantity', totalQty.toLocaleString('en-US')],
      ['Grand Total Inventory Value (In-Stock)', `PHP ${grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`],
      ['Total Released Quantity', (hasDateFilter ? totalReleaseQty : totalSoldQty).toLocaleString('en-US')],
      ['Total Released Qty Value', `PHP ${effectiveSales.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`]
    ].forEach(row => addRow(row, 'totals', S_TOT, { cols: 2 }));
  }
  addRow([], 'empty', null);
  addRow(['Prepared By', reportSignatories.preparedBy], 'totals', S_TOT, { cols: 2 });
  addRow(['Approved By', reportSignatories.approvedBy], 'totals', S_TOT, { cols: 2 });
  addRow(['Received By', '________________________'], 'totals', S_TOT, { cols: 2 });

  if (isTravelExport) {
    const travelColumnIndexes = [0, 1, 2, 3, 4, 5, 6, 9, 10, 13, 14];
    const travelRows = [];
    const travelMeta = [];
    wsData.forEach((row, index) => {
      if (rowMeta[index].section !== S_INV) return;
      travelRows.push(rowMeta[index].type === 'title' || rowMeta[index].type === 'header'
        ? row
        : travelColumnIndexes.map(columnIndex => row[columnIndex]));
      travelMeta.push({ ...rowMeta[index], cols: inventoryColumnCount });
    });
    travelRows.push([]);
    travelMeta.push({ type: 'empty', section: null });
    travelRows.push(['TRAVEL INVENTORY TOTALS']);
    travelMeta.push({ type: 'title', section: S_TOT, rgb: '064E3B', cols: 2 });
    travelRows.push(['Total Released Items', sortedItems.length.toLocaleString('en-US')]);
    travelMeta.push({ type: 'totals', section: S_TOT, cols: 2 });
    travelRows.push(['Total Released Quantity (Selected Period)', (hasDateFilter ? totalReleaseQty : totalSoldQty).toLocaleString('en-US')]);
    travelMeta.push({ type: 'totals', section: S_TOT, cols: 2 });
    travelRows.push(['Total Released Qty Value', `PHP ${(hasDateFilter ? totalReleaseValue : totalSalesRevenue).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`]);
    travelMeta.push({ type: 'totals', section: S_TOT, cols: 2 });
    travelRows.push([]);
    travelMeta.push({ type: 'empty', section: null });
    travelRows.push(['Prepared By', reportSignatories.preparedBy]);
    travelMeta.push({ type: 'totals', section: S_TOT, cols: 2 });
    travelRows.push(['Approved By', reportSignatories.approvedBy]);
    travelMeta.push({ type: 'totals', section: S_TOT, cols: 2 });
    travelRows.push(['Received By', '________________________']);
    travelMeta.push({ type: 'totals', section: S_TOT, cols: 2 });
    wsData.splice(0, wsData.length, ...travelRows);
    rowMeta.splice(0, rowMeta.length, ...travelMeta);
  }

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
    // #, Edited Date & Time, Item Name, Field Changed, Before, After, Unit Type
    [S_EDIT]: ['center', 'left', 'left', 'left', 'left', 'left', 'center'],
    [S_TOT]: ['left', 'right']
  };
  function ha(c, section, type) {
    if (isTravelExport && section === S_INV) {
      if (c === 2 || c === 3 || c === 4 || c === 10) return 'left';
      if (c === 6 || c === 8) return 'right';
      return 'center';
    }
    if (type === 'title' || type === 'message') return 'left';
    const map = COL_ALIGN[section];
    return (map && map[c]) || 'left';
  }

  rowMeta.forEach(({ type, section, rgb, cols }, r) => {
    if (type === 'empty') return;
    const nc = cols || 11;
    for (let c = 0; c < nc; c++) {
      const ref = XLSX.utils.encode_cell({ r, c });
      if (!ws[ref]) ws[ref] = { v: '', t: 's' };
      const align = ha(c, section, type);

      // Apply Excel number format for numeric cells so decimals & commas display cleanly
      if (typeof ws[ref].v === 'number') {
        const isCurrencyCol = isTravelExport
          ? (section === S_INV && (c === 6 || c === 8))
          : ((section === S_INV && [6, 8, 10, 12].includes(c)) || (section === S_REL && (c === 7 || c === 8)));
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
      acc.push({ s: { r, c: 0 }, e: { r, c: (cols || 11) - 1 } });
    return acc;
  }, []);

  // Col widths: #, Date, Item Name, Description/Sub-Item, Serial/Remarks, Unit Type, ...
  const colWidths = isTravelExport
    ? [8, 22, 38, 38, 26, 12, 14, 14, 18, 20, 30]
    : [8, 22, 38, 38, 26, 12, 14, 12, 16, 13, 16, 22, 24, 18, 25];
  ws['!cols'] = colWidths.map(w => ({ wch: w }));

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
  const filename = `${isTravelExport ? 'travel_inventory' : 'inventory_report'}_${fileDateSuffix}.xlsx`;
  XLSX.writeFile(wb, filename);
  addToExportLog('excel', filename);

  showToast(isTravelExport
    ? `Travel inventory ${hasDateFilter ? 'filtered ' : ''}Excel export generated successfully.`
    : (hasDateFilter
      ? (isSameDayRange
        ? `Filtered Excel export for ${dateFromVal} generated successfully.`
        : `Filtered Excel export (${dateFromVal || 'Start'} to ${dateToVal || 'Now'}) generated successfully.`)
      : 'Color-formatted Excel export generated successfully.'));
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
  const dateFilterType = document.getElementById('exportDateFilterType')?.value || 'any';
  const hasDateFilter = Boolean(dateFromVal || dateToVal);

  const filtered = hasDateFilter
    ? items.filter(item => itemMatchesExportDateRange(item, dateFromVal, dateToVal, dateFilterType))
    : [...items];

  if (subtitle) {
    subtitle.textContent = hasDateFilter
      ? 'Showing records filtered by selected date range'
      : 'Showing all inventory records';
  }

  let tblTotalQty = 0, tblTotalQtyValue = 0, tblReleasedQty = 0, tblReleasedValue = 0, tblRemainingQty = 0, tblRemainingValue = 0;
  const rowsHtml = [];

  filtered.forEach((item, idx) => {
    const hasSubs = Array.isArray(item.subItems) && item.subItems.length > 0;
    const subSum = hasSubs ? item.subItems.reduce((a, s) => a + (Number(s.price) || 0) * (Number(s.quantity) || 0), 0) : 0;
    const lineTotal = hasSubs ? (subSum > 0 ? subSum : (Number(item.price) || 0) * (Number(item.quantity) || 0)) : (Number(item.price) || 0) * (Number(item.quantity) || 0);
    const latestRelease = getLatestRelease(item);
    const releaseHistory = getReleaseHistory(item);
    const editHistory = getEditHistory(item);
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
      (editHistory.length ? '<button type="button" onclick="openEditHistory(' + idx + ')" class="' + (releaseHistory.length ? 'mt-1 ' : '') + 'block mx-auto text-[10px] font-semibold text-indigo-600 hover:text-indigo-700 hover:underline cursor-pointer">View edit history</button>' : '') +
      (!releaseHistory.length && !editHistory.length ? '<span class="text-slate-400">-</span>' : '') +
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

// ── Edit History Modal ────────────────────────────────────────────────────────
function openEditHistory(idx) {
  const item = (window._previewFilteredItems || [])[idx];
  if (!item) return;
  const modal = document.getElementById('editHistoryModal');
  const nameEl = document.getElementById('editHistoryItemName');
  const tbody = document.getElementById('editHistoryTableBody');
  if (!modal || !tbody) return;

  if (nameEl) nameEl.textContent = item.name;

  const edits = getEditHistory(item);
  if (edits.length === 0) {
    tbody.innerHTML = `<tr><td colspan="2" class="py-8 text-center text-sm text-slate-500 italic">No edits have been recorded for this item.</td></tr>`;
  } else {
    tbody.innerHTML = edits.map((edit, i) => {
      const changes = Array.isArray(edit.changes) ? edit.changes : [];
      const changesHtml = changes.map(change => `
        <div class="text-[11px] flex items-start gap-1.5 mt-1 first:mt-0">
          <span class="font-semibold text-slate-600 shrink-0">${change.label || 'Field'}:</span>
          <span class="text-rose-500 line-through">${change.from || '-'}</span>
          <i class="fa-solid fa-arrow-right text-slate-300 text-[9px] mt-0.5 shrink-0"></i>
          <span class="text-emerald-600">${change.to || '-'}</span>
        </div>
      `).join('');
      return `
        <tr class="${i % 2 === 0 ? 'bg-white' : 'bg-slate-50'} text-xs align-top">
          <td class="py-2.5 px-4 text-slate-500 whitespace-nowrap">${formatDateTime(edit.changedAt)}</td>
          <td class="py-2.5 px-4">${changesHtml || '<span class="text-slate-400 italic">No field changes recorded.</span>'}</td>
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

function closeEditHistoryModal() {
  const modal = document.getElementById('editHistoryModal');
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
  loadReportSignatories();
  loadLogoImage('logo/dict-main-logo.png');
  loadStoredExportLog();
  renderExportLog();
  loadExportData(false);
  initLiveUpdates();

  // Also re-render preview when the filter type changes
  const filterTypeEl = document.getElementById('exportDateFilterType');
  if (filterTypeEl) filterTypeEl.addEventListener('change', renderPreviewTable);
});

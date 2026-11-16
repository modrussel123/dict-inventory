(function (root, factory) {
  const ordering = factory();
  if (typeof module === 'object' && module.exports) module.exports = ordering;
  else root.InventoryOrder = ordering;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  function timestamp(item) {
    const time = item.createdAt == null ? NaN : new Date(item.createdAt).getTime();
    // Undated legacy records precede newly added records.
    return Number.isFinite(time) ? time : 0;
  }

  function compareOldest(left, right) {
    return timestamp(left) - timestamp(right) ||
      (Number(left.sortOrder) || 0) - (Number(right.sortOrder) || 0) ||
      String(left.id || left._id || '').localeCompare(String(right.id || right._id || ''));
  }

  function uniqueItems(list) {
    const seen = new Set();
    return (Array.isArray(list) ? list : []).filter(item => {
      if (!item || typeof item !== 'object') return false;
      const keys = [item.id, item._id].filter(Boolean).map(String);
      if (keys.some(key => seen.has(key))) return false;
      keys.forEach(key => seen.add(key));
      // Matching names or dates alone do not establish duplicate identity.
      return true;
    });
  }

  function oldestFirst(list) {
    return uniqueItems(list).sort(compareOldest);
  }

  return { compareOldest, uniqueItems, oldestFirst };
});

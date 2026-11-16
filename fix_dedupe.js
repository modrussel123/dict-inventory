const fs = require('fs');
const content = fs.readFileSync('d:/DICT_NBP_INVENTORY-WEB/frontend/index.html', 'utf8');

const startMarker = '    function dedupeItemsList(list) {';
const startIdx = content.indexOf(startMarker);
if (startIdx === -1) { console.error('START NOT FOUND'); process.exit(1); }

// Find the closing brace of this function (the next "\n    }" after startIdx)
const endMarker = '\n    }';
const endIdx = content.indexOf(endMarker, startIdx);
if (endIdx === -1) { console.error('END NOT FOUND'); process.exit(1); }

const oldBlock = content.slice(startIdx, endIdx + endMarker.length);
console.log('OLD BLOCK:\n', JSON.stringify(oldBlock));

const newBlock = `    function dedupeItemsList(list) {
      if (!Array.isArray(list)) return [];
      const seenIds = new Set();
      const seenFallback = new Set();
      const clean = [];
      for (const item of list) {
        if (!item) continue;

        // Primary dedup key: stable DB-assigned id (Mongo _id or client 'item-...')
        const idKey = String(item.id || item._id || '').trim();
        if (idKey) {
          if (seenIds.has(idKey)) continue;
          seenIds.add(idKey);
        } else {
          // Fallback for legacy items without a stable id
          const nameKey = String(item.name || '').trim().toLowerCase();
          const createdKey = item.createdAt ? new Date(item.createdAt).getTime() : '';
          const compositeKey = nameKey + '|' + createdKey;
          if (compositeKey && createdKey) {
            if (seenFallback.has(compositeKey)) continue;
            seenFallback.add(compositeKey);
          }
        }
        clean.push(item);
      }
      return clean;
    }`;

const replaced = content.slice(0, startIdx) + newBlock + content.slice(endIdx + endMarker.length);
fs.writeFileSync('d:/DICT_NBP_INVENTORY-WEB/frontend/index.html', replaced, 'utf8');
console.log('Successfully replaced dedupeItemsList. File size:', replaced.length);

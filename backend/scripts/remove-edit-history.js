const assert = require('node:assert/strict');
const path = require('node:path');
const mongoose = require('mongoose');

async function removeEditHistory(db) {
  // Use the native collection to avoid schema casting or timestamp changes.
  const collection = db.collection('inventoryitems');
  const before = await collection.find({}).sort({ _id: 1 }).toArray();
  const expected = before.map(record => {
    const clean = { ...record };
    delete clean.editHistory;
    if (Array.isArray(clean.subItems)) {
      clean.subItems = clean.subItems.map(sub => {
        const cleanSub = { ...sub };
        delete cleanSub.editHistory;
        return cleanSub;
      });
    }
    return clean;
  });

  const parents = await collection.updateMany(
    { editHistory: { $exists: true } },
    { $unset: { editHistory: '' } }
  );
  const children = await collection.updateMany(
    { 'subItems.editHistory': { $exists: true } },
    { $unset: { 'subItems.$[].editHistory': '' } }
  );

  const after = await collection.find({}).sort({ _id: 1 }).toArray();
  assert.deepStrictEqual(after, expected, 'Unexpected change outside edit-history fields.');
  return {
    itemCount: after.length,
    parentRecordsCleaned: parents.modifiedCount,
    subItemRecordsCleaned: children.modifiedCount,
    releaseHistoryUnchanged: true,
    allOtherFieldsUnchanged: true
  };
}

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  (async () => {
    try {
      await mongoose.connect(process.env.MONGODB_URI);
      console.log(JSON.stringify(await removeEditHistory(mongoose.connection.db), null, 2));
    } catch (error) {
      console.error('Edit-history cleanup failed:', error.name);
      process.exitCode = 1;
    } finally {
      await mongoose.disconnect();
    }
  })();
}

module.exports = removeEditHistory;

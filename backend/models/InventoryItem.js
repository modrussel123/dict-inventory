const mongoose = require('mongoose');

const releaseSchema = new mongoose.Schema(
  {
    id: { type: String },
    quantity: { type: Number, required: true, min: 0 },
    date: { type: String, default: '' },
    remarks: { type: String, default: '', trim: true, maxlength: 180 },
    unitPrice: { type: Number, min: 0 },
    releasedAt: { type: Date },
    subItemId: { type: String },
    subItemName: { type: String },
    releasedSerials: { type: [String], default: [] }
  },
  { _id: false }
);

const subItemSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    serialNumber: { type: String, default: '', maxlength: 2000 },
    unitType: { type: String, default: 'pcs', trim: true, maxlength: 80 },
    quantity: { type: Number, default: 0, min: 0 },
    price: { type: Number, default: 0, min: 0 },
    soldQuantity: { type: Number, default: 0, min: 0 },
    description: { type: String, default: '', trim: true, maxlength: 500 },
    inventoryRemarks: { type: String, default: '', trim: true, maxlength: 500 },
    releaseHistory: { type: [releaseSchema], default: [] }
  },
  { _id: false }
);


const inventoryItemSchema = new mongoose.Schema(
  {
    id: { type: String, index: true },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    serialNumber: { type: String, default: '', maxlength: 2000 },
    unitType: { type: String, default: 'pcs', trim: true, maxlength: 80 },
    price: { type: Number, required: true, min: 0 },
    sortOrder: { type: Number, default: 0, index: true },
    quantity: { type: Number, required: true, min: 0, default: 0 },
    soldQuantity: { type: Number, min: 0, default: 0 },
    description: { type: String, default: '', trim: true, maxlength: 1000 },
    inventoryRemarks: { type: String, default: '', trim: true, maxlength: 500 },
    releaseDate: { type: String, default: '' },
    remarks: { type: String, default: '', trim: true, maxlength: 180 },
    releaseHistory: { type: [releaseSchema], default: [] },
    subItems: { type: [subItemSchema], default: [] }
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model('InventoryItem', inventoryItemSchema);

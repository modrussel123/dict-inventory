const mongoose = require('mongoose');

const salesSummarySchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, required: true, default: 'inventory' },
    totalSalesRevenue: { type: Number, min: 0, default: 0 }
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model('SalesSummary', salesSummarySchema);

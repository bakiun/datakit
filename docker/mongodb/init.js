// Sample data for MongoDB, run by the image on first start. Root user: root / datakit.
const shop = db.getSiblingDB('shop');

shop.customers.insertMany([
  { _id: 1, name: 'Alice K.', email: 'alice.k@example.com', tier: 'gold', joined: ISODate('2024-03-01T09:00:00Z') },
  { _id: 2, name: 'Mark Y.', email: 'm.young@example.com', tier: 'silver', joined: ISODate('2024-07-12T14:30:00Z') },
  { _id: 3, name: 'Petr N.', email: 'p.novak@example.cz', tier: 'bronze', joined: ISODate('2025-01-20T08:15:00Z') },
]);
shop.customers.createIndex({ email: 1 }, { unique: true });

shop.orders.insertMany([
  { customer: 1, status: 'paid', total: NumberDecimal('899.00'), items: [{ sku: 'TS-1024', qty: 1 }], created: ISODate('2026-10-20T10:00:00Z') },
  { customer: 2, status: 'shipped', total: NumberDecimal('299.00'), items: [{ sku: 'MG-220', qty: 2 }], created: ISODate('2026-10-21T11:30:00Z') },
  { customer: 1, status: 'pending', total: NumberDecimal('149.50'), items: [{ sku: 'MG-220', qty: 1 }], created: ISODate('2026-10-22T16:45:00Z') },
  { customer: 3, status: 'paid', total: NumberDecimal('1210.75'), items: [{ sku: 'TS-1024', qty: 1 }, { sku: 'KB-77', qty: 1 }], created: ISODate('2026-10-23T09:05:00Z') },
]);
shop.orders.createIndex({ customer: 1, created: -1 });

shop.createView('paid_orders', 'orders', [{ $match: { status: 'paid' } }]);

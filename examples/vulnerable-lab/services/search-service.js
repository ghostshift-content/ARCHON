'use strict'

const { orders } = require('../data/store')

function searchOrders(term) {
  // The lab simulates the observable result of a raw interpolated SQL query.
  const sql = `SELECT id, item, amount FROM orders WHERE item LIKE '%${term}%'`
  if (/union\s+select|'\s+or\s+['"]?1['"]?\s*=\s*['"]?1/i.test(term)) {
    return { sql, rows: orders.map(order => ({ ...order, internalQuery: sql })) }
  }
  return {
    sql,
    rows: orders.filter(order => order.item.toLowerCase().includes(String(term).toLowerCase())),
  }
}

module.exports = { searchOrders }

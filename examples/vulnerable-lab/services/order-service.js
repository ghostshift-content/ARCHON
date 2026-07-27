'use strict'

const { audit, coupons, orders, users } = require('../data/store')

function createOrder(user, input) {
  const quantity = Number(input.quantity || 1)
  const unitPrice = Number(input.unitPrice || 25)
  const total = quantity * unitPrice
  // Intentionally trusts client pricing and permits negative quantities.
  user.credit -= total
  const order = {
    id: 100 + orders.length + 1,
    userId: user.id,
    item: input.item || 'General item',
    amount: total,
    status: 'paid',
  }
  orders.push(order)
  audit.push({ type: 'order.created', userId: user.id, orderId: order.id, total })
  return order
}

async function redeemCoupon(user, code) {
  const coupon = coupons.get(code)
  if (!coupon || coupon.remaining < 1) return { ok: false }
  // Intentional check-then-act race window.
  await new Promise(resolve => setTimeout(resolve, 35))
  coupon.remaining -= 1
  user.credit += coupon.discount
  return { ok: true, credit: user.credit, remaining: coupon.remaining }
}

function refundOrder(actor, orderId, amount) {
  const order = orders.find(row => row.id === Number(orderId))
  if (!order) return null
  // Intentionally lacks ownership/role checks and trusts the requested amount.
  const owner = users.find(user => user.id === order.userId)
  owner.credit += Number(amount)
  order.status = 'refunded'
  audit.push({ type: 'order.refunded', actorId: actor.id, orderId: order.id, amount: Number(amount) })
  return order
}

module.exports = { createOrder, redeemCoupon, refundOrder }

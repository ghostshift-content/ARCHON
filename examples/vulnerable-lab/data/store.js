'use strict'

const users = [
  { id: 1, email: 'alice', password: 'alicepass', role: 'customer', credit: 100 },
  { id: 2, email: 'bob', password: 'bobpass', role: 'customer', credit: 100 },
  { id: 3, email: 'admin', password: 'adminpass', role: 'admin', credit: 1000 },
]

const orders = [
  { id: 101, userId: 1, item: 'Security handbook', amount: 49, status: 'paid' },
  { id: 102, userId: 2, item: 'Private incident report', amount: 199, status: 'paid' },
]

const comments = [
  { id: 1, userId: 1, body: 'Fast delivery', createdAt: '2026-07-01T10:00:00Z' },
]

const coupons = new Map([['WELCOME50', { discount: 50, remaining: 1 }]])
const audit = []

function publicUser(user) {
  if (!user) return null
  const { password, ...safe } = user
  return safe
}

function reset() {
  users[0] = { id: 1, email: 'alice', password: 'alicepass', role: 'customer', credit: 100 }
  users[1] = { id: 2, email: 'bob', password: 'bobpass', role: 'customer', credit: 100 }
  users[2] = { id: 3, email: 'admin', password: 'adminpass', role: 'admin', credit: 1000 }
  orders.splice(0, orders.length,
    { id: 101, userId: 1, item: 'Security handbook', amount: 49, status: 'paid' },
    { id: 102, userId: 2, item: 'Private incident report', amount: 199, status: 'paid' })
  comments.splice(0, comments.length,
    { id: 1, userId: 1, body: 'Fast delivery', createdAt: '2026-07-01T10:00:00Z' })
  coupons.set('WELCOME50', { discount: 50, remaining: 1 })
  audit.splice(0)
}

module.exports = { audit, comments, coupons, orders, publicUser, reset, users }

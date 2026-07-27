'use strict'

const { orders } = require('../data/store')
const { requireUser } = require('../middleware/auth')
const { body, json } = require('../lib/http')
const { createOrder, redeemCoupon, refundOrder } = require('../services/order-service')

function register(router) {
  router.add('GET', '/api/orders/:id', async (req, res, ctx) => {
    if (!requireUser(req, res, json)) return
    // Intentional BOLA: authenticated users can read any order.
    const order = orders.find(row => row.id === Number(ctx.params.id))
    return order ? json(res, 200, order) : json(res, 404, { error: 'not found' })
  })

  router.add('POST', '/api/orders', async (req, res) => {
    const user = requireUser(req, res, json)
    if (!user) return
    return json(res, 201, createOrder(user, await body(req)))
  })

  router.add('POST', '/api/orders/:id/refund', async (req, res, ctx) => {
    const user = requireUser(req, res, json)
    if (!user) return
    const result = refundOrder(user, ctx.params.id, (await body(req)).amount)
    return result ? json(res, 200, result) : json(res, 404, { error: 'not found' })
  })

  router.add('POST', '/api/coupons/redeem', async (req, res) => {
    const user = requireUser(req, res, json)
    if (!user) return
    const result = await redeemCoupon(user, (await body(req)).code)
    return json(res, result.ok ? 200 : 409, result)
  })
}

module.exports = { register }

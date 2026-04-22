import cors from 'cors'
import express from 'express'
import { config, getPlanId } from './config.js'
import { cancelPayPalSubscription, createPayPalSubscription, verifyWebhookSignature } from './paypal.js'
import {
  getAuthenticatedUser,
  getLatestActiveSubscriptionByUserId,
  markSubscriptionCancelledByProviderId,
  upsertSubscriptionFromEvent,
} from './supabase.js'

const app = express()

app.use(cors({ origin: '*', credentials: false }))
app.use(express.json({ limit: '1mb' }))

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'linkdm-backend' })
})

app.post('/payments/paypal/subscriptions/create', async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req)
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const tier = req.body?.tier
    const billing = req.body?.billing
    if (!['pro', 'platinum'].includes(tier)) {
      return res.status(400).json({ error: 'Invalid tier' })
    }
    if (!['monthly', 'yearly'].includes(billing)) {
      return res.status(400).json({ error: 'Invalid billing period' })
    }

    const planId = getPlanId(tier, billing)
    const successUrl = `${config.frontendUrl}/billing/success?tier=${tier}&billing=${billing}`
    const cancelUrl = `${config.frontendUrl}/billing/cancel?tier=${tier}&billing=${billing}`

    const subscription = await createPayPalSubscription({
      planId,
      userId: user.id,
      email: user.email,
      returnUrl: successUrl,
      cancelUrl,
    })

    const approveUrl = (subscription?.links || []).find(link => link.rel === 'approve')?.href
    if (!approveUrl) {
      return res.status(502).json({ error: 'PayPal approval URL missing in response' })
    }

    res.json({
      subscriptionId: subscription.id,
      approveUrl,
    })
  }
  catch (error) {
    console.error('Failed to create PayPal subscription:', error)
    res.status(500).json({
      error: error.message || 'Failed to create subscription',
      details: error.details || null,
    })
  }
})

app.post('/payments/paypal/webhook', async (req, res) => {
  try {
    const isValid = await verifyWebhookSignature(req.headers, req.body)
    if (!isValid) {
      return res.status(400).json({ error: 'Invalid webhook signature' })
    }

    await upsertSubscriptionFromEvent(req.body)
    res.status(200).json({ ok: true })
  }
  catch (error) {
    console.error('PayPal webhook error:', error)
    res.status(500).json({ error: 'Webhook handling failed' })
  }
})

app.post('/payments/paypal/subscriptions/cancel', async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req)
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const activeSubscription = await getLatestActiveSubscriptionByUserId(user.id)
    if (!activeSubscription?.provider_subscription_id) {
      return res.status(404).json({ error: 'No active subscription found for this user' })
    }

    await cancelPayPalSubscription(
      activeSubscription.provider_subscription_id,
      req.body?.reason || 'User requested cancellation',
    )
    await markSubscriptionCancelledByProviderId(activeSubscription.provider_subscription_id)

    res.status(200).json({ ok: true })
  }
  catch (error) {
    console.error('Failed to cancel PayPal subscription:', error)
    res.status(500).json({
      error: error.message || 'Failed to cancel subscription',
      details: error.details || null,
    })
  }
})

export default app

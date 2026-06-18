import cors from 'cors'

import crypto from 'node:crypto'

import express from 'express'

import { config, getPlanId } from './config.js'

import { decryptToken, encryptToken, parseSignedRequest, signState, verifyFacebookSignature, verifyState } from './crypto.js'

import {

  buildFacebookOAuthUrl,

  exchangeCodeForUserToken,

  forwardWebhookToN8n,

  getFacebookUserId,

  getUserPages,

  subscribePageToWebhooks,

  unsubscribePageFromWebhooks,

} from './facebook.js'

import {
  filterActionableMessaging,
  logFacebookInbound,
  logFacebookSkipped,
  logN8nToFacebook,
} from './messengerLog.js'

import { cancelPayPalSubscription, createPayPalSubscription, verifyWebhookSignature } from './paypal.js'

import {

  deleteFacebookConnectionByUserId,

  deleteFacebookConnectionsByFacebookUserId,

  getAuthenticatedUser,

  getFacebookConnectionByPageId,

  getFacebookConnectionsByUserId,

  getLatestActiveSubscriptionByUserId,

  markSubscriptionCancelledByProviderId,

  upsertFacebookConnection,

  upsertSubscriptionFromEvent,

} from './supabase.js'



const app = express()



async function unsubscribeRemovedFacebookConnections(connections) {

  for (const connection of connections) {

    try {

      const pageAccessToken = decryptToken(connection.page_access_token_encrypted)

      await unsubscribePageFromWebhooks(connection.page_id, pageAccessToken)

    }

    catch (unsubscribeError) {

      console.warn(`Could not unsubscribe page ${connection.page_id}:`, unsubscribeError.message)

    }

  }

}



app.use(cors({ origin: '*', credentials: false }))

app.use(express.urlencoded({ extended: false }))

app.use(express.json({

  limit: '1mb',

  verify: (req, _res, buf) => {

    if (req.originalUrl?.startsWith('/webhooks/facebook')) {

      req.rawBody = buf

    }

  },

}))



app.get('/health', (_req, res) => {

  res.json({ ok: true, service: 'linkdm-backend' })

})



app.post('/auth/facebook/connect', async (req, res) => {

  try {

    if (!config.metaFacebookAppId || !config.metaAppSecret) {

      return res.status(503).json({ error: 'Facebook integration is not configured' })

    }



    const user = await getAuthenticatedUser(req)

    if (!user) {

      return res.status(401).json({ error: 'Unauthorized' })

    }



    const state = signState({ userId: user.id, ts: Date.now() })

    const url = buildFacebookOAuthUrl(state)

    res.json({ url })

  }

  catch (error) {

    console.error('Failed to start Facebook connect:', error)

    res.status(500).json({ error: error.message || 'Failed to start Facebook connect' })

  }

})



app.get('/auth/facebook/callback', async (req, res) => {

  try {

    const { code, state, error, error_description: errorDescription } = req.query



    if (error) {

      const message = encodeURIComponent(String(errorDescription || error))

      return res.redirect(`${config.frontendUrl}/features?facebook=error&message=${message}`)

    }



    if (!code || !state) {

      return res.redirect(`${config.frontendUrl}/features?facebook=error&message=Missing%20OAuth%20parameters`)

    }



    const { userId } = verifyState(String(state))

    const userAccessToken = await exchangeCodeForUserToken(String(code))

    const facebookUserId = await getFacebookUserId(userAccessToken)

    const pages = await getUserPages(userAccessToken)



    if (!pages.length) {

      return res.redirect(`${config.frontendUrl}/features?facebook=error&message=No%20Facebook%20Pages%20found`)

    }



    const connectedPages = []

    for (const page of pages) {

      let webhookSubscribed = false

      try {

        await subscribePageToWebhooks(page.id, page.access_token)

        webhookSubscribed = true

      }

      catch (subscribeError) {

        console.error(`Failed to subscribe page ${page.id} to webhooks:`, subscribeError.message)

      }



      await upsertFacebookConnection({

        userId,

        facebookUserId,

        pageId: page.id,

        pageName: page.name,

        encryptedToken: encryptToken(page.access_token),

        webhookSubscribed,

      })

      connectedPages.push(page.name)

    }



    const names = encodeURIComponent(connectedPages.join(', '))

    res.redirect(`${config.frontendUrl}/features?facebook=connected&pages=${names}`)

  }

  catch (callbackError) {

    console.error('Facebook OAuth callback failed:', callbackError)

    const message = encodeURIComponent(callbackError.message || 'Facebook connect failed')

    res.redirect(`${config.frontendUrl}/features?facebook=error&message=${message}`)

  }

})



app.get('/auth/facebook/status', async (req, res) => {

  try {

    const user = await getAuthenticatedUser(req)

    if (!user) {

      return res.status(401).json({ error: 'Unauthorized' })

    }



    const connections = await getFacebookConnectionsByUserId(user.id)

    res.json({

      connected: connections.length > 0,

      connections,

    })

  }

  catch (error) {

    console.error('Failed to fetch Facebook status:', error)

    res.status(500).json({ error: error.message || 'Failed to fetch Facebook status' })

  }

})



app.delete('/auth/facebook/disconnect', async (req, res) => {

  try {

    const user = await getAuthenticatedUser(req)

    if (!user) {

      return res.status(401).json({ error: 'Unauthorized' })

    }



    const pageId = req.body?.pageId || null

    const removed = await deleteFacebookConnectionByUserId(user.id, pageId)



    await unsubscribeRemovedFacebookConnections(removed)



    res.json({ ok: true, removed: removed.map(item => item.page_id) })

  }

  catch (error) {

    console.error('Failed to disconnect Facebook:', error)

    res.status(500).json({ error: error.message || 'Failed to disconnect Facebook' })

  }

})



app.get('/webhooks/facebook', (req, res) => {

  const mode = req.query['hub.mode']

  const token = req.query['hub.verify_token']

  const challenge = req.query['hub.challenge']



  if (mode === 'subscribe' && token === config.metaWebhookVerifyToken) {

    return res.status(200).send(challenge)

  }



  return res.sendStatus(403)

})



app.post('/webhooks/facebook/data-deletion', async (req, res) => {

  try {

    if (!config.metaAppSecret) {

      return res.status(503).json({ error: 'Facebook integration is not configured' })

    }



    const signedRequest = req.body?.signed_request

    if (!signedRequest) {

      return res.status(400).json({ error: 'Missing signed_request' })

    }



    const data = parseSignedRequest(String(signedRequest))

    if (!data) {

      return res.status(403).json({ error: 'Invalid signed_request' })

    }



    const facebookUserId = String(data.user_id)

    const confirmationCode = crypto.randomBytes(16).toString('hex')



    console.log(`[Meta] Data deletion request for Facebook user ${facebookUserId}`)



    const removed = await deleteFacebookConnectionsByFacebookUserId(facebookUserId)

    await unsubscribeRemovedFacebookConnections(removed)



    res.json({

      url: `${config.frontendUrl}/data-deletion-status?code=${confirmationCode}`,

      confirmation_code: confirmationCode,

    })

  }

  catch (error) {

    console.error('Facebook data deletion callback failed:', error)

    res.status(500).json({ error: error.message || 'Data deletion failed' })

  }

})



app.post('/log/facebook/outbound', (req, res) => {
  logN8nToFacebook({
    page_id: req.body?.page_id,
    recipient_id: req.body?.recipient_id,
    message_text: req.body?.message_text,
    postback_payload: req.body?.postback_payload,
    template: req.body?.template,
    graph_status: req.body?.graph_status,
    graph_response: req.body?.graph_response,
    graph_error: req.body?.graph_error,
    page_access_token: req.body?.page_access_token,
    node_name: req.body?.node_name,
  })
  res.status(200).json({ ok: true })
})



app.post('/webhooks/facebook', async (req, res) => {

  try {

    const signature = req.headers['x-hub-signature-256']

    if (config.metaAppSecret && req.rawBody) {

      const isValid = verifyFacebookSignature(req.rawBody, signature)

      if (!isValid) {

        console.warn('[FB → Backend] Webhook signature verification failed')

        return res.sendStatus(403)

      }

    }



    const body = req.body

    if (body?.object !== 'page') {

      return res.sendStatus(404)

    }



    logFacebookInbound(body)



    res.status(200).send('EVENT_RECEIVED')



    const entries = body.entry || []

    for (const entry of entries) {

      const pageId = entry.id

      const connection = await getFacebookConnectionByPageId(pageId)

      if (!connection) {

        console.warn(`No Linkora connection found for Facebook page ${pageId}`)

        continue

      }



      let pageAccessToken = null

      try {

        pageAccessToken = decryptToken(connection.page_access_token_encrypted)

      }

      catch (decryptError) {

        console.error(`Failed to decrypt token for page ${pageId}:`, decryptError.message)

        continue

      }



      const actionableMessaging = filterActionableMessaging(entry.messaging || [])

      if (actionableMessaging.length === 0) {

        logFacebookSkipped(pageId, (entry.messaging || []).length)

        continue

      }



      const filteredEntry = { ...entry, messaging: actionableMessaging }

      const filteredBody = {

        ...body,

        entry: (body.entry || []).map(e =>

          e.id === pageId ? { ...e, messaging: actionableMessaging } : e,

        ),

      }



      await forwardWebhookToN8n({

        body: filteredBody,

        entry: filteredEntry,

        page_id: pageId,

        page_name: connection.page_name,

        linkora_user_id: connection.user_id,

        page_access_token: pageAccessToken,

      })

    }

  }

  catch (error) {

    console.error('Facebook webhook error:', error)

    if (!res.headersSent) {

      res.status(500).json({ error: 'Webhook handling failed' })

    }

  }

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



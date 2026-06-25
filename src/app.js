import cors from 'cors'

import crypto from 'node:crypto'

import express from 'express'

import { config, getPlanId } from './config.js'

import { decryptToken, encryptToken, parseSignedRequest, signState, verifyFacebookSignature, verifyState } from './crypto.js'

import {

  buildFacebookOAuthUrl,

  exchangeCodeForUserToken,

  forwardWebhookToN8n as forwardFacebookWebhookToN8n,

  getFacebookUserId,

  getUserPages,

  subscribePageToWebhooks,

  unsubscribePageFromWebhooks,

} from './facebook.js'

import {

  buildWhatsAppOAuthUrl,

  exchangeWhatsAppCodeForUserToken,

  extractWhatsAppWebhookEvents,

  forwardWebhookToN8n as forwardWhatsAppWebhookToN8n,

  getMetaUserId,

  getUserWhatsAppPhoneNumbers,

} from './whatsapp.js'

import {
  filterActionableMessaging,
  filterActionableWhatsAppChanges,
  isActionableWhatsAppValue,
  logFacebookInbound,
  logFacebookSkipped,
  logN8nToFacebook,
  logN8nToWhatsApp,
  logWhatsAppInbound,
  logWhatsAppSkipped,
} from './messengerLog.js'

import { cancelPayPalSubscription, createPayPalSubscription, verifyWebhookSignature } from './paypal.js'

import {

  deleteFacebookConnectionByUserId,

  deleteFacebookConnectionsByFacebookUserId,

  deleteWhatsAppConnectionByUserId,

  deleteWhatsAppConnectionsByMetaUserId,

  getAuthenticatedUser,

  getFacebookConnectionByPageId,

  getFacebookConnectionsByUserId,

  getLatestActiveSubscriptionByUserId,

  getWhatsAppConnectionByPhoneNumberId,

  getWhatsAppConnectionsByUserId,

  markSubscriptionCancelledByProviderId,

  upsertFacebookConnection,

  upsertSubscriptionFromEvent,

  upsertWhatsAppConnection,

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

    if (req.originalUrl?.startsWith('/webhooks/facebook') || req.originalUrl?.startsWith('/webhooks/whatsapp')) {

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

    await deleteWhatsAppConnectionsByMetaUserId(facebookUserId)



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



      await forwardFacebookWebhookToN8n({

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



app.post('/auth/whatsapp/connect', async (req, res) => {

  try {

    if (!config.metaFacebookAppId || !config.metaAppSecret) {

      return res.status(503).json({ error: 'WhatsApp integration is not configured' })

    }



    const user = await getAuthenticatedUser(req)

    if (!user) {

      return res.status(401).json({ error: 'Unauthorized' })

    }



    const state = signState({ userId: user.id, ts: Date.now() })

    const url = buildWhatsAppOAuthUrl(state)

    res.json({ url })

  }

  catch (error) {

    console.error('Failed to start WhatsApp connect:', error)

    res.status(500).json({ error: error.message || 'Failed to start WhatsApp connect' })

  }

})



app.get('/auth/whatsapp/callback', async (req, res) => {

  try {

    const { code, state, error, error_description: errorDescription } = req.query



    if (error) {

      const message = encodeURIComponent(String(errorDescription || error))

      return res.redirect(`${config.frontendUrl}/features?whatsapp=error&message=${message}`)

    }



    if (!code || !state) {

      return res.redirect(`${config.frontendUrl}/features?whatsapp=error&message=Missing%20OAuth%20parameters`)

    }



    const { userId } = verifyState(String(state))

    const userAccessToken = await exchangeWhatsAppCodeForUserToken(String(code))

    const metaUserId = await getMetaUserId(userAccessToken)

    const phoneNumbers = await getUserWhatsAppPhoneNumbers(userAccessToken)



    if (!phoneNumbers.length) {

      return res.redirect(`${config.frontendUrl}/features?whatsapp=error&message=No%20WhatsApp%20phone%20numbers%20found`)

    }



    const connectedNumbers = []

    for (const phone of phoneNumbers) {

      await upsertWhatsAppConnection({

        userId,

        metaUserId,

        wabaId: phone.wabaId,

        wabaName: phone.wabaName,

        phoneNumberId: phone.phoneNumberId,

        displayPhoneNumber: phone.displayPhoneNumber,

        verifiedName: phone.verifiedName,

        encryptedToken: encryptToken(userAccessToken),

        webhookSubscribed: true,

      })

      connectedNumbers.push(phone.displayPhoneNumber || phone.verifiedName || phone.phoneNumberId)

    }



    const names = encodeURIComponent(connectedNumbers.join(', '))

    res.redirect(`${config.frontendUrl}/features?whatsapp=connected&numbers=${names}`)

  }

  catch (callbackError) {

    console.error('WhatsApp OAuth callback failed:', callbackError)

    const message = encodeURIComponent(callbackError.message || 'WhatsApp connect failed')

    res.redirect(`${config.frontendUrl}/features?whatsapp=error&message=${message}`)

  }

})



app.get('/auth/whatsapp/status', async (req, res) => {

  try {

    const user = await getAuthenticatedUser(req)

    if (!user) {

      return res.status(401).json({ error: 'Unauthorized' })

    }



    const connections = await getWhatsAppConnectionsByUserId(user.id)

    res.json({

      connected: connections.length > 0,

      connections,

    })

  }

  catch (error) {

    console.error('Failed to fetch WhatsApp status:', error)

    res.status(500).json({ error: error.message || 'Failed to fetch WhatsApp status' })

  }

})



app.delete('/auth/whatsapp/disconnect', async (req, res) => {

  try {

    const user = await getAuthenticatedUser(req)

    if (!user) {

      return res.status(401).json({ error: 'Unauthorized' })

    }



    const phoneNumberId = req.body?.phoneNumberId || null

    const removed = await deleteWhatsAppConnectionByUserId(user.id, phoneNumberId)



    res.json({ ok: true, removed: removed.map(item => item.phone_number_id) })

  }

  catch (error) {

    console.error('Failed to disconnect WhatsApp:', error)

    res.status(500).json({ error: error.message || 'Failed to disconnect WhatsApp' })

  }

})



app.get('/webhooks/whatsapp', (req, res) => {

  const mode = req.query['hub.mode']

  const token = req.query['hub.verify_token']

  const challenge = req.query['hub.challenge']



  if (mode === 'subscribe' && token === config.metaWebhookVerifyToken) {

    return res.status(200).send(challenge)

  }



  return res.sendStatus(403)

})



app.post('/log/whatsapp/outbound', (req, res) => {
  logN8nToWhatsApp({
    phone_number_id: req.body?.phone_number_id,
    recipient_id: req.body?.recipient_id,
    message_text: req.body?.message_text,
    template: req.body?.template,
    graph_status: req.body?.graph_status,
    graph_response: req.body?.graph_response,
    graph_error: req.body?.graph_error,
    access_token: req.body?.access_token,
    node_name: req.body?.node_name,
  })
  res.status(200).json({ ok: true })
})



app.post('/webhooks/whatsapp', async (req, res) => {

  try {

    const signature = req.headers['x-hub-signature-256']

    if (config.metaAppSecret && req.rawBody) {

      const isValid = verifyFacebookSignature(req.rawBody, signature)

      if (!isValid) {

        console.warn('[WA → Backend] Webhook signature verification failed')

        return res.sendStatus(403)

      }

    }



    const body = req.body

    if (body?.object !== 'whatsapp_business_account') {

      return res.sendStatus(404)

    }



    logWhatsAppInbound(body)



    res.status(200).send('EVENT_RECEIVED')



    const webhookEvents = extractWhatsAppWebhookEvents(body)

    for (const event of webhookEvents) {

      const phoneNumberId = event.phoneNumberId

      const connection = await getWhatsAppConnectionByPhoneNumberId(phoneNumberId)

      if (!connection) {

        console.warn(`No Linkora connection found for WhatsApp phone number ${phoneNumberId}`)

        continue

      }



      if (!isActionableWhatsAppValue(event.value)) {

        logWhatsAppSkipped(phoneNumberId, 1)

        continue

      }



      let accessToken = null

      try {

        accessToken = decryptToken(connection.access_token_encrypted)

      }

      catch (decryptError) {

        console.error(`Failed to decrypt token for phone ${phoneNumberId}:`, decryptError.message)

        continue

      }



      const actionableChanges = filterActionableWhatsAppChanges(event.entry.changes || [])

      const filteredEntry = {

        ...event.entry,

        changes: actionableChanges.length > 0 ? actionableChanges : [event.change],

      }

      const filteredBody = {

        ...body,

        entry: (body.entry || []).map(e =>

          e.id === event.wabaId ? filteredEntry : e,

        ),

      }



      await forwardWhatsAppWebhookToN8n({

        body: filteredBody,

        phone_number_id: phoneNumberId,

        display_phone_number: connection.display_phone_number || event.displayPhoneNumber,

        waba_id: connection.waba_id,

        waba_name: connection.waba_name,

        linkora_user_id: connection.user_id,

        access_token: accessToken,

        messaging_product: 'whatsapp',

        metadata: event.value.metadata,

        messages: event.value.messages,

      })

    }

  }

  catch (error) {

    console.error('WhatsApp webhook error:', error)

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



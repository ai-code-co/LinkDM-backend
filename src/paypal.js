import { config } from './config.js'

function basicAuthHeader(clientId, clientSecret) {
  const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  return `Basic ${encoded}`
}

async function paypalFetch(path, options = {}) {
  const response = await fetch(`${config.paypalBaseUrl}${path}`, options)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = data?.message || data?.error_description || 'PayPal API request failed'
    const error = new Error(message)
    error.details = data
    throw error
  }
  return data
}

export async function getPayPalAccessToken() {
  const body = new URLSearchParams({ grant_type: 'client_credentials' })
  const data = await paypalFetch('/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(config.paypalClientId, config.paypalClientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  })
  return data.access_token
}

export async function createPayPalSubscription({
  planId,
  userId,
  email,
  returnUrl,
  cancelUrl,
}) {
  const accessToken = await getPayPalAccessToken()
  return paypalFetch('/v1/billing/subscriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      plan_id: planId,
      custom_id: userId,
      subscriber: email ? { email_address: email } : undefined,
      application_context: {
        brand_name: 'LinkDM',
        user_action: 'SUBSCRIBE_NOW',
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
    }),
  })
}

export async function cancelPayPalSubscription(subscriptionId, reason = 'User requested cancellation') {
  const accessToken = await getPayPalAccessToken()
  const response = await fetch(`${config.paypalBaseUrl}/v1/billing/subscriptions/${subscriptionId}/cancel`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ reason }),
  })

  
  if (response.status === 204) return

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = data?.message || data?.error_description || 'Failed to cancel PayPal subscription'
    const error = new Error(message)
    error.details = data
    throw error
  }
}

export async function verifyWebhookSignature(headers, eventBody) {
  if (!config.paypalWebhookId) {
    console.warn('PAYPAL_WEBHOOK_ID is not set. Skipping webhook signature verification.')
    return true
  }

  const accessToken = await getPayPalAccessToken()
  const verification = await paypalFetch('/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: config.paypalWebhookId,
      webhook_event: eventBody,
    }),
  })

  return verification.verification_status === 'SUCCESS'
}

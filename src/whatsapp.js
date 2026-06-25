import { config } from './config.js'
import { exchangeCodeForUserToken, getFacebookUserId } from './facebook.js'
import { logN8nForwardResult, logWhatsAppToN8n } from './messengerLog.js'

const GRAPH_BASE = `https://graph.facebook.com/${config.metaGraphApiVersion}`

const OAUTH_SCOPES = [
  'whatsapp_business_management',
  'whatsapp_business_messaging',
  'business_management',
].join(',')

async function graphGet(path, params = {}) {
  const url = new URL(`${GRAPH_BASE}${path}`)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value))
    }
  }
  const response = await fetch(url)
  const data = await response.json()
  if (!response.ok) {
    const message = data?.error?.message || `Graph API GET failed (${response.status})`
    const error = new Error(message)
    error.details = data?.error || null
    throw error
  }
  return data
}

export function buildWhatsAppOAuthUrl(state) {
  const url = new URL(`https://www.facebook.com/${config.metaGraphApiVersion}/dialog/oauth`)
  url.searchParams.set('client_id', config.metaFacebookAppId)
  url.searchParams.set('redirect_uri', config.metaWhatsAppRedirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('scope', OAUTH_SCOPES)
  url.searchParams.set('response_type', 'code')
  return url.toString()
}

export async function exchangeWhatsAppCodeForUserToken(code) {
  return exchangeCodeForUserToken(code, config.metaWhatsAppRedirectUri)
}

export { getFacebookUserId as getMetaUserId }

async function getWabasForBusiness(businessId, userAccessToken, relation) {
  const data = await graphGet(`/${businessId}/${relation}`, {
    access_token: userAccessToken,
    fields: 'id,name',
  })
  return data.data || []
}

export async function getUserWhatsAppPhoneNumbers(userAccessToken) {
  const businessesData = await graphGet('/me/businesses', {
    access_token: userAccessToken,
    fields: 'id,name',
  })
  const businesses = businessesData.data || []
  const results = []
  const seenPhoneIds = new Set()

  for (const business of businesses) {
    const wabas = [
      ...(await getWabasForBusiness(business.id, userAccessToken, 'owned_whatsapp_business_accounts')),
      ...(await getWabasForBusiness(business.id, userAccessToken, 'client_whatsapp_business_accounts')),
    ]

    for (const waba of wabas) {
      const phonesData = await graphGet(`/${waba.id}/phone_numbers`, {
        access_token: userAccessToken,
        fields: 'id,display_phone_number,verified_name',
      })

      for (const phone of phonesData.data || []) {
        if (seenPhoneIds.has(phone.id)) continue
        seenPhoneIds.add(phone.id)

        results.push({
          wabaId: waba.id,
          wabaName: waba.name || business.name,
          phoneNumberId: phone.id,
          displayPhoneNumber: phone.display_phone_number,
          verifiedName: phone.verified_name,
        })
      }
    }
  }

  return results
}

export function extractWhatsAppWebhookEvents(body) {
  const events = []
  if (body?.object !== 'whatsapp_business_account') {
    return events
  }

  for (const entry of body.entry || []) {
    const wabaId = entry.id
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue
      const value = change.value
      if (!value?.metadata?.phone_number_id) continue

      events.push({
        wabaId,
        phoneNumberId: value.metadata.phone_number_id,
        displayPhoneNumber: value.metadata.display_phone_number,
        value,
        entry,
        change,
      })
    }
  }

  return events
}

export async function forwardWebhookToN8n(payload) {
  if (!config.n8nWhatsAppWebhookUrl) {
    console.warn('N8N_WHATSAPP_WEBHOOK_URL is not configured. Skipping forward.')
    return
  }

  const messages = payload.messages || []
  logWhatsAppToN8n({
    phoneNumberId: payload.phone_number_id,
    displayPhoneNumber: payload.display_phone_number,
    linkoraUserId: payload.linkora_user_id,
    messageCount: messages.length,
    n8nUrl: config.n8nWhatsAppWebhookUrl,
  })

  const response = await fetch(config.n8nWhatsAppWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const text = await response.text()
    logN8nForwardResult({
      pageId: payload.phone_number_id,
      status: response.status,
      ok: false,
      error: text,
    })
    throw new Error(`n8n WhatsApp webhook forward failed (${response.status}): ${text}`)
  }

  logN8nForwardResult({
    pageId: payload.phone_number_id,
    status: response.status,
    ok: true,
  })
}

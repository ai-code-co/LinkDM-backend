import { config } from './config.js'
import { logFacebookToN8n, logN8nForwardResult } from './messengerLog.js'

const GRAPH_BASE = `https://graph.facebook.com/${config.metaGraphApiVersion}`

const OAUTH_SCOPES = [
  'pages_show_list',
  'pages_messaging',
  'pages_manage_metadata',
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

async function graphPost(path, params = {}) {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      body.set(key, String(value))
    }
  }
  const response = await fetch(`${GRAPH_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const data = await response.json()
  if (!response.ok) {
    const message = data?.error?.message || `Graph API POST failed (${response.status})`
    const error = new Error(message)
    error.details = data?.error || null
    throw error
  }
  return data
}

export function buildFacebookOAuthUrl(state) {
  const url = new URL(`https://www.facebook.com/${config.metaGraphApiVersion}/dialog/oauth`)
  url.searchParams.set('client_id', config.metaFacebookAppId)
  url.searchParams.set('redirect_uri', config.metaRedirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('scope', OAUTH_SCOPES)
  url.searchParams.set('response_type', 'code')
  return url.toString()
}

export async function exchangeCodeForUserToken(code, redirectUri = config.metaRedirectUri) {
  const shortLived = await graphGet('/oauth/access_token', {
    client_id: config.metaFacebookAppId,
    client_secret: config.metaAppSecret,
    redirect_uri: redirectUri,
    code,
  })

  const longLived = await graphGet('/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: config.metaFacebookAppId,
    client_secret: config.metaAppSecret,
    fb_exchange_token: shortLived.access_token,
  })

  return longLived.access_token
}

export async function getFacebookUserId(userAccessToken) {
  const data = await graphGet('/me', {
    access_token: userAccessToken,
    fields: 'id',
  })
  return data.id
}

export async function getUserPages(userAccessToken) {
  const data = await graphGet('/me/accounts', {
    access_token: userAccessToken,
    fields: 'id,name,access_token',
  })
  return data.data || []
}

export async function subscribePageToWebhooks(pageId, pageAccessToken) {
  return graphPost(`/${pageId}/subscribed_apps`, {
    subscribed_fields: 'messages,messaging_postbacks,message_reads',
    access_token: pageAccessToken,
  })
}

export async function unsubscribePageFromWebhooks(pageId, pageAccessToken) {
  const url = new URL(`${GRAPH_BASE}/${pageId}/subscribed_apps`)
  url.searchParams.set('access_token', pageAccessToken)
  const response = await fetch(url, { method: 'DELETE' })
  const data = await response.json()
  if (!response.ok) {
    const message = data?.error?.message || `Graph API DELETE failed (${response.status})`
    const error = new Error(message)
    error.details = data?.error || null
    throw error
  }
  return data
}

export async function forwardWebhookToN8n(payload) {
  if (!config.n8nFacebookWebhookUrl) {
    console.warn('N8N_FACEBOOK_WEBHOOK_URL is not configured. Skipping forward.')
    return
  }

  const events = []
  const entry = payload.entry
  const messagingList = entry?.messaging || payload.body?.entry?.find(e => e.id === payload.page_id)?.messaging || []
  for (const messaging of messagingList) {
    events.push({
      sender_id: messaging.sender?.id,
      text: messaging.message?.text,
      postback: messaging.postback?.payload,
      quick_reply: messaging.message?.quick_reply?.payload,
    })
  }

  logFacebookToN8n({
    pageId: payload.page_id,
    pageName: payload.page_name,
    linkoraUserId: payload.linkora_user_id,
    events,
    n8nUrl: config.n8nFacebookWebhookUrl,
  })

  const response = await fetch(config.n8nFacebookWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const text = await response.text()
    logN8nForwardResult({
      pageId: payload.page_id,
      status: response.status,
      ok: false,
      error: text,
    })
    throw new Error(`n8n webhook forward failed (${response.status}): ${text}`)
  }

  logN8nForwardResult({
    pageId: payload.page_id,
    status: response.status,
    ok: true,
  })
}

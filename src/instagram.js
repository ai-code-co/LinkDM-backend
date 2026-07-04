import { config } from './config.js'
import {
  exchangeCodeForUserToken,
  getFacebookUserId,
  unsubscribePageFromWebhooks,
} from './facebook.js'
import { logInstagramToN8n, logN8nForwardResult } from './messengerLog.js'
import {
  getInstagramConnectionByIgId,
  getInstagramConnectionByPageId,
} from './supabase.js'

const GRAPH_BASE = `https://graph.facebook.com/${config.metaGraphApiVersion}`

const OAUTH_SCOPES = [
  'instagram_basic',
  'instagram_manage_messages',
  'pages_messaging',
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_metadata',
  'business_management',
].join(',')

export function isInstagramMessagingWebhook(body) {
  return body?.object === 'page' || body?.object === 'instagram'
}

export async function resolveInstagramConnection(entry) {
  if (entry?.id) {
    const byIgId = await getInstagramConnectionByIgId(entry.id)
    if (byIgId) return byIgId

    const byPageId = await getInstagramConnectionByPageId(entry.id)
    if (byPageId) return byPageId
  }

  for (const messaging of entry?.messaging || []) {
    const recipientId = messaging.recipient?.id
    if (!recipientId) continue

    const byRecipientIgId = await getInstagramConnectionByIgId(recipientId)
    if (byRecipientIgId) return byRecipientIgId

    const byRecipientPageId = await getInstagramConnectionByPageId(recipientId)
    if (byRecipientPageId) return byRecipientPageId
  }

  return null
}

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

export function buildInstagramOAuthUrl(state) {
  const url = new URL(`https://www.facebook.com/${config.metaGraphApiVersion}/dialog/oauth`)
  url.searchParams.set('client_id', config.metaFacebookAppId)
  url.searchParams.set('redirect_uri', config.metaInstagramRedirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('scope', OAUTH_SCOPES)
  url.searchParams.set('response_type', 'code')
  return url.toString()
}

export async function exchangeInstagramCodeForUserToken(code) {
  return exchangeCodeForUserToken(code, config.metaInstagramRedirectUri)
}

export { getFacebookUserId, unsubscribePageFromWebhooks }

export async function getUserPagesWithInstagram(userAccessToken) {
  const pagesData = await graphGet('/me/accounts', {
    access_token: userAccessToken,
    fields: 'id,name,access_token',
  })
  const pages = pagesData.data || []
  const results = []
  const seenIgIds = new Set()

  for (const page of pages) {
    const pageData = await graphGet(`/${page.id}`, {
      access_token: page.access_token,
      fields: 'instagram_business_account{id,username}',
    })

    const ig = pageData.instagram_business_account
    if (!ig?.id) continue
    if (seenIgIds.has(ig.id)) continue
    seenIgIds.add(ig.id)

    results.push({
      pageId: page.id,
      pageName: page.name,
      pageAccessToken: page.access_token,
      instagramBusinessAccountId: ig.id,
      instagramUsername: ig.username || null,
    })
  }

  return results
}

export async function subscribePageToInstagramWebhooks(pageId, pageAccessToken) {
  return graphPost(`/${pageId}/subscribed_apps`, {
    subscribed_fields: 'messages,messaging_postbacks,messaging_optins',
    access_token: pageAccessToken,
  })
}

export async function forwardWebhookToN8n(payload) {
  if (!config.n8nInstagramWebhookUrl) {
    console.warn('N8N_INSTAGRAM_WEBHOOK_URL is not configured. Skipping forward.')
    return
  }

  const events = []
  const entry = payload.entry
  const messagingList = entry?.messaging
    || payload.body?.entry?.find(e => e.id === payload.page_id)?.messaging
    || []
  for (const messaging of messagingList) {
    events.push({
      sender_id: messaging.sender?.id,
      text: messaging.message?.text,
      postback: messaging.postback?.payload,
      quick_reply: messaging.message?.quick_reply?.payload,
    })
  }

  logInstagramToN8n({
    pageId: payload.page_id,
    instagramBusinessAccountId: payload.instagram_business_account_id,
    instagramUsername: payload.instagram_username,
    linkoraUserId: payload.linkora_user_id,
    events,
    n8nUrl: config.n8nInstagramWebhookUrl,
  })

  const response = await fetch(config.n8nInstagramWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const text = await response.text()
    logN8nForwardResult({
      pageId: payload.instagram_business_account_id || payload.page_id,
      status: response.status,
      ok: false,
      error: text,
    })
    throw new Error(`n8n Instagram webhook forward failed (${response.status}): ${text}`)
  }

  logN8nForwardResult({
    pageId: payload.instagram_business_account_id || payload.page_id,
    status: response.status,
    ok: true,
  })
}

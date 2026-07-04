/** User text, postbacks, and quick replies — not read/delivery/echo. */
export function isActionableMessagingEvent(messaging) {
  if (messaging.message?.is_echo) return false
  if (messaging.read) return false
  if (messaging.delivery) return false
  if (messaging.postback?.payload) return true
  if (messaging.message?.quick_reply?.payload) return true
  if (messaging.message?.text) return true
  return false
}

export function filterActionableMessaging(messagingList = []) {
  return messagingList.filter(isActionableMessagingEvent)
}

/** Instagram comment change events (field === 'comments'), used for Comment-to-DM automation. */
export function filterInstagramCommentChanges(changes = []) {
  return changes.filter(change => change.field === 'comments' && change.value)
}

export function logFacebookSkipped(_pageId, _skippedCount) {}

export function summarizeMessagingEvents(body) {
  const events = []
  for (const entry of body?.entry || []) {
    for (const messaging of entry.messaging || []) {
      const text = messaging.message?.text || ''
      const postback = messaging.postback?.payload || ''
      const quickReply = messaging.message?.quick_reply?.payload || ''
      let eventType = 'other'
      if (messaging.postback) eventType = 'postback'
      else if (messaging.message?.quick_reply) eventType = 'quick_reply'
      else if (text) eventType = 'text'
      else if (messaging.read) eventType = 'read'
      else if (messaging.delivery) eventType = 'delivery'

      events.push({
        page_id: entry.id,
        sender_id: messaging.sender?.id,
        recipient_id: messaging.recipient?.id,
        event_type: eventType,
        text: text || undefined,
        postback: postback || undefined,
        quick_reply: quickReply || undefined,
        is_echo: messaging.message?.is_echo || false,
        timestamp: messaging.timestamp,
      })
    }
  }
  return events
}

export function logFacebookInbound(body) {
  return summarizeMessagingEvents(body)
}

export function logFacebookToN8n(_payload) {}

export function logInstagramInbound(body) {
  return summarizeMessagingEvents(body)
}

export function logInstagramSkipped(_igId, _skippedCount) {}

export function logInstagramToN8n(_payload) {}

export function logN8nForwardResult({ pageId, status, ok, error }) {
  if (!ok) {
    console.error('[FB → n8n] Forward FAILED:', JSON.stringify({ page_id: pageId, status, error }, null, 2))
  }
}

export function isActionableWhatsAppValue(value) {
  if (!value?.messages?.length) return false
  return value.messages.some(message => message.type && message.type !== 'unsupported')
}

export function filterActionableWhatsAppChanges(changes = []) {
  return changes.filter(change => change.field === 'messages' && isActionableWhatsAppValue(change.value))
}

export function logWhatsAppInbound(_body) {}

export function logWhatsAppSkipped(_phoneNumberId, _skippedCount) {}

export function logWhatsAppToN8n(_payload) {}

export function logN8nToWhatsApp(_payload) {}

export function logN8nToFacebook(_payload) {}

export function logN8nToInstagram(_payload) {}

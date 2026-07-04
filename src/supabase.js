import { createClient } from '@supabase/supabase-js'
import { config } from './config.js'

const authClient =
  config.supabaseUrl && config.supabaseAnonKey
    ? createClient(config.supabaseUrl, config.supabaseAnonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null

const adminClient =
  config.supabaseUrl && config.supabaseServiceRoleKey
    ? createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null

export async function getAuthenticatedUser(req) {
  if (!authClient) {
    throw new Error('Supabase auth is not configured on backend.')
  }

  const authorization = req.headers.authorization || ''
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  if (!token) return null

  const { data, error } = await authClient.auth.getUser(token)
  if (error) return null
  return data?.user || null
}

function toStatus(eventType, resourceStatus) {
  if (eventType === 'BILLING.SUBSCRIPTION.ACTIVATED') return 'active'
  if (eventType === 'BILLING.SUBSCRIPTION.CANCELLED') return 'cancelled'
  if (eventType === 'BILLING.SUBSCRIPTION.SUSPENDED') return 'suspended'
  return (resourceStatus || 'pending').toLowerCase()
}

function resolvePlanFromCode(planCode) {
  if (!planCode) {
    return { planTier: 'free', planName: 'Free' }
  }

  const isPro = [config.planIds.pro.monthly, config.planIds.pro.yearly]
    .filter(Boolean)
    .includes(planCode)
  if (isPro) {
    return { planTier: 'pro', planName: 'Pro' }
  }

  const isPlatinum = [config.planIds.platinum.monthly, config.planIds.platinum.yearly]
    .filter(Boolean)
    .includes(planCode)
  if (isPlatinum) {
    return { planTier: 'platinum', planName: 'Platinum' }
  }

  return { planTier: 'free', planName: 'Free' }
}

export async function upsertSubscriptionFromEvent(event) {
  if (!adminClient) {
    console.warn('Supabase service role is not configured. Skipping DB write for webhook.')
    return
  }

  const resource = event?.resource || {}
  const subscriptionId = resource?.id
  if (!subscriptionId) return
  const planCode = resource?.plan_id || null
  const status = toStatus(event?.event_type, resource?.status)
  const { planTier: resolvedTier, planName: resolvedName } = resolvePlanFromCode(planCode)
  const isActive = status === 'active'

  const payload = {
    provider: 'paypal',
    provider_subscription_id: subscriptionId,
    user_id: resource?.custom_id || null,
    plan_code: planCode,
    plan_tier: isActive ? resolvedTier : 'free',
    plan_name: isActive ? resolvedName : 'Free',
    status,
    raw_event: event,
    updated_at: new Date().toISOString(),
  }

  const { error } = await adminClient
    .from('subscriptions')
    .upsert(payload, { onConflict: 'provider_subscription_id' })

  if (error) {
    console.error('Failed to upsert subscription webhook event:', error.message)
  }
}

export async function getLatestActiveSubscriptionByUserId(userId) {
  if (!adminClient) {
    throw new Error('Supabase service role is not configured.')
  }

  const { data, error } = await adminClient
    .from('subscriptions')
    .select('provider_subscription_id,status')
    .eq('user_id', userId)
    .eq('provider', 'paypal')
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to fetch active subscription: ${error.message}`)
  }

  return data ?? null
}

export async function deleteSubscriptionByProviderId(providerSubscriptionId) {
  if (!adminClient) {
    throw new Error('Supabase service role is not configured.')
  }

  const { error } = await adminClient
    .from('subscriptions')
    .delete()
    .eq('provider_subscription_id', providerSubscriptionId)

  if (error) {
    throw new Error(`Failed to delete subscription: ${error.message}`)
  }
}

export async function markSubscriptionCancelledByProviderId(providerSubscriptionId) {
  if (!adminClient) {
    throw new Error('Supabase service role is not configured.')
  }

  const { error } = await adminClient
    .from('subscriptions')
    .update({
      status: 'cancelled',
      plan_tier: 'free',
      plan_name: 'Free',
      updated_at: new Date().toISOString(),
    })
    .eq('provider_subscription_id', providerSubscriptionId)

  if (error) {
    throw new Error(`Failed to update cancelled subscription: ${error.message}`)
  }
}

export async function upsertFacebookConnection({
  userId,
  facebookUserId,
  pageId,
  pageName,
  encryptedToken,
  webhookSubscribed,
}) {
  if (!adminClient) {
    throw new Error('Supabase service role is not configured.')
  }

  const { data, error } = await adminClient
    .from('facebook_connections')
    .upsert(
      {
        user_id: userId,
        facebook_user_id: facebookUserId,
        page_id: pageId,
        page_name: pageName,
        page_access_token_encrypted: encryptedToken,
        webhook_subscribed: webhookSubscribed,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,page_id' },
    )
    .select('id,user_id,page_id,page_name,webhook_subscribed,created_at,updated_at')
    .single()

  if (error) {
    throw new Error(`Failed to save Facebook connection: ${error.message}`)
  }

  return data
}

export async function getFacebookConnectionsByUserId(userId) {
  if (!adminClient) {
    throw new Error('Supabase service role is not configured.')
  }

  const { data, error } = await adminClient
    .from('facebook_connections')
    .select('id,page_id,page_name,webhook_subscribed,created_at,updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })

  if (error) {
    throw new Error(`Failed to fetch Facebook connections: ${error.message}`)
  }

  return data ?? []
}

export async function getFacebookConnectionByPageId(pageId) {
  if (!adminClient) {
    throw new Error('Supabase service role is not configured.')
  }

  const { data, error } = await adminClient
    .from('facebook_connections')
    .select('id,user_id,page_id,page_name,page_access_token_encrypted,webhook_subscribed')
    .eq('page_id', pageId)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to fetch Facebook connection by page: ${error.message}`)
  }

  return data ?? null
}

export async function deleteFacebookConnectionByUserId(userId, pageId = null) {
  if (!adminClient) {
    throw new Error('Supabase service role is not configured.')
  }

  let query = adminClient.from('facebook_connections').delete().eq('user_id', userId)
  if (pageId) {
    query = query.eq('page_id', pageId)
  }

  const { data, error } = await query.select('page_id,page_access_token_encrypted')

  if (error) {
    throw new Error(`Failed to delete Facebook connection: ${error.message}`)
  }

  return data ?? []
}

export async function deleteFacebookConnectionsByFacebookUserId(facebookUserId) {
  if (!adminClient) {
    throw new Error('Supabase service role is not configured.')
  }

  const { data, error } = await adminClient
    .from('facebook_connections')
    .delete()
    .eq('facebook_user_id', facebookUserId)
    .select('page_id,page_access_token_encrypted')

  if (error) {
    throw new Error(`Failed to delete Facebook connections: ${error.message}`)
  }

  return data ?? []
}

export async function upsertWhatsAppConnection({
  userId,
  metaUserId,
  wabaId,
  wabaName,
  phoneNumberId,
  displayPhoneNumber,
  verifiedName,
  encryptedToken,
  webhookSubscribed,
}) {
  if (!adminClient) {
    throw new Error('Supabase service role is not configured.')
  }

  const { error: staleError } = await adminClient
    .from('whatsapp_connections')
    .delete()
    .eq('phone_number_id', phoneNumberId)
    .neq('user_id', userId)

  if (staleError) {
    throw new Error(`Failed to remove stale WhatsApp connections: ${staleError.message}`)
  }

  const { data, error } = await adminClient
    .from('whatsapp_connections')
    .upsert(
      {
        user_id: userId,
        meta_user_id: metaUserId,
        waba_id: wabaId,
        waba_name: wabaName,
        phone_number_id: phoneNumberId,
        display_phone_number: displayPhoneNumber,
        verified_name: verifiedName,
        access_token_encrypted: encryptedToken,
        webhook_subscribed: webhookSubscribed,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,phone_number_id' },
    )
    .select('id,user_id,phone_number_id,display_phone_number,verified_name,waba_name,webhook_subscribed,created_at,updated_at')
    .single()

  if (error) {
    throw new Error(`Failed to save WhatsApp connection: ${error.message}`)
  }

  return data
}

export async function getWhatsAppConnectionsByUserId(userId) {
  if (!adminClient) {
    throw new Error('Supabase service role is not configured.')
  }

  const { data, error } = await adminClient
    .from('whatsapp_connections')
    .select('id,phone_number_id,display_phone_number,verified_name,waba_name,webhook_subscribed,created_at,updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })

  if (error) {
    throw new Error(`Failed to fetch WhatsApp connections: ${error.message}`)
  }

  return data ?? []
}

export async function getWhatsAppConnectionByPhoneNumberId(phoneNumberId) {
  if (!adminClient) {
    throw new Error('Supabase service role is not configured.')
  }

  const { data, error } = await adminClient
    .from('whatsapp_connections')
    .select('id,user_id,waba_id,waba_name,phone_number_id,display_phone_number,verified_name,access_token_encrypted,webhook_subscribed,updated_at')
    .eq('phone_number_id', phoneNumberId)
    .order('updated_at', { ascending: false })
    .limit(1)

  if (error) {
    throw new Error(`Failed to fetch WhatsApp connection by phone number: ${error.message}`)
  }

  return data?.[0] ?? null
}

export async function deleteWhatsAppConnectionByUserId(userId, phoneNumberId = null) {
  if (!adminClient) {
    throw new Error('Supabase service role is not configured.')
  }

  let query = adminClient.from('whatsapp_connections').delete().eq('user_id', userId)
  if (phoneNumberId) {
    query = query.eq('phone_number_id', phoneNumberId)
  }

  const { data, error } = await query.select('phone_number_id,access_token_encrypted')

  if (error) {
    throw new Error(`Failed to delete WhatsApp connection: ${error.message}`)
  }

  return data ?? []
}

export async function deleteWhatsAppConnectionsByMetaUserId(metaUserId) {
  if (!adminClient) {
    throw new Error('Supabase service role is not configured.')
  }

  const { data, error } = await adminClient
    .from('whatsapp_connections')
    .delete()
    .eq('meta_user_id', metaUserId)
    .select('phone_number_id,access_token_encrypted')

  if (error) {
    throw new Error(`Failed to delete WhatsApp connections: ${error.message}`)
  }

  return data ?? []
}

export async function upsertInstagramConnection({
  userId,
  facebookUserId,
  pageId,
  pageName,
  instagramBusinessAccountId,
  instagramUsername,
  encryptedToken,
  webhookSubscribed,
}) {
  if (!adminClient) {
    throw new Error('Supabase service role is not configured.')
  }

  const { data, error } = await adminClient
    .from('instagram_connections')
    .upsert(
      {
        user_id: userId,
        facebook_user_id: facebookUserId,
        page_id: pageId,
        page_name: pageName,
        instagram_business_account_id: instagramBusinessAccountId,
        instagram_username: instagramUsername,
        page_access_token_encrypted: encryptedToken,
        webhook_subscribed: webhookSubscribed,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,instagram_business_account_id' },
    )
    .select('id,user_id,page_id,page_name,instagram_business_account_id,instagram_username,webhook_subscribed,created_at,updated_at')
    .single()

  if (error) {
    throw new Error(`Failed to save Instagram connection: ${error.message}`)
  }

  return data
}

export async function getInstagramConnectionsByUserId(userId) {
  if (!adminClient) {
    throw new Error('Supabase service role is not configured.')
  }

  const { data, error } = await adminClient
    .from('instagram_connections')
    .select('id,page_id,page_name,instagram_business_account_id,instagram_username,webhook_subscribed,comment_automation_enabled,created_at,updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })

  if (error) {
    throw new Error(`Failed to fetch Instagram connections: ${error.message}`)
  }

  return data ?? []
}

export async function setInstagramCommentAutomation(userId, enabled, instagramBusinessAccountId = null) {
  if (!adminClient) {
    throw new Error('Supabase service role is not configured.')
  }

  let query = adminClient
    .from('instagram_connections')
    .update({ comment_automation_enabled: enabled, updated_at: new Date().toISOString() })
    .eq('user_id', userId)

  if (instagramBusinessAccountId) {
    query = query.eq('instagram_business_account_id', instagramBusinessAccountId)
  }

  const { data, error } = await query
    .select('id,page_id,page_name,instagram_business_account_id,instagram_username,webhook_subscribed,comment_automation_enabled,created_at,updated_at')

  if (error) {
    throw new Error(`Failed to update Instagram comment automation: ${error.message}`)
  }

  return data ?? []
}

export async function getInstagramConnectionByIgId(instagramBusinessAccountId) {
  if (!adminClient) {
    throw new Error('Supabase service role is not configured.')
  }

  const { data, error } = await adminClient
    .from('instagram_connections')
    .select('id,user_id,page_id,page_name,instagram_business_account_id,instagram_username,page_access_token_encrypted,webhook_subscribed,comment_automation_enabled')
    .eq('instagram_business_account_id', instagramBusinessAccountId)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to fetch Instagram connection by IG account: ${error.message}`)
  }

  return data ?? null
}

export async function getInstagramConnectionByPageId(pageId) {
  if (!adminClient) {
    throw new Error('Supabase service role is not configured.')
  }

  const { data, error } = await adminClient
    .from('instagram_connections')
    .select('id,user_id,page_id,page_name,instagram_business_account_id,instagram_username,page_access_token_encrypted,webhook_subscribed,comment_automation_enabled')
    .eq('page_id', pageId)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to fetch Instagram connection by page: ${error.message}`)
  }

  return data ?? null
}

export async function deleteInstagramConnectionByUserId(userId, instagramBusinessAccountId = null) {
  if (!adminClient) {
    throw new Error('Supabase service role is not configured.')
  }

  let query = adminClient.from('instagram_connections').delete().eq('user_id', userId)
  if (instagramBusinessAccountId) {
    query = query.eq('instagram_business_account_id', instagramBusinessAccountId)
  }

  const { data, error } = await query.select('page_id,instagram_business_account_id,page_access_token_encrypted')

  if (error) {
    throw new Error(`Failed to delete Instagram connection: ${error.message}`)
  }

  return data ?? []
}

export async function deleteInstagramConnectionsByFacebookUserId(facebookUserId) {
  if (!adminClient) {
    throw new Error('Supabase service role is not configured.')
  }

  const { data, error } = await adminClient
    .from('instagram_connections')
    .delete()
    .eq('facebook_user_id', facebookUserId)
    .select('page_id,instagram_business_account_id,page_access_token_encrypted')

  if (error) {
    throw new Error(`Failed to delete Instagram connections: ${error.message}`)
  }

  return data ?? []
}

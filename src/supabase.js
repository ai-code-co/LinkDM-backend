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

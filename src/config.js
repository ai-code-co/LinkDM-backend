import dotenv from 'dotenv'

dotenv.config()

function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

export const config = {
  port: Number(process.env.PORT || 4000),
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  backendUrl: process.env.BACKEND_URL || `http://localhost:${Number(process.env.PORT || 4000)}`,
  paypalBaseUrl: process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com',
  paypalClientId: requireEnv('PAYPAL_CLIENT_ID'),
  paypalClientSecret: requireEnv('PAYPAL_CLIENT_SECRET'),
  paypalWebhookId: process.env.PAYPAL_WEBHOOK_ID || '',
  supabaseUrl: process.env.SUPABASE_URL || process.env.NUXT_PUBLIC_SUPABASE_URL || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || process.env.NUXT_PUBLIC_SUPABASE_KEY || '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  metaFacebookAppId: process.env.META_FB_APP_ID || process.env.META_APP_ID || '',
  metaAppSecret: process.env.META_FB_APP_SECRET || process.env.META_APP_SECRET || '',
  metaWebhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || '',
  metaGraphApiVersion: process.env.META_GRAPH_API_VERSION || 'v25.0',
  metaRedirectUri:
    process.env.META_REDIRECT_URI
    || `${process.env.BACKEND_URL || `http://localhost:${Number(process.env.PORT || 4000)}`}/auth/facebook/callback`,
  n8nFacebookWebhookUrl: process.env.N8N_FACEBOOK_WEBHOOK_URL || '',
  n8nInstagramWebhookUrl: process.env.N8N_INSTAGRAM_WEBHOOK_URL || '',
  tokenEncryptionSecret: process.env.TOKEN_ENCRYPTION_SECRET || process.env.META_FB_APP_SECRET || process.env.META_APP_SECRET || '',
  planIds: {
    pro: {
      monthly: process.env.PAYPAL_PLAN_PRO_MONTHLY || '',
      yearly: process.env.PAYPAL_PLAN_PRO_YEARLY || '',
    },
    platinum: {
      monthly: process.env.PAYPAL_PLAN_PLAT_MONTHLY || '',
      yearly: process.env.PAYPAL_PLAN_PLAT_YEARLY || '',
    },
  },
}

export function getPlanId(tier, billing) {
  const planId = config.planIds?.[tier]?.[billing]
  if (!planId) {
    throw new Error(`Missing PayPal plan id for tier="${tier}" billing="${billing}"`)
  }
  return planId
}

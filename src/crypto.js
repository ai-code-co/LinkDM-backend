import crypto from 'node:crypto'
import { config } from './config.js'

function getEncryptionKey() {
  return crypto.createHash('sha256').update(config.tokenEncryptionSecret).digest()
}

export function encryptToken(plainText) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`
}

export function decryptToken(payload) {
  const [ivB64, tagB64, dataB64] = payload.split('.')
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Invalid encrypted token format')
  }
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const data = Buffer.from(dataB64, 'base64')
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

export function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = crypto
    .createHmac('sha256', config.metaAppSecret)
    .update(body)
    .digest('base64url')
  return `${body}.${signature}`
}

export function verifyState(state) {
  const [body, signature] = state.split('.')
  if (!body || !signature) {
    throw new Error('Invalid OAuth state')
  }
  const expected = crypto
    .createHmac('sha256', config.metaAppSecret)
    .update(body)
    .digest('base64url')
  if (signature !== expected) {
    throw new Error('OAuth state signature mismatch')
  }
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  if (!payload.userId || !payload.ts) {
    throw new Error('OAuth state payload invalid')
  }
  if (Date.now() - payload.ts > 15 * 60 * 1000) {
    throw new Error('OAuth state expired')
  }
  return payload
}

function base64UrlDecode(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(base64, 'base64')
}

export function parseSignedRequest(signedRequest) {
  const [encodedSig, payload] = signedRequest.split('.', 2)
  if (!encodedSig || !payload) {
    return null
  }

  const sig = base64UrlDecode(encodedSig)
  const expectedSig = crypto
    .createHmac('sha256', config.metaAppSecret)
    .update(payload)
    .digest()

  if (sig.length !== expectedSig.length) {
    return null
  }

  try {
    if (!crypto.timingSafeEqual(sig, expectedSig)) {
      return null
    }
  }
  catch {
    return null
  }

  const data = JSON.parse(base64UrlDecode(payload).toString('utf8'))
  if (data.algorithm !== 'HMAC-SHA256' || !data.user_id) {
    return null
  }

  return data
}

export function verifyFacebookSignature(rawBody, signatureHeader) {
  if (!signatureHeader?.startsWith('sha256=')) {
    return false
  }
  const signature = signatureHeader.slice('sha256='.length)
  const expected = crypto
    .createHmac('sha256', config.metaAppSecret)
    .update(rawBody)
    .digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
  }
  catch {
    return false
  }
}

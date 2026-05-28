/**
 * TigerClient — RSA-signed REST client for Tiger Open API.
 *
 * Auth flow:
 *   1. Collect all request params (method, biz_content, common fields)
 *   2. Sort params alphabetically, concatenate as key=value&...
 *   3. Sign concatenated string with RSA SHA1 PKCS1v15
 *   4. POST all params as JSON to the gateway
 *
 * Reference: Tiger Open API Python SDK (tigeropen/tiger_open_client.py)
 */

import { createSign } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { BrokerError } from '../types.js'
import type { TigerApiResponse } from './tiger-types.js'

const GATEWAY_URL = 'https://openapi.tigerfintech.com/gateway'
const API_VERSION = '3.0'
const CHARSET = 'UTF-8'
const SIGN_TYPE = 'RSA'

export class TigerClient {
  private readonly tigerId: string
  private readonly privateKeyPem: string
  private readonly deviceId: string
  private readonly serverUrl: string
  private readonly token: string | null

  constructor(opts: {
    tigerId: string
    privateKey: string
    serverUrl?: string
    token?: string
  }) {
    this.tigerId = opts.tigerId
    this.privateKeyPem = normalizePem(opts.privateKey)
    this.deviceId = randomUUID()
    this.serverUrl = opts.serverUrl ?? GATEWAY_URL
    this.token = opts.token ?? null
  }

  /**
   * Execute a Tiger API call.
   *
   * @param method   Tiger service type string, e.g. "accounts", "place_order"
   * @param bizContent   Business parameters object (will be JSON-serialized with sorted keys)
   * @param version  API version override (default: '3.0')
   */
  async execute(method: string, bizContent: Record<string, unknown>, version = API_VERSION): Promise<unknown> {
    const bizContentStr = serializeBizContent(bizContent)

    const params: Record<string, string> = {
      timestamp: formatTimestamp(),
      tiger_id: this.tigerId,
      method,
      charset: CHARSET,
      version,
      sign_type: SIGN_TYPE,
      device_id: this.deviceId,
      biz_content: bizContentStr,
    }

    const signContent = buildSignContent(params)
    params.sign = signWithRsa(this.privateKeyPem, signContent)

    const headers: Record<string, string> = {
      'Content-Type': `application/json;charset=${CHARSET}`,
      'Cache-Control': 'no-cache',
      'Connection': 'Keep-Alive',
      'User-Agent': 'openalice-tiger-broker/1.0',
    }

    if (this.token) {
      headers['Authorization'] = this.token
    }

    let res: Response
    try {
      res = await fetch(this.serverUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
      })
    } catch (err) {
      throw BrokerError.from(err, 'NETWORK')
    }

    if (!res.ok) {
      throw new BrokerError('NETWORK', `Tiger gateway HTTP ${res.status}: ${res.statusText}`)
    }

    const responseText = await res.text()
    const json = parseTigerJsonPreservingInt64(responseText) as TigerApiResponse

    if (json.code !== 0) {
      const errorMsg = `Tiger API error ${json.code}: ${json.message}`
      throw new BrokerError(classifyTigerErrorCode(json.code, json.message), errorMsg)
    }

    // Tiger inconsistently returns data as a JSON-encoded string (double-encoded) for some
    // endpoints (e.g. assets, quote_real_time) and as a JSON object for others (e.g. contracts).
    // Transparently parse the string here so all callers receive a plain JS value.
    const raw = json.data
    return typeof raw === 'string' ? parseTigerJsonPreservingInt64(raw) : raw
  }
}

// ==================== Signing ====================

/**
 * Build the sign content string: sorted key=value pairs joined by &.
 * All values must be strings (biz_content is already JSON-stringified).
 */
function buildSignContent(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&')
}

/**
 * Sign content string with RSA SHA1 PKCS1v15, return base64.
 * Tiger uses SHA1 (not SHA256) — matches Python SDK's sign_with_rsa.
 */
function signWithRsa(privateKeyPem: string, content: string): string {
  const sign = createSign('SHA1')
  sign.update(content, 'utf8')
  return sign.sign(privateKeyPem, 'base64')
}

/**
 * Normalize private key to PEM format.
 * Accepts:
 *   - base64-encoded PKCS#1 DER (no BEGIN/END markers) → wraps in RSA PRIVATE KEY markers
 *   - Full PEM (already has markers) → returned as-is
 */
function normalizePem(privateKey: string): string {
  const trimmed = privateKey.trim()
  if (trimmed.startsWith('-----')) return trimmed
  // Base64 DER — wrap in PKCS#1 PEM markers
  return `-----BEGIN RSA PRIVATE KEY-----\n${trimmed}\n-----END RSA PRIVATE KEY-----`
}

// ==================== Serialization ====================

/**
 * Serialize biz_content as compact JSON with sorted keys, omitting null/undefined.
 * Tiger's Python SDK uses: json.dumps(sort_keys=True, separators=(',', ':'))
 */
const RAW_INTEGER_FIELDS = new Set(['id', 'order_id', 'parent_id'])

export function serializeBizContent(obj: Record<string, unknown>): string {
  return serializeJsonValue(obj)
}

function serializeJsonValue(value: unknown, key?: string): string {
  if (value === null || value === undefined) return 'null'

  if (typeof value === 'string') {
    // Tiger's Python SDK serializes order ids as JSON numbers, but those ids
    // are int64 and exceed JavaScript's safe integer range. Keep the caller's
    // decimal string exact while emitting the same numeric JSON shape.
    if (key && RAW_INTEGER_FIELDS.has(key) && isDecimalIntegerString(value)) {
      return value
    }
    return JSON.stringify(value)
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }

  if (typeof value === 'bigint') {
    return value.toString()
  }

  if (Array.isArray(value)) {
    return `[${value.map(v => serializeJsonValue(v)).join(',')}]`
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const parts: string[] = []
    for (const childKey of Object.keys(obj).sort()) {
      const childValue = obj[childKey]
      if (childValue === null || childValue === undefined) continue
      parts.push(`${JSON.stringify(childKey)}:${serializeJsonValue(childValue, childKey)}`)
    }
    return `{${parts.join(',')}}`
  }

  return JSON.stringify(value)
}

/**
 * Parse Tiger JSON without losing int64 order ids.
 *
 * Native JSON.parse turns `43152459534700541` into the nearest IEEE-754
 * double (`43152459534700540`). Python's SDK does not have this problem
 * because Python ints are arbitrary precision. We quote unsafe integer
 * literals before parsing so ids arrive as decimal strings.
 */
export function parseTigerJsonPreservingInt64(text: string): unknown {
  return JSON.parse(quoteUnsafeIntegerLiterals(text))
}

function quoteUnsafeIntegerLiterals(input: string): string {
  let out = ''
  let i = 0
  let inString = false
  let escaped = false

  while (i < input.length) {
    const ch = input[i]

    if (inString) {
      out += ch
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      i++
      continue
    }

    if (ch === '"') {
      inString = true
      out += ch
      i++
      continue
    }

    if (ch === '-' || isDigit(ch)) {
      const start = i
      if (ch === '-') i++

      const intStart = i
      while (i < input.length && isDigit(input[i])) i++
      const intPart = input.slice(intStart, i)

      let hasFractionOrExponent = false
      if (input[i] === '.') {
        hasFractionOrExponent = true
        i++
        while (i < input.length && isDigit(input[i])) i++
      }
      if (input[i] === 'e' || input[i] === 'E') {
        hasFractionOrExponent = true
        i++
        if (input[i] === '+' || input[i] === '-') i++
        while (i < input.length && isDigit(input[i])) i++
      }

      const token = input.slice(start, i)
      if (!hasFractionOrExponent && intPart && isUnsafeIntegerLiteral(token)) {
        out += JSON.stringify(token)
      } else {
        out += token
      }
      continue
    }

    out += ch
    i++
  }

  return out
}

function isDigit(ch: string | undefined): boolean {
  return ch != null && ch >= '0' && ch <= '9'
}

function isDecimalIntegerString(value: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(value)
}

function isUnsafeIntegerLiteral(token: string): boolean {
  try {
    const n = BigInt(token)
    const max = BigInt(Number.MAX_SAFE_INTEGER)
    return n > max || n < -max
  } catch {
    return false
  }
}

/**
 * Format Date as "YYYY-MM-DD HH:MM:SS" in local time.
 * Tiger's Python SDK uses datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S").
 */
function formatTimestamp(): string {
  const now = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`
}

// ==================== Error classification ====================

function classifyTigerErrorCode(code: number, message: string): import('../types.js').BrokerErrorCode {
  const msg = message.toLowerCase()

  // Auth errors
  if (code === 40001 || code === 40002 || code === 40003) return 'AUTH'
  if (/unauthorized|invalid.*key|invalid.*sign|auth/i.test(msg)) return 'AUTH'

  // Network / rate limit
  if (code === 429 || /rate.?limit|too many/i.test(msg)) return 'NETWORK'
  if (code >= 500 && code < 600) return 'NETWORK'

  // Market closed
  if (/market.?closed|not.?open|trading.?halt|outside.?trading/i.test(msg)) return 'MARKET_CLOSED'

  // Exchange-level (order rejected, insufficient funds, etc.)
  if (/insufficient|not.?enough|margin|reject|invalid.?order/i.test(msg)) return 'EXCHANGE'
  if (code >= 40000 && code < 50000) return 'EXCHANGE'

  return 'UNKNOWN'
}

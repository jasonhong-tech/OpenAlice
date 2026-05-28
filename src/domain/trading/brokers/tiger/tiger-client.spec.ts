import { describe, expect, it } from 'vitest'
import { parseTigerJsonPreservingInt64, serializeBizContent } from './tiger-client.js'

describe('TigerClient int64 JSON handling', () => {
  it('parses unsafe integer order ids as exact decimal strings', () => {
    const parsed = parseTigerJsonPreservingInt64(
      '{"id":43152459534700541,"orderId":29,"items":[{"id":43080426454125571}],"timestamp":1755089890524}',
    ) as {
      id: string
      orderId: number
      items: Array<{ id: string }>
      timestamp: number
    }

    expect(parsed.id).toBe('43152459534700541')
    expect(parsed.orderId).toBe(29)
    expect(parsed.items[0].id).toBe('43080426454125571')
    expect(parsed.timestamp).toBe(1755089890524)
  })

  it('serializes order id strings as exact JSON numeric literals', () => {
    expect(serializeBizContent({
      account: '123456',
      id: '43152459534700541',
      lang: 'en_US',
    })).toBe('{"account":"123456","id":43152459534700541,"lang":"en_US"}')
  })

  it('does not treat symbol-like strings as raw numbers', () => {
    expect(serializeBizContent({
      account: '123456',
      symbol: '00700',
    })).toBe('{"account":"123456","symbol":"00700"}')
  })
})

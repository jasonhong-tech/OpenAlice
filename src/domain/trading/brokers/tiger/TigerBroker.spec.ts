import { describe, expect, it, vi } from 'vitest'
import { BrokerError } from '../types.js'
import { TigerBroker } from './TigerBroker.js'

function makeBroker(): TigerBroker {
  return new TigerBroker({
    id: 'tiger-test',
    tigerId: 'test-tiger-id',
    privateKey: 'test-private-key',
    account: '123456',
  })
}

describe('TigerBroker int64 order ids', () => {
  it('resolves a legacy JS-rounded order id from active_orders', async () => {
    const exactId = '43152459534700541'
    const roundedId = Number(exactId).toString()
    const broker = makeBroker()

    const execute = vi.fn(async (method: string) => {
      if (method === 'orders') return null
      if (method === 'active_orders') {
        return {
          items: [{
            id: exactId,
            orderId: 29,
            symbol: 'MSFT',
            currency: 'USD',
            secType: 'STK',
            action: 'SELL',
            orderType: 'STP',
            totalQuantity: 10,
            auxPrice: 400,
            timeInForce: 'GTC',
            status: 'Submitted',
          }],
        }
      }
      throw new Error(`unexpected method ${method}`)
    })
    ;(broker as any).client = { execute }

    const order = await broker.getOrder(roundedId)

    expect(roundedId).not.toBe(exactId)
    expect(order?.orderId).toBe(exactId)
    expect(order?.orderState.status).toBe('Submitted')
  })

  it('retries cancel_order with the exact active order id when a rounded id is rejected', async () => {
    const exactId = '43152459534700541'
    const roundedId = Number(exactId).toString()
    const broker = makeBroker()
    const cancelIds: unknown[] = []

    const execute = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'cancel_order') {
        cancelIds.push(params.id)
        if (params.id === roundedId) {
          throw new BrokerError(
            'UNKNOWN',
            'Tiger API error 1200: standard account response error(BAD_REQUEST:Order does not exist)',
          )
        }
        return { id: exactId }
      }
      if (method === 'active_orders') {
        return {
          items: [{
            id: exactId,
            orderId: 29,
            symbol: 'MSFT',
            currency: 'USD',
            secType: 'STK',
            status: 'Submitted',
          }],
        }
      }
      throw new Error(`unexpected method ${method}`)
    })
    ;(broker as any).client = { execute }

    const result = await broker.cancelOrder(roundedId)

    expect(result.success).toBe(true)
    expect(result.orderId).toBe(exactId)
    expect(cancelIds).toEqual([roundedId, exactId])
  })
})

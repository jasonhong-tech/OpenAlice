import { describe, expect, it, vi } from 'vitest'
import Decimal from 'decimal.js'
import { Contract, Order } from '@traderalice/ibkr'
import { BROKER_REGISTRY } from '../registry.js'
import { SnaptradeBroker } from './SnaptradeBroker.js'
import type { SnaptradeSdkClient } from './snaptrade-types.js'

function makeBroker(): SnaptradeBroker {
  return new SnaptradeBroker({
    id: 'snaptrade-test',
    label: 'SnapTrade Test',
    clientId: 'client-id',
    consumerKey: 'consumer-key',
    userId: 'user-1',
    userSecret: 'secret-1',
    accountId: 'account-1',
  })
}

function attachClient(broker: SnaptradeBroker, client: Partial<SnaptradeSdkClient>): void {
  ;(broker as unknown as { client: Partial<SnaptradeSdkClient> }).client = client
}

describe('SnaptradeBroker', () => {
  it('registers as a securities broker type for the Trading account UI', () => {
    expect(BROKER_REGISTRY.snaptrade).toMatchObject({
      name: 'SnapTrade',
      badge: 'ST',
      guardCategory: 'securities',
    })
    expect(BROKER_REGISTRY.snaptrade.configFields.map(f => f.name)).toEqual([
      'clientId',
      'userId',
      'accountId',
      'basePath',
      'consumerKey',
      'userSecret',
    ])
  })

  it('maps all-account positions into unified positions with SnapTrade native keys', async () => {
    const broker = makeBroker()
    attachClient(broker, {
      accountInformation: {
        getAllAccountPositions: vi.fn(async () => ({
          data: {
            results: [{
              instrument: {
                kind: 'stock',
                id: 'snap-aapl',
                symbol: 'AAPL',
                raw_symbol: 'AAPL',
                currency: 'USD',
                exchange: 'NASDAQ',
              },
              units: '2.5',
              price: '200',
              cost_basis: '150',
            }],
          },
        })),
      } as unknown as SnaptradeSdkClient['accountInformation'],
    })

    const [position] = await broker.getPositions()

    expect(position.contract.symbol).toBe('AAPL')
    expect(position.contract.localSymbol).toBe('snap-aapl')
    expect(position.quantity.equals(new Decimal('2.5'))).toBe(true)
    expect(position.marketValue).toBe(500)
    expect(position.unrealizedPnL).toBe(125)
    expect(broker.getNativeKey(position.contract)).toBe('snap-aapl::AAPL::STK')
  })

  it('places a limit order through placeForceOrder using universal_symbol_id', async () => {
    const broker = makeBroker()
    const placeForceOrder = vi.fn(async () => ({
      data: {
        brokerage_order_id: 'broker-order-1',
        status: 'ACCEPTED',
      },
    }))
    attachClient(broker, {
      trading: {
        placeForceOrder,
      } as unknown as SnaptradeSdkClient['trading'],
    })

    const contract = new Contract()
    contract.symbol = 'AAPL'
    contract.localSymbol = 'snap-aapl'
    contract.secType = 'STK'
    contract.currency = 'USD'
    contract.exchange = 'NASDAQ'

    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'LMT'
    order.tif = 'DAY'
    order.totalQuantity = new Decimal('3')
    order.lmtPrice = 187.5

    const result = await broker.placeOrder(contract, order)

    expect(result).toMatchObject({
      success: true,
      orderId: 'broker-order-1',
    })
    expect(placeForceOrder).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      userSecret: 'secret-1',
      account_id: 'account-1',
      action: 'BUY',
      universal_symbol_id: 'snap-aapl',
      symbol: null,
      order_type: 'Limit',
      time_in_force: 'Day',
      trading_session: 'REGULAR',
      units: 3,
      notional_value: null,
      price: 187.5,
    }))
  })
})

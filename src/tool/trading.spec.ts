import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ContractDescription, Order, OrderState } from '@traderalice/ibkr'
import Decimal from 'decimal.js'
import { MockBroker, makeContract, makeOpenOrder } from '../domain/trading/brokers/mock/index.js'
import { AccountManager } from '../domain/trading/account-manager.js'
import { UnifiedTradingAccount } from '../domain/trading/UnifiedTradingAccount.js'
import { createTradingTools } from './trading.js'
import '../domain/trading/contract-ext.js'

function makeUta(broker: MockBroker): UnifiedTradingAccount {
  return new UnifiedTradingAccount(broker)
}

function makeManager(...brokers: MockBroker[]): AccountManager {
  const mgr = new AccountManager()
  for (const b of brokers) mgr.add(makeUta(b))
  return mgr
}

// ==================== AccountManager.resolve ====================

describe('AccountManager.resolve', () => {
  let mgr: AccountManager

  beforeEach(() => {
    mgr = makeManager(
      new MockBroker({ id: 'alpaca-paper', label: 'Alpaca Paper' }),
      new MockBroker({ id: 'bybit-main', label: 'Bybit Main' }),
    )
  })

  it('returns all UTAs when source is not provided', () => {
    const results = mgr.resolve()
    expect(results).toHaveLength(2)
    expect(results.map((r) => r.id).sort()).toEqual(['alpaca-paper', 'bybit-main'])
  })

  it('returns single UTA by exact id', () => {
    const results = mgr.resolve('alpaca-paper')
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('alpaca-paper')
  })

  it('returns empty array when source matches nothing', () => {
    expect(mgr.resolve('nonexistent')).toHaveLength(0)
  })
})

// ==================== resolveOne ====================

describe('AccountManager.resolveOne', () => {
  let mgr: AccountManager

  beforeEach(() => {
    mgr = makeManager(
      new MockBroker({ id: 'alpaca-paper' }),
      new MockBroker({ id: 'bybit-main' }),
    )
  })

  it('returns the single matching UTA', () => {
    const result = mgr.resolveOne('alpaca-paper')
    expect(result.id).toBe('alpaca-paper')
  })

  it('throws when no UTA matches', () => {
    expect(() => mgr.resolveOne('unknown-id')).toThrow('No account found matching source "unknown-id"')
  })
})

// ==================== createTradingTools: listAccounts ====================

describe('createTradingTools — listAccounts', () => {
  it('returns summaries for all registered UTAs', async () => {
    const mgr = makeManager(new MockBroker({ id: 'acc1', label: 'Test' }))
    const tools = createTradingTools(mgr)
    const result = await (tools.listAccounts.execute as Function)({})
    expect(Array.isArray(result)).toBe(true)
    expect(result[0].id).toBe('acc1')
  })
})

// ==================== createTradingTools: searchContracts ====================

describe('createTradingTools — searchContracts', () => {
  it('aggregates results from all UTAs', async () => {
    const a1 = new MockBroker({ id: 'acc1' })
    const a2 = new MockBroker({ id: 'acc2' })
    const desc1 = new ContractDescription()
    desc1.contract = makeContract({ symbol: 'AAPL' })
    const desc2 = new ContractDescription()
    desc2.contract = makeContract({ symbol: 'AAPL' })
    vi.spyOn(a1, 'searchContracts').mockResolvedValue([desc1])
    vi.spyOn(a2, 'searchContracts').mockResolvedValue([desc2])

    const mgr = makeManager(a1, a2)
    const tools = createTradingTools(mgr)
    const result = await (tools.searchContracts.execute as Function)({ pattern: 'AAPL' })
    expect(result).toHaveLength(2)
  })
})

// ==================== createTradingTools: listOpenOrders / getOrders shape ====================

/**
 * These tests pin the *flattened* response shape of `listOpenOrders` and
 * `getOrders`. The AI consumed `OpenOrder` directly before and consistently
 * picked the wrong id-shaped field (`order.orderId`, which for Tiger is the
 * account-level small int, not the canonical global id). Flattening removes
 * the ambiguity, and these tests guarantee the flat shape stays flat and
 * never accidentally re-exposes a second id-shaped field.
 */
describe('createTradingTools — listOpenOrders flattened response shape', () => {
  function makeStpOrder(): ReturnType<typeof makeOpenOrder> {
    // Mimic Tiger's two-id reality: top-level canonical (global int64-shaped
    // string) + inner IBKR-numeric account-level id that must NOT leak.
    const contract = makeContract({ symbol: 'MSFT', secType: 'STK', currency: 'USD' })
    const order = new Order()
    order.orderId = 21
    order.action = 'SELL'
    order.orderType = 'STP'
    order.totalQuantity = new Decimal(10)
    order.auxPrice = 400
    order.tif = 'GTC'
    const orderState = new OrderState()
    orderState.status = 'Submitted'
    return { orderId: '43204393769504770', contract, order, orderState }
  }

  it('flattens listOpenOrders output to a single canonical orderId', async () => {
    const broker = new MockBroker({ id: 'tiger-main' })
    const stp = makeStpOrder()
    ;(broker as unknown as { listOpenOrders: () => Promise<unknown> }).listOpenOrders = vi.fn().mockResolvedValue([stp])

    const mgr = makeManager(broker)
    const tools = createTradingTools(mgr)
    const result = await (tools.listOpenOrders.execute as Function)({ source: 'tiger-main' })

    expect(result).toHaveLength(1)
    const o = result[0] as Record<string, unknown>
    expect(o.orderId).toBe('43204393769504770')
    expect(o.symbol).toBe('MSFT')
    expect(o.orderType).toBe('STP')
    expect(o.tif).toBe('GTC')
    expect(o.status).toBe('Submitted')
    expect(o.auxPrice).toBe(400)
    expect(o.action).toBe('SELL')
    expect(o.totalQuantity).toBe(10)
  })

  it('does NOT leak the inner `order` object (would expose the wrong account-level id)', async () => {
    const broker = new MockBroker({ id: 'tiger-main' })
    const stp = makeStpOrder()
    ;(broker as unknown as { listOpenOrders: () => Promise<unknown> }).listOpenOrders = vi.fn().mockResolvedValue([stp])

    const mgr = makeManager(broker)
    const tools = createTradingTools(mgr)
    const result = await (tools.listOpenOrders.execute as Function)({ source: 'tiger-main' })

    const o = result[0] as Record<string, unknown>
    // The IBKR-numeric `order.orderId = 21` (account-level small int) is the
    // exact value that caused the AI to feed bad ids into cancel/modify; the
    // flat response must never carry it.
    expect(o.order).toBeUndefined()
    expect(o.contract).toBeUndefined()
    expect(o.orderState).toBeUndefined()
    expect(o.orderId).not.toBe('21')
    expect(o.orderId).not.toBe(21)
  })

  it('omits optional fields when unset and includes rejectReason when present', async () => {
    const broker = new MockBroker({ id: 'tiger-main' })
    const stp = makeStpOrder()
    stp.orderState.status = 'Inactive'
    stp.orderState.rejectReason = 'The order quantity you entered exceeds your current holdings'
    ;(broker as unknown as { listOpenOrders: () => Promise<unknown> }).listOpenOrders = vi.fn().mockResolvedValue([stp])

    const mgr = makeManager(broker)
    const tools = createTradingTools(mgr)
    const result = await (tools.listOpenOrders.execute as Function)({ source: 'tiger-main' })

    const o = result[0] as Record<string, unknown>
    expect(o.status).toBe('Inactive')
    expect(o.rejectReason).toContain('exceeds your current holdings')
    expect(o).not.toHaveProperty('lmtPrice')
    expect(o).not.toHaveProperty('trailingPercent')
    expect(o).not.toHaveProperty('avgFillPrice')
  })

  it('getOrders applies the same flattening', async () => {
    const broker = new MockBroker({ id: 'tiger-main' })
    const stp = makeStpOrder()
    broker.getOrders = vi.fn().mockResolvedValue([stp])

    const mgr = makeManager(broker)
    const tools = createTradingTools(mgr)
    const result = await (tools.getOrders.execute as Function)({
      source: 'tiger-main',
      orderIds: ['43204393769504770'],
    })

    const o = result[0] as Record<string, unknown>
    expect(o.orderId).toBe('43204393769504770')
    expect(o.order).toBeUndefined()
  })
})

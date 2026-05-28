/**
 * Regression tests for Tiger wire-status → IBKR status mapping.
 *
 * Tiger sends a mix of enum *values* (e.g. `'PendingNew'`, `'Initial'`,
 * `'PendingSubmit'`) and occasionally enum *names* (`'PENDING_NEW'`). A
 * previous version of `tigerStatusToIbkr` only matched the latter, so
 * every wire-value-style status fell through unmapped — including the
 * "alive on the exchange but waiting for trigger" states that GTC stop
 * orders sit in. That in turn made `UnifiedTradingAccount.sync()`
 * mis-classify live orders as terminal `rejected`, and made the AI think
 * no open stops existed even though Tiger was clearly holding them.
 *
 * These tests pin every documented Tiger status string to a canonical
 * IBKR status (`'Submitted' | 'PreSubmitted' | 'Filled' | 'PartiallyFilled'
 * | 'PendingCancel' | 'Cancelled' | 'Inactive'`) so we cannot regress on
 * either spelling shape.
 */

import { describe, expect, it } from 'vitest'
import { tigerStatusToOrderState, tigerOrderToOpenOrder } from './tiger-contracts.js'

describe('tigerStatusToOrderState — Tiger wire-value statuses', () => {
  it.each([
    // Tiger enum *values* — what the HTTP wire actually carries.
    // Note: Tiger SDK's `get_order_status` lumps `Submitted`/`PendingSubmit`/
    // `Held` together as one canonical "live on exchange" bucket (numerical
    // codes 2/5/8). We must mirror that — otherwise long-lived GTC stops
    // appear as IBKR `PreSubmitted` when Tiger considers them live and
    // is reserving inventory against them.
    ['Initial', 'PreSubmitted'],
    ['New', 'PreSubmitted'],
    ['PendingNew', 'PreSubmitted'],
    ['Submitted', 'Submitted'],
    ['PendingSubmit', 'Submitted'],
    ['Held', 'Submitted'],
    ['PartiallyFilled', 'PartiallyFilled'],
    ['Filled', 'Filled'],
    ['PendingCancel', 'PendingCancel'],
    ['Cancelled', 'Cancelled'],
    ['Inactive', 'Inactive'],
    ['Invalid', 'Inactive'],
    // Tiger enum *names* — observed on push channels / legacy responses.
    ['PENDING_NEW', 'PreSubmitted'],
    ['PENDING_CANCEL', 'PendingCancel'],
    ['REJECTED', 'Inactive'],
    ['EXPIRED', 'Inactive'],
    // Case-insensitive resilience.
    ['submitted', 'Submitted'],
    ['INACTIVE', 'Inactive'],
  ])('maps Tiger %s → IBKR %s', (tigerStatus, ibkrStatus) => {
    expect(tigerStatusToOrderState(tigerStatus).status).toBe(ibkrStatus)
  })

  it('lifts `remark` into rejectReason for terminal-rejected statuses', () => {
    const state = tigerStatusToOrderState('Inactive', 'Tick size violation')
    expect(state.status).toBe('Inactive')
    expect(state.rejectReason).toBe('Tick size violation')
    expect(state.warningText).toBe('Tick size violation')
  })

  it('lifts `remark` into rejectReason for `Cancelled` (terminal)', () => {
    const state = tigerStatusToOrderState('Cancelled', 'User requested cancel')
    expect(state.rejectReason).toBe('User requested cancel')
  })

  it('does NOT surface remark for live `Submitted` orders', () => {
    const state = tigerStatusToOrderState('Submitted', 'some note')
    expect(state.status).toBe('Submitted')
    expect(state.rejectReason).toBeFalsy()
  })

  it('does NOT surface remark for `PendingSubmit` (Tiger: same as live Submitted)', () => {
    const state = tigerStatusToOrderState('PendingSubmit', 'still working')
    expect(state.status).toBe('Submitted')
    expect(state.rejectReason).toBeFalsy()
  })
})

describe('tigerOrderToOpenOrder — orphan GTC stop visibility', () => {
  it('reports a live STP+GTC waiting-for-trigger order as IBKR Submitted', () => {
    const open = tigerOrderToOpenOrder({
      id: '43204393769504770',
      symbol: 'MSFT',
      currency: 'USD',
      secType: 'STK',
      action: 'SELL',
      orderType: 'STP',
      totalQuantity: 10,
      auxPrice: 400,
      timeInForce: 'GTC',
      status: 'Submitted',
    })
    expect(open.contract.symbol).toBe('MSFT')
    expect(open.order.orderType).toBe('STP')
    expect(open.order.auxPrice).toBe(400)
    expect(open.order.tif).toBe('GTC')
    expect(open.orderState.status).toBe('Submitted')
  })

  it('uses Tiger global `id` (int64) as the canonical OpenOrder.orderId, NOT the account-level `orderId`', () => {
    // Tiger emits two id fields on every order:
    //   - `id` — the global int64 snowflake-style id (e.g. 43204393769504770).
    //            cancel_order / modify_order key off this field.
    //   - `orderId` — a small per-account counter (e.g. 21, 22, 29).
    // We must surface the *global* id at the top level so AI can feed it
    // straight back into cancelOrder / modifyOrder without ambiguity.
    const open = tigerOrderToOpenOrder({
      id: '43204393769504770',
      orderId: 29,
      symbol: 'MSFT',
      status: 'Submitted',
    })
    expect(open.orderId).toBe('43204393769504770')
    // The IBKR-numeric Order.orderId remains the account-level small id —
    // that's its IBKR semantic meaning (client-assigned placement id).
    expect(open.order.orderId).toBe(29)
  })

  it('falls back to account-level orderId when Tiger somehow omits `id`', () => {
    // Defensive: if Tiger ever returns an order without `id`, the
    // account-level orderId is still preserved as a string so downstream
    // never sees an empty identifier.
    const open = tigerOrderToOpenOrder({
      orderId: 29,
      symbol: 'MSFT',
      status: 'Submitted',
    })
    expect(open.orderId).toBe('29')
  })

  it('reports a Tiger PendingSubmit STP as IBKR Submitted (Tiger lumps it with live)', () => {
    // Real-world signature: orphan GTC stop placed days ago, still alive on
    // Tiger and locking inventory (causes "exceeds current holdings" rejections
    // when fresh stops are submitted). Must surface as Submitted so the AI
    // sees it as a live order to cancel — NOT as PreSubmitted, which would
    // wrongly suggest "broker still trying to route it".
    const open = tigerOrderToOpenOrder({
      id: 1,
      symbol: 'GLD',
      orderType: 'STP',
      status: 'PendingSubmit',
      timeInForce: 'GTC',
    })
    expect(open.orderState.status).toBe('Submitted')
  })

  it('preserves remark on Tiger Invalid (rejected) orders for the AI to read', () => {
    const open = tigerOrderToOpenOrder({
      id: 2,
      symbol: 'ORCL',
      orderType: 'STP',
      status: 'Invalid',
      timeInForce: 'GTC',
      remark: 'The order quantity you entered exceeds your current holdings',
    })
    expect(open.orderState.status).toBe('Inactive')
    expect(open.orderState.rejectReason).toContain('exceeds your current holdings')
  })
})

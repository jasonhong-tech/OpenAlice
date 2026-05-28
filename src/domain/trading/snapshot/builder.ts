/**
 * Snapshot builder — assembles a UTASnapshot from a live UTA.
 *
 * Only returns a snapshot when real data is successfully fetched.
 * Returns null when data cannot be obtained (offline, disabled, network error).
 * Never fabricates zero-value placeholders.
 */

import type { UnifiedTradingAccount } from '../UnifiedTradingAccount.js'
import type { UTASnapshot, SnapshotTrigger } from './types.js'

export async function buildSnapshot(
  uta: UnifiedTradingAccount,
  trigger: SnapshotTrigger,
): Promise<UTASnapshot | null> {
  // Can't get real data from offline/disabled accounts
  if (uta.disabled || uta.health === 'offline') return null

  try {
    const pendingOrderIds = uta.git.getPendingOrderIds().map(p => p.orderId)
    const [accountInfo, positions, orders] = await Promise.all([
      uta.getAccount(),
      uta.getPositions(),
      uta.getOrders(pendingOrderIds),
    ])

    const gitStatus = uta.git.status()

    return {
      accountId: uta.id,
      timestamp: new Date().toISOString(),
      trigger,
      account: {
        netLiquidation: String(accountInfo.netLiquidation),
        totalCashValue: String(accountInfo.totalCashValue),
        unrealizedPnL: String(accountInfo.unrealizedPnL),
        realizedPnL: String(accountInfo.realizedPnL ?? 0),
        buyingPower: accountInfo.buyingPower != null ? String(accountInfo.buyingPower) : undefined,
        initMarginReq: accountInfo.initMarginReq != null ? String(accountInfo.initMarginReq) : undefined,
        maintMarginReq: accountInfo.maintMarginReq != null ? String(accountInfo.maintMarginReq) : undefined,
      },
      positions: positions.map(p => ({
        aliceId: p.contract.aliceId ?? uta.broker.getNativeKey(p.contract),
        side: p.side,
        quantity: p.quantity.toString(),
        avgCost: String(p.avgCost),
        marketPrice: String(p.marketPrice),
        marketValue: String(p.marketValue),
        unrealizedPnL: String(p.unrealizedPnL),
        realizedPnL: String(p.realizedPnL),
      })),
      openOrders: orders
        .filter(o => o.orderState.status === 'Submitted' || o.orderState.status === 'PreSubmitted')
        .map(o => ({
          // Use the broker-side canonical id (string-safe, supports Tiger's
          // 64-bit global ids) rather than the IBKR-numeric `order.orderId`,
          // which for Tiger is the account-level small int and cannot be
          // round-tripped to `cancelOrder` / `modifyOrder`.
          orderId: o.orderId,
          aliceId: o.contract.aliceId ?? uta.broker.getNativeKey(o.contract),
          action: o.order.action,
          orderType: o.order.orderType,
          totalQuantity: o.order.totalQuantity.toString(),
          limitPrice: o.order.lmtPrice != null ? String(o.order.lmtPrice) : undefined,
          status: o.orderState.status,
          avgFillPrice: o.avgFillPrice != null ? String(o.avgFillPrice) : undefined,
        })),
      health: uta.disabled ? 'disabled' : uta.health,
      headCommit: gitStatus.head,
      pendingCommits: gitStatus.pendingHash ? [gitStatus.pendingHash] : [],
    }
  } catch (err) {
    console.warn(`snapshot: build failed for ${uta.id}:`, err instanceof Error ? err.message : err)
    return null
  }
}

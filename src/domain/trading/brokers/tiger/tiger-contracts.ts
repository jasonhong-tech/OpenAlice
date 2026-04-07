/**
 * Tiger ↔ IBKR contract/order mapping helpers.
 *
 * Tiger API uses its own contract/order format; IBroker uses @traderalice/ibkr types.
 * These helpers translate between them so TigerBroker can satisfy IBroker without
 * leaking Tiger-specific shapes to the rest of the codebase.
 */

import {
  Contract,
  Order,
  OrderState,
} from '@traderalice/ibkr'
import Decimal from 'decimal.js'
import type { ContractDescription, ContractDetails } from '@traderalice/ibkr'
import type {
  TigerContractRaw,
  TigerOrderRaw,
  TigerPositionRaw,
  TigerAssetRaw,
} from './tiger-types.js'
import type { Position, AccountInfo, OpenOrder } from '../types.js'

// ==================== Market / exchange helpers ====================

/**
 * Determine the Tiger market string from an IBKR Contract.
 * HK stocks: exchange SEHK or currency HKD → "HK"
 * US stocks: everything else → "US"
 */
export function contractMarket(contract: Contract): 'US' | 'HK' {
  const exchange = (contract.exchange ?? '').toUpperCase()
  const currency = (contract.currency ?? 'USD').toUpperCase()
  if (exchange === 'SEHK' || currency === 'HKD') return 'HK'
  return 'US'
}

/**
 * Convert an IBKR Contract to a Tiger contract params object for API calls.
 * Tiger needs: symbol, sec_type, currency, exchange (optional), market (optional).
 */
export function contractToTigerParams(contract: Contract): Record<string, unknown> {
  const market = contractMarket(contract)
  const symbol = contract.symbol ?? ''
  const secType = ibkrSecTypeToTiger(contract.secType ?? 'STK')
  const currency = contract.currency ?? (market === 'HK' ? 'HKD' : 'USD')
  const exchange = contract.exchange

  const params: Record<string, unknown> = {
    symbol,
    sec_type: secType,
    currency,
    market,
  }

  // Include exchange only if explicitly set and not SMART (Tiger doesn't use SMART routing)
  if (exchange && exchange !== 'SMART') {
    params.exchange = exchange
  }

  return params
}

/**
 * Convert IBKR secType to Tiger sec_type.
 * Most values are identical; WAR (warrants) → Tiger "WAR", IBKR lacks IOPT (HK bull/bear certs).
 */
function ibkrSecTypeToTiger(secType: string): string {
  const map: Record<string, string> = {
    STK: 'STK',
    OPT: 'OPT',
    FUT: 'FUT',
    WAR: 'WAR',
    BOND: 'BOND',
    CASH: 'CASH',
    FOP: 'FOP',
  }
  return map[secType] ?? secType
}

/**
 * Convert Tiger sec_type to IBKR secType.
 */
function tigerSecTypeToIbkr(secType: string): string {
  const map: Record<string, string> = {
    STK: 'STK',
    OPT: 'OPT',
    FUT: 'FUT',
    WAR: 'WAR',
    IOPT: 'WAR', // HK bull/bear certificates → map to WAR in IBKR terms
    BOND: 'BOND',
    CASH: 'CASH',
  }
  return map[secType] ?? secType
}

// ==================== Contract conversion ====================

/**
 * Build an IBKR Contract from a Tiger contract response object.
 */
export function tigerContractToIbkr(raw: TigerContractRaw): Contract {
  const c = new Contract()
  c.symbol = raw.symbol
  c.secType = tigerSecTypeToIbkr(raw.sec_type ?? 'STK')
  c.currency = raw.currency ?? 'USD'

  // Map Tiger exchange codes to IBKR exchange names
  const exchange = raw.exchange ?? raw.primary_exchange
  if (exchange) c.exchange = tigerExchangeToIbkr(exchange)

  c.localSymbol = raw.identifier ?? raw.symbol
  if (raw.multiplier != null) c.multiplier = String(raw.multiplier)

  return c
}

/**
 * Build a ContractDescription (IBKR) from a Tiger contract raw object.
 */
export function tigerContractToDescription(raw: TigerContractRaw): ContractDescription {
  return {
    contract: tigerContractToIbkr(raw),
    derivativeSecTypes: [],
  }
}

/**
 * Build a ContractDetails (IBKR) from a Tiger contract raw object.
 * Not all IBKR fields are available from Tiger; key fields are populated.
 */
export function tigerContractToDetails(raw: TigerContractRaw): ContractDetails {
  const contract = tigerContractToIbkr(raw)
  return {
    contract,
    marketName: raw.exchange ?? raw.market ?? '',
    longName: raw.name ?? '',
    minTick: 0,
    orderTypes: 'MKT,LMT,STP,STP LMT,TRAIL',
    validExchanges: raw.exchange ?? '',
  } as unknown as ContractDetails
}

/**
 * Map Tiger exchange codes to IBKR exchange names.
 */
function tigerExchangeToIbkr(exchange: string): string {
  const map: Record<string, string> = {
    SEHK: 'SEHK',
    HKFE: 'HKFE',
    NASDAQ: 'NASDAQ',
    NYSE: 'NYSE',
    AMEX: 'AMEX',
    ARCA: 'ARCA',
    BATS: 'BATS',
  }
  return map[exchange] ?? exchange
}

// ==================== Order conversion ====================

/**
 * Build IBKR Order fields from Tiger order response.
 */
export function tigerOrderToIbkr(raw: TigerOrderRaw): Order {
  const o = new Order()
  o.orderId = raw.order_id ?? 0
  o.action = (raw.action ?? 'BUY') as 'BUY' | 'SELL'
  o.orderType = tigerOrderTypeToIbkr(raw.order_type ?? 'LMT')
  o.totalQuantity = new Decimal(raw.quantity ?? 0)
  if (raw.limit_price != null) o.lmtPrice = raw.limit_price
  if (raw.aux_price != null) o.auxPrice = raw.aux_price
  if (raw.trail_stop_price != null) o.trailingPercent = raw.trail_stop_price
  if (raw.trailing_percent != null) o.trailingPercent = raw.trailing_percent
  o.tif = raw.time_in_force ?? 'DAY'
  o.outsideRth = raw.outside_rth ?? false
  if (raw.account) o.account = raw.account
  return o
}

/**
 * Map Tiger order type to IBKR orderType string.
 */
function tigerOrderTypeToIbkr(orderType: string): string {
  const map: Record<string, string> = {
    LMT: 'LMT',
    MKT: 'MKT',
    STP: 'STP',
    STP_LMT: 'STP LMT',
    TRAIL: 'TRAIL',
    TRAIL_LIMIT: 'TRAIL',
  }
  return map[orderType] ?? orderType
}

/**
 * Map IBKR orderType to Tiger order_type string.
 */
export function ibkrOrderTypeToTiger(orderType: string): string {
  const map: Record<string, string> = {
    LMT: 'LMT',
    MKT: 'MKT',
    STP: 'STP',
    'STP LMT': 'STP_LMT',
    TRAIL: 'TRAIL',
    MOC: 'MKT',  // Market-on-close → MKT for Tiger
    LOC: 'LMT',  // Limit-on-close → LMT for Tiger
    REL: 'LMT',  // Relative → LMT fallback
  }
  return map[orderType] ?? 'LMT'
}

/**
 * Build IBKR OrderState from Tiger order status string.
 */
export function tigerStatusToOrderState(status: string): OrderState {
  const os = new OrderState()
  os.status = tigerStatusToIbkr(status)
  return os
}

/**
 * Map Tiger order status to IBKR order status string.
 */
function tigerStatusToIbkr(status: string): string {
  const map: Record<string, string> = {
    PENDING_NEW: 'Submitted',
    NEW: 'Submitted',
    PARTIALLY_FILLED: 'PartiallyFilled',
    FILLED: 'Filled',
    PENDING_CANCEL: 'PendingCancel',
    CANCELLED: 'Cancelled',
    REJECTED: 'Inactive',
    EXPIRED: 'Inactive',
    HELD: 'Submitted',
  }
  return map[status.toUpperCase()] ?? status
}

/**
 * Build an OpenOrder from a Tiger order raw response.
 */
export function tigerOrderToOpenOrder(raw: TigerOrderRaw): OpenOrder {
  const contract = raw.contract
    ? tigerContractToIbkr(raw.contract)
    : buildContractFromOrderRaw(raw)

  const order = tigerOrderToIbkr(raw)
  const orderState = tigerStatusToOrderState(raw.status ?? '')

  return {
    contract,
    order,
    orderState,
    avgFillPrice: raw.avg_fill_price,
  }
}

/** Fallback: build a minimal Contract from order-level symbol/currency fields. */
function buildContractFromOrderRaw(raw: TigerOrderRaw): Contract {
  const c = new Contract()
  c.symbol = raw.symbol ?? ''
  c.secType = 'STK'
  c.currency = 'USD'
  return c
}

// ==================== Position conversion ====================

/**
 * Convert a Tiger position to the unified Position type.
 */
export function tigerPositionToUnified(raw: TigerPositionRaw): Position {
  const contract = raw.contract
    ? tigerContractToIbkr(raw.contract)
    : new Contract()

  const qty = raw.quantity ?? 0
  return {
    contract,
    side: qty >= 0 ? 'long' : 'short',
    quantity: new Decimal(Math.abs(qty)),
    avgCost: raw.average_cost ?? 0,
    marketPrice: raw.market_price ?? 0,
    marketValue: Math.abs(raw.market_value ?? 0),
    unrealizedPnL: raw.unrealized_pnl ?? 0,
    realizedPnL: raw.realized_pnl ?? 0,
  }
}

// ==================== Account info conversion ====================

/**
 * Extract AccountInfo from Tiger assets response.
 * Tiger's assets endpoint returns a PortfolioAccount with a summary.
 */
export function tigerAssetsToAccountInfo(data: unknown): AccountInfo {
  // Tiger `assets` response wraps in a list with a summary object
  const items = Array.isArray(data) ? data : []
  const summary = (items[0] as Record<string, unknown>)?.summary as TigerAssetRaw | undefined

  // Fallback: try data directly as an asset summary
  const asset: TigerAssetRaw = summary ?? (data as TigerAssetRaw) ?? {}

  return {
    netLiquidation: asset.net_liquidation ?? 0,
    totalCashValue: asset.cash ?? 0,
    unrealizedPnL: 0, // Not directly in assets; comes from positions
    realizedPnL: 0,
    buyingPower: asset.buying_power ?? asset.available_funds ?? 0,
    initMarginReq: asset.initial_margin_requirement ?? 0,
    maintMarginReq: asset.maintenance_margin_requirement ?? 0,
    dayTradesRemaining: asset.day_trades_remaining ?? -1,
  }
}

// ==================== Native key ====================

/**
 * Build a native key string for a Tiger contract.
 * Format: "AAPL" for US, "00700.HK" for HK stocks, "00700.HK.OPT" for HK options.
 */
export function buildNativeKey(contract: Contract): string {
  const symbol = contract.symbol ?? ''
  const market = contractMarket(contract)
  const secType = contract.secType ?? 'STK'

  if (market === 'HK') {
    return secType !== 'STK' ? `${symbol}.HK.${secType}` : `${symbol}.HK`
  }
  return secType !== 'STK' ? `${symbol}.${secType}` : symbol
}

/**
 * Reconstruct a trade-ready Contract from a Tiger native key.
 */
export function resolveNativeKey(nativeKey: string): Contract {
  const c = new Contract()

  if (nativeKey.includes('.HK')) {
    // HK stock or derivative: e.g. "00700.HK" or "00700.HK.OPT"
    const parts = nativeKey.split('.')
    c.symbol = parts[0]
    c.exchange = 'SEHK'
    c.currency = 'HKD'
    c.secType = parts[2] ?? 'STK'
  } else if (nativeKey.includes('.')) {
    // US derivative: e.g. "AAPL.OPT"
    const parts = nativeKey.split('.')
    c.symbol = parts[0]
    c.secType = parts[1]
    c.exchange = 'SMART'
    c.currency = 'USD'
  } else {
    // US stock: e.g. "AAPL"
    c.symbol = nativeKey
    c.secType = 'STK'
    c.exchange = 'SMART'
    c.currency = 'USD'
  }

  return c
}

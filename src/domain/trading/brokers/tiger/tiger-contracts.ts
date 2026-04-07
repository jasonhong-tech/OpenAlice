/**
 * Tiger ↔ IBKR contract/order mapping helpers.
 *
 * Tiger API uses its own contract/order format; IBroker uses @traderalice/ibkr types.
 * These helpers translate between them so TigerBroker can satisfy IBroker without
 * leaking Tiger-specific shapes to the rest of the codebase.
 *
 * NOTE: All "Raw" types use camelCase keys as they appear in the Tiger JSON.
 * See tiger-types.ts for full field name documentation and mapping notes.
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
 * Tiger contract JSON uses camelCase: secType, primaryExchange, conid, etc.
 */
export function tigerContractToIbkr(raw: TigerContractRaw): Contract {
  const c = new Contract()
  c.symbol = raw.symbol ?? ''
  // Tiger uses "secType" (camelCase) in JSON responses
  c.secType = tigerSecTypeToIbkr(raw.secType ?? 'STK')
  c.currency = raw.currency ?? 'USD'

  // Tiger uses "primaryExchange" in contract responses (camelCase)
  const exchange = raw.exchange ?? raw.primaryExchange
  if (exchange) c.exchange = tigerExchangeToIbkr(exchange)

  // "identifier" is the local/exchange symbol; "conid" is the internal ID
  c.localSymbol = raw.identifier ?? raw.symbol ?? ''
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
 * Tiger order JSON uses camelCase: orderId, orderType, totalQuantity, limitPrice, etc.
 */
export function tigerOrderToIbkr(raw: TigerOrderRaw): Order {
  const o = new Order()
  // Tiger uses "orderId" (camelCase) in order JSON
  o.orderId = raw.orderId ?? 0
  o.action = (raw.action ?? 'BUY') as 'BUY' | 'SELL'
  // Tiger uses "orderType" (camelCase)
  o.orderType = tigerOrderTypeToIbkr(raw.orderType ?? 'LMT')
  // Tiger uses "totalQuantity" (camelCase) for order quantity
  o.totalQuantity = new Decimal(raw.totalQuantity ?? 0)
  // Tiger uses "limitPrice" (camelCase)
  if (raw.limitPrice != null) o.lmtPrice = raw.limitPrice
  if (raw.auxPrice != null) o.auxPrice = raw.auxPrice
  if (raw.trailStopPrice != null) o.trailStopPrice = raw.trailStopPrice
  if (raw.trailingPercent != null) o.trailingPercent = raw.trailingPercent
  // Tiger uses "timeInForce" (camelCase)
  o.tif = raw.timeInForce ?? 'DAY'
  // Tiger uses "outsideRth" (camelCase)
  o.outsideRth = raw.outsideRth ?? false
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
 *
 * IMPORTANT: Tiger order JSON has contract fields (symbol, currency, secType)
 * FLAT at the top level — there is no nested "contract" sub-object.
 */
export function tigerOrderToOpenOrder(raw: TigerOrderRaw): OpenOrder {
  // Contract info comes from flat fields on the order JSON
  const c = new Contract()
  c.symbol = raw.symbol ?? ''
  // Tiger uses "secType" (camelCase) even in order responses
  c.secType = tigerSecTypeToIbkr(raw.secType ?? 'STK')
  c.currency = raw.currency ?? 'USD'
  if (raw.exchange) c.exchange = tigerExchangeToIbkr(raw.exchange)

  const order = tigerOrderToIbkr(raw)
  const orderState = tigerStatusToOrderState(raw.status ?? '')

  return {
    contract: c,
    order,
    orderState,
    // Tiger uses "avgFillPrice" (camelCase)
    avgFillPrice: raw.avgFillPrice,
  }
}

// ==================== Position conversion ====================

/**
 * Convert a Tiger position to the unified Position type.
 *
 * IMPORTANT: Tiger position JSON has contract fields (symbol, currency, secType)
 * FLAT at the top level — there is no nested "contract" sub-object.
 * SPECIAL field name mappings (from POSITION_FIELD_MAPPINGS in positions_response.py):
 *   "position"    → quantity  (Tiger calls the qty field "position")
 *   "latestPrice" → market_price
 */
export function tigerPositionToUnified(raw: TigerPositionRaw): Position {
  const c = new Contract()
  c.symbol = raw.symbol ?? ''
  // Tiger uses "secType" (camelCase) in position responses
  c.secType = tigerSecTypeToIbkr(raw.secType ?? 'STK')
  c.currency = raw.currency ?? 'USD'
  if (raw.exchange) c.exchange = tigerExchangeToIbkr(raw.exchange)
  c.localSymbol = raw.identifier ?? raw.symbol ?? ''

  // Tiger calls the quantity field "position" (SPECIAL MAPPING)
  const qty = raw.position ?? 0
  return {
    contract: c,
    side: qty >= 0 ? 'long' : 'short',
    quantity: new Decimal(Math.abs(qty)),
    // Tiger calls average cost "averageCost" (camelCase)
    avgCost: raw.averageCost ?? 0,
    // Tiger calls market price "latestPrice" (SPECIAL MAPPING)
    marketPrice: raw.latestPrice ?? 0,
    // Tiger calls market value "marketValue" (camelCase)
    marketValue: Math.abs(raw.marketValue ?? 0),
    // Tiger uses "unrealizedPnl" (camelCase, lowercase l)
    unrealizedPnL: raw.unrealizedPnl ?? 0,
    // Tiger uses "realizedPnl" (camelCase, lowercase l)
    realizedPnL: raw.realizedPnl ?? 0,
  }
}

// ==================== Account info conversion ====================

/**
 * Extract AccountInfo from Tiger assets response data.
 *
 * Handles multiple possible response formats (defensive parsing):
 *
 * Format A — `assets` endpoint (standard accounts):
 *   data = { items: [{ netLiquidation, cashValue, buyingPower, initMarginReq, ... }] }
 *   All fields are camelCase. SPECIAL MAPPINGS from ACCOUNT_FIELD_MAPPINGS:
 *     cashValue → cash, initMarginReq → initial_margin_requirement, etc.
 *
 * Format B — `prime_assets` endpoint (prime/consolidated accounts):
 *   data = { accountId, updateTimestamp, segments: [{ category, netLiquidation, buyingPower, ... }] }
 *   Uses the stock segment (category="S") for equity account info.
 *
 * Format C — direct array (some Tiger API variants):
 *   data = [{ netLiquidation, cashValue, ... }]
 *
 * Format D — flat single object:
 *   data = { netLiquidation, cashValue, ... }
 */
export function tigerAssetsToAccountInfo(data: unknown): AccountInfo {
  if (!data || typeof data !== 'object') {
    return makeZeroAccountInfo()
  }

  const dataObj = data as Record<string, unknown>

  // Format A: { items: [...] }  (standard assets endpoint)
  if (Array.isArray(dataObj.items) && dataObj.items.length > 0) {
    const asset = dataObj.items[0] as TigerAssetRaw
    return extractFromFlatAsset(asset)
  }

  // Format B: { segments: [...] }  (prime_assets endpoint)
  // Use stock segment (category "S") or first available segment
  if (Array.isArray(dataObj.segments) && dataObj.segments.length > 0) {
    const segs = dataObj.segments as Array<Record<string, unknown>>
    const stockSeg = segs.find(s => s.category === 'S') ?? segs[0]
    return {
      netLiquidation: num(stockSeg.netLiquidation),
      totalCashValue: num(stockSeg.cashBalance ?? stockSeg.cashAvailableForTrade),
      unrealizedPnL: num(stockSeg.unrealizedPl ?? stockSeg.unrealizedPnl),
      realizedPnL: num(stockSeg.realizedPl ?? stockSeg.realizedPnl),
      buyingPower: num(stockSeg.buyingPower),
      initMarginReq: num(stockSeg.initMargin ?? stockSeg.initMarginReq),
      maintMarginReq: num(stockSeg.maintainMargin ?? stockSeg.maintMarginReq),
      dayTradesRemaining: -1,
    }
  }

  // Format C: direct array
  if (Array.isArray(data) && data.length > 0) {
    return extractFromFlatAsset(data[0] as TigerAssetRaw)
  }

  // Format D: flat single object (the dataObj itself IS the asset)
  if (dataObj.netLiquidation !== undefined || dataObj.cashValue !== undefined) {
    return extractFromFlatAsset(dataObj as TigerAssetRaw)
  }

  return makeZeroAccountInfo()
}

function extractFromFlatAsset(asset: TigerAssetRaw): AccountInfo {
  return {
    netLiquidation: num(asset.netLiquidation),
    // Tiger: "cashValue" is the special mapping for "cash" in ACCOUNT_FIELD_MAPPINGS
    totalCashValue: num(asset.cashValue),
    unrealizedPnL: num(asset.unrealizedPnL),
    realizedPnL: num(asset.realizedPnL),
    buyingPower: num(asset.buyingPower) || num(asset.availableFunds),
    // Tiger: "initMarginReq" is the special mapping for "initial_margin_requirement"
    initMarginReq: num(asset.initMarginReq),
    maintMarginReq: num(asset.maintMarginReq),
    dayTradesRemaining: (asset.dayTradesRemaining as number) ?? -1,
  }
}

function makeZeroAccountInfo(): AccountInfo {
  return {
    netLiquidation: 0, totalCashValue: 0, unrealizedPnL: 0, realizedPnL: 0,
    buyingPower: 0, initMarginReq: 0, maintMarginReq: 0, dayTradesRemaining: -1,
  }
}

/** Safe number extraction — returns 0 for undefined/null/Infinity */
function num(v: unknown): number {
  if (typeof v === 'number' && isFinite(v)) return v
  return 0
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

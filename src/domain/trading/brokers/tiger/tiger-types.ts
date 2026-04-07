/**
 * TigerBroker configuration and internal types.
 *
 * Tiger Trade uses REST API with RSA-signed requests.
 * Auth: tiger_id + RSA private key (PKCS#1 base64 DER or PEM).
 *
 * IMPORTANT — All raw API response shapes use camelCase field names, matching
 * the actual Tiger JSON. Field names here are derived from the Python SDK's
 * response parsing code (assets_response.py, positions_response.py, etc.).
 */

// ==================== Config ====================

export interface TigerBrokerConfig {
  id?: string
  label?: string
  /** Developer application ID from Tiger Open Platform */
  tigerId: string
  /** RSA private key — base64-encoded PKCS#1 DER or PEM format */
  privateKey: string
  /** Trading account ID (e.g. "DU12345" for paper, numeric for live) */
  account: string
  /** Whether this is a paper trading account. Default: false */
  paper?: boolean
  /** Account license code (e.g. "TBSG", "TBNZ", "TBUS"). Auto-detected if omitted. */
  license?: string
  /** Override gateway URL. Default: https://openapi.tigerfintech.com/gateway */
  serverUrl?: string
}

// ==================== Tiger API response shapes ====================

export interface TigerApiResponse {
  code: number
  message: string
  sign?: string
  data?: unknown
}

export interface TigerOrderIdData {
  id?: number
  order_id?: number   // from order_no endpoint (snake_case in that specific response)
  sub_ids?: number[]
}

/**
 * Tiger contract raw shape — camelCase keys from Tiger API JSON.
 * Source: contracts_response.py (CONTRACT_FIELD_MAPPINGS: conid→contract_id, right→put_call)
 */
export interface TigerContractRaw {
  symbol?: string
  identifier?: string
  currency?: string
  secType?: string         // camelCase — maps to IBKR secType
  exchange?: string
  primaryExchange?: string // camelCase
  market?: string
  name?: string
  multiplier?: number
  lotSize?: number
  conid?: number           // camelCase — Tiger's internal contract ID
  right?: string           // for options: CALL/PUT
  expiry?: string
  strike?: number
}

/**
 * Tiger position raw shape — camelCase keys from Tiger API JSON.
 * Source: positions_response.py
 * SPECIAL MAPPINGS (from POSITION_FIELD_MAPPINGS):
 *   "position"    → quantity
 *   "latestPrice" → market_price
 * All other fields are camelCase (converted to snake_case by Python's camel_to_underline).
 */
export interface TigerPositionRaw {
  account?: string
  symbol?: string
  currency?: string
  secType?: string         // camelCase
  exchange?: string
  market?: string
  identifier?: string
  position?: number        // SPECIAL: Tiger calls it "position", maps to quantity
  latestPrice?: number     // SPECIAL: maps to market_price
  averageCost?: number     // camelCase → average_cost
  marketValue?: number     // camelCase → market_value
  unrealizedPnl?: number   // camelCase (lowercase l) → unrealized_pnl
  realizedPnl?: number     // camelCase (lowercase l) → realized_pnl
  salableQty?: number      // camelCase → salable_qty
}

/**
 * Tiger order raw shape — camelCase keys from Tiger API JSON.
 * Source: orders_response.py (ORDER_FIELD_MAPPINGS)
 * Contract fields (symbol, currency, secType, exchange) are FLAT in the order JSON,
 * not nested in a "contract" sub-object.
 * SPECIAL MAPPINGS:
 *   "orderId"        → order_id
 *   "orderType"      → order_type
 *   "limitPrice"     → limit_price
 *   "auxPrice"       → aux_price
 *   "totalQuantity"  → quantity
 *   "timeInForce"    → time_in_force
 *   "outsideRth"     → outside_rth
 *   "avgFillPrice"   → avg_fill_price
 *   "openTime"       → order_time
 *   "latestTime"     → trade_time
 *   "trailStopPrice" → trail_stop_price
 *   "trailingPercent"→ trailing_percent
 */
export interface TigerOrderRaw {
  id?: number              // global Tiger order ID (int64)
  orderId?: number         // account-level order ID
  account?: string
  // Contract fields (flat, not nested):
  symbol?: string
  currency?: string
  secType?: string
  exchange?: string
  // Order fields:
  action?: string          // BUY | SELL
  orderType?: string       // LMT | MKT | STP | ...
  totalQuantity?: number   // SPECIAL: maps to quantity
  filledQuantity?: number  // SPECIAL: maps to filled
  limitPrice?: number      // SPECIAL: maps to limit_price
  auxPrice?: number        // SPECIAL: maps to aux_price
  trailStopPrice?: number  // SPECIAL: maps to trail_stop_price
  trailingPercent?: number // SPECIAL: maps to trailing_percent
  avgFillPrice?: number    // SPECIAL: maps to avg_fill_price
  timeInForce?: string     // SPECIAL: maps to time_in_force
  outsideRth?: boolean     // SPECIAL: maps to outside_rth
  status?: string
  openTime?: number        // SPECIAL: maps to order_time
  updateTime?: number
  latestTime?: number      // SPECIAL: maps to trade_time
  remark?: string          // SPECIAL: maps to reason
}

/**
 * Tiger assets raw shape — camelCase keys from Tiger API JSON.
 * Source: assets_response.py (ACCOUNT_FIELD_MAPPINGS)
 * Tiger API returns: data = { items: [TigerAssetRaw, ...] }
 * SPECIAL MAPPINGS (from ACCOUNT_FIELD_MAPPINGS):
 *   "cashValue"    → cash
 *   "initMarginReq"   → initial_margin_requirement
 *   "maintMarginReq"  → maintenance_margin_requirement
 *   "realizedPnL"  → realized_pnl
 *   "unrealizedPnL"→ unrealized_pnl
 * All other fields: camelCase → snake_case via camel_to_underline
 */
export interface TigerAssetRaw {
  netLiquidation?: number    // camelCase → net_liquidation
  cashValue?: number         // SPECIAL → cash (Tiger calls it cashValue)
  buyingPower?: number       // camelCase → buying_power
  availableFunds?: number    // camelCase → available_funds
  initMarginReq?: number     // SPECIAL → initial_margin_requirement
  maintMarginReq?: number    // SPECIAL → maintenance_margin_requirement
  dayTradesRemaining?: number // camelCase → day_trades_remaining
  realizedPnL?: number       // SPECIAL → realized_pnl
  unrealizedPnL?: number     // SPECIAL → unrealized_pnl
  grossPositionValue?: number
  excessLiquidity?: number
}

/**
 * Tiger quote brief raw shape — camelCase keys from Tiger API JSON.
 * Source: quote_brief_response.py (BRIEF_FIELD_MAPPINGS)
 * Tiger API returns: data = { items: [TigerQuoteBriefRaw, ...] }
 * SPECIAL MAPPINGS (from BRIEF_FIELD_MAPPINGS):
 *   "latestPrice" → latest_price
 *   "preClose"    → prev_close  (NOTE: "preClose" not "prevClose")
 *   "timestamp"   → latest_time (NOTE: "timestamp" not "latestTime")
 *   "askPrice"    → ask_price
 *   "askSize"     → ask_size
 *   "bidPrice"    → bid_price
 *   "bidSize"     → bid_size
 *   "secType"     → sec_type
 */
export interface TigerQuoteBriefRaw {
  symbol?: string
  market?: string
  secType?: string
  name?: string
  latestPrice?: number     // SPECIAL: → latest_price
  preClose?: number        // SPECIAL: → prev_close (Tiger calls it "preClose")
  timestamp?: number       // SPECIAL: → latest_time (Tiger calls it "timestamp")
  volume?: number
  openPrice?: number       // camelCase → open_price
  highPrice?: number       // camelCase → high_price
  lowPrice?: number        // camelCase → low_price
  bidPrice?: number        // SPECIAL: → bid_price
  askPrice?: number        // SPECIAL: → ask_price
  bidSize?: number         // SPECIAL: → bid_size
  askSize?: number         // SPECIAL: → ask_size
  halted?: number          // 0=normal, 3=halt, 4=delisted
  change?: number
}

/**
 * Tiger market_state raw shape — fields from market_status_response.py.
 * Data structure: data = direct list (not wrapped in items[]).
 *
 * JSON field mapping (from market_status_response.py parse logic):
 *   "market"       → market identifier ("US", "HK", "CN")
 *   "status"       → trading_status ENUM ("TRADING", "NOT_YET_OPEN", "CLOSED", "NOON_BREAK")
 *   "marketStatus" → human-readable label ("Trading", "Not Yet Opened", etc.)
 *   "openTime"     → next open time as string, e.g. "2025-08-12 09:30 EDT"
 *
 * IMPORTANT: Check "status" (the enum) for isOpen, NOT "marketStatus" (the label).
 */
export interface TigerMarketStatusRaw {
  market?: string
  status?: string        // ENUM: "TRADING" | "NOT_YET_OPEN" | "CLOSED" | "NOON_BREAK" | ...
  marketStatus?: string  // Human-readable label: "Trading", "Not Yet Opened", etc.
  openTime?: string      // Next open time as string, e.g. "2025-08-12 09:30 EDT"
}

/**
 * TigerBroker configuration and internal types.
 *
 * Tiger Trade uses REST API with RSA-signed requests.
 * Auth: tiger_id + RSA private key (PKCS#1 base64 DER or PEM).
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
  order_id?: number
  sub_ids?: number[]
}

export interface TigerContractRaw {
  symbol: string
  identifier?: string
  currency?: string
  sec_type?: string
  exchange?: string
  primary_exchange?: string
  market?: string
  name?: string
  multiplier?: number
  lot_size?: number
  contract_id?: number
}

export interface TigerPositionRaw {
  account?: string
  contract?: TigerContractRaw
  quantity?: number
  average_cost?: number
  market_price?: number
  market_value?: number
  realized_pnl?: number
  unrealized_pnl?: number
  salable_qty?: number
}

export interface TigerOrderRaw {
  id?: number
  order_id?: number
  account?: string
  symbol?: string
  action?: string
  order_type?: string
  quantity?: number
  filled?: number
  remaining?: number
  limit_price?: number
  aux_price?: number
  trail_stop_price?: number
  trailing_percent?: number
  avg_fill_price?: number
  time_in_force?: string
  outside_rth?: boolean
  status?: string
  order_time?: number
  update_time?: number
  trade_time?: number
  contract?: TigerContractRaw
  reason?: string
}

export interface TigerAssetRaw {
  net_liquidation?: number
  cash?: number
  buying_power?: number
  available_funds?: number
  initial_margin_requirement?: number
  maintenance_margin_requirement?: number
  day_trades_remaining?: number
  excess_liquidity?: number
  gross_position_value?: number
}

export interface TigerQuoteBriefRaw {
  symbol?: string
  market?: string
  sec_type?: string
  latest_price?: number
  prev_close?: number
  latest_time?: number
  volume?: number
  open_price?: number
  high_price?: number
  low_price?: number
  bid_price?: number
  ask_price?: number
  bid_size?: number
  ask_size?: number
  halted?: number
}

export interface TigerMarketStatusRaw {
  market?: string
  status?: string
  trading_status?: string
  open_time?: number
}

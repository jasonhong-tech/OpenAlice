/**
 * SnapTrade broker config and loose SDK response shapes.
 *
 * SnapTrade's generated SDK is loaded dynamically so OpenAlice can still
 * typecheck before dependencies are installed. These minimal shapes cover the
 * endpoints the broker adapter uses.
 */

export interface SnaptradeBrokerConfig {
  id?: string
  label?: string
  clientId: string
  consumerKey: string
  userId: string
  userSecret: string
  accountId: string
  basePath?: string
}

export interface SnaptradeSdkResponse<T> {
  data: T
}

export interface SnaptradeSdkClient {
  apiStatus: {
    check(): Promise<SnaptradeSdkResponse<unknown>>
  }
  accountInformation: {
    getUserAccountDetails(params: SnaptradeAuthParams): Promise<SnaptradeSdkResponse<SnaptradeAccountRaw>>
    getUserAccountBalance(params: SnaptradeAuthParams): Promise<SnaptradeSdkResponse<SnaptradeBalanceRaw[]>>
    getAllAccountPositions(params: SnaptradeAuthParams): Promise<SnaptradeSdkResponse<{ results?: SnaptradePositionRaw[] }>>
    getUserAccountOrders(params: SnaptradeAuthParams & { state?: 'all' | 'open' | 'executed'; days?: number }): Promise<SnaptradeSdkResponse<SnaptradeOrderRaw[]>>
    getUserAccountOrderDetail(params: SnaptradeAuthParams & { brokerage_order_id: string }): Promise<SnaptradeSdkResponse<SnaptradeOrderRaw>>
  }
  referenceData: {
    symbolSearchUserAccount(params: SnaptradeAuthParams & { substring?: string }): Promise<SnaptradeSdkResponse<SnaptradeUniversalSymbolRaw[]>>
  }
  trading: {
    getUserAccountQuotes(params: SnaptradeAuthParams & { symbols: string; useTicker?: boolean }): Promise<SnaptradeSdkResponse<SnaptradeQuoteRaw[]>>
    placeForceOrder(params: Record<string, unknown>): Promise<SnaptradeSdkResponse<SnaptradeOrderRaw>>
    replaceOrder(params: Record<string, unknown>): Promise<SnaptradeSdkResponse<SnaptradeOrderRaw>>
    cancelUserAccountOrder(params: SnaptradeAuthParams & { brokerage_order_id: string }): Promise<SnaptradeSdkResponse<SnaptradeOrderRaw>>
  }
}

export interface SnaptradeAuthParams {
  userId: string
  userSecret: string
  accountId: string
}

export interface SnaptradeAccountRaw {
  id: string
  name?: string | null
  number?: string
  institution_name?: string
  balance?: { total?: { amount?: number; currency?: string } | null }
}

export interface SnaptradeBalanceRaw {
  currency?: { code?: string }
  cash?: number | null
  buying_power?: number | null
}

export interface SnaptradeInstrumentRaw {
  kind?: string
  id?: string
  symbol?: string
  raw_symbol?: string
  description?: string | null
  currency?: string | null
  exchange?: string | null
  option_type?: 'CALL' | 'PUT'
  strike_price?: string | number
  expiration_date?: string
  underlying?: {
    symbol?: string
    raw_symbol?: string
    currency?: string | null
    exchange?: string | null
  }
}

export interface SnaptradePositionRaw {
  instrument?: SnaptradeInstrumentRaw
  units?: string | null
  price?: string | null
  cost_basis?: string | null
  currency?: string | null
  cash_equivalent?: boolean
}

export interface SnaptradeUniversalSymbolRaw {
  id?: string
  symbol?: string
  raw_symbol?: string
  description?: string | null
  currency?: { code?: string }
  exchange?: { code?: string; mic_code?: string }
  type?: { code?: string; description?: string }
}

export interface SnaptradeOrderRaw {
  brokerage_order_id?: string
  status?: string
  universal_symbol?: SnaptradeUniversalSymbolRaw | null
  option_symbol?: {
    id?: string
    ticker?: string
    option_type?: 'CALL' | 'PUT'
    strike_price?: number
    expiration_date?: string
    underlying_symbol?: {
      symbol?: string
      raw_symbol?: string
      currency?: { code?: string }
      exchange?: { code?: string; mic_code?: string }
    }
  } | null
  action?: string
  total_quantity?: string | null
  open_quantity?: string | null
  filled_quantity?: string | null
  execution_price?: number | null
  limit_price?: number | null
  stop_price?: number | null
  order_type?: string | null
  time_in_force?: string
  symbol?: string
}

export interface SnaptradeQuoteRaw {
  symbol?: SnaptradeUniversalSymbolRaw
  last_trade_price?: number
  bid_price?: number
  ask_price?: number
}

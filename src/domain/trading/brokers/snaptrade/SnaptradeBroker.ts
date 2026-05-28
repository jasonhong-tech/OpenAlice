/**
 * SnaptradeBroker — IBroker adapter for SnapTrade connected brokerage accounts.
 *
 * SnapTrade is a broker aggregator: the SDK is initialized with partner
 * credentials, then every account operation is scoped with userId,
 * userSecret, and the connected brokerage accountId.
 */

import { z } from 'zod'
import Decimal from 'decimal.js'
import {
  Contract,
  Order,
  OrderState,
  UNSET_DECIMAL,
  UNSET_DOUBLE,
} from '@traderalice/ibkr'
import type { ContractDescription, ContractDetails, OrderCancel } from '@traderalice/ibkr'
import {
  BrokerError,
  type AccountCapabilities,
  type AccountInfo,
  type BrokerConfigField,
  type IBroker,
  type MarketClock,
  type OpenOrder,
  type PlaceOrderResult,
  type Position,
  type Quote,
} from '../types.js'
import '../../contract-ext.js'
import type {
  SnaptradeAuthParams,
  SnaptradeBalanceRaw,
  SnaptradeBrokerConfig,
  SnaptradeInstrumentRaw,
  SnaptradeOrderRaw,
  SnaptradePositionRaw,
  SnaptradeQuoteRaw,
  SnaptradeSdkClient,
  SnaptradeUniversalSymbolRaw,
} from './snaptrade-types.js'

type SnaptradeConstructor = new (config: {
  clientId?: string
  consumerKey?: string
  basePath?: string
}) => SnaptradeSdkClient

type SnaptradeOrderType = 'Market' | 'Limit' | 'Stop' | 'StopLimit'
type SnaptradeTif = 'Day' | 'GTC' | 'FOK' | 'IOC'
type SnaptradeAction = 'BUY' | 'SELL' | 'BUY_TO_OPEN' | 'BUY_TO_CLOSE' | 'SELL_TO_OPEN' | 'SELL_TO_CLOSE'

const ORDER_LOOKBACK_DAYS = 90

const optionalString = z.preprocess(
  v => typeof v === 'string' && v.trim() === '' ? undefined : v,
  z.string().trim().optional(),
)

async function loadSnaptradeConstructor(): Promise<SnaptradeConstructor> {
  try {
    const moduleName: string = 'snaptrade-typescript-sdk'
    const mod = await import(moduleName) as { Snaptrade?: unknown }
    if (typeof mod.Snaptrade !== 'function') {
      throw new Error('Snaptrade export is missing from snaptrade-typescript-sdk')
    }
    return mod.Snaptrade as SnaptradeConstructor
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new BrokerError(
      'CONFIG',
      `snaptrade-typescript-sdk is not installed or cannot be loaded. Run pnpm install after adding the dependency. ${message}`,
    )
  }
}

function snaptradeErrorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const maybeResponse = err as {
      response?: {
        status?: number
        statusText?: string
        data?: unknown
      }
      message?: string
    }
    const data = maybeResponse.response?.data
    if (data != null) {
      const detail = typeof data === 'string' ? data : JSON.stringify(data)
      const status = maybeResponse.response?.status
      const prefix = status ? `SnapTrade API error ${status}` : 'SnapTrade API error'
      return `${prefix}: ${detail}`
    }
    if (maybeResponse.message) return maybeResponse.message
  }
  return String(err)
}

function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function decimal(v: unknown): Decimal {
  if (v == null || v === '') return new Decimal(0)
  try {
    return new Decimal(String(v))
  } catch {
    return new Decimal(0)
  }
}

function isSetPrice(v: number | undefined): v is number {
  return v != null && v !== UNSET_DOUBLE && Number.isFinite(v)
}

function hasQuantity(order: Order): boolean {
  return order.totalQuantity != null && !order.totalQuantity.equals(UNSET_DECIMAL)
}

function encodePart(value: string): string {
  return encodeURIComponent(value)
}

function decodePart(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function buildNativeKeyFromParts(id: string, symbol: string, secType: string): string {
  return [id, symbol, secType].map(encodePart).join('::')
}

function parseNativeKey(nativeKey: string): { id: string; symbol: string; secType: string } {
  const [rawId, rawSymbol, rawSecType] = nativeKey.split('::')
  const id = decodePart(rawId ?? '')
  const symbol = decodePart(rawSymbol ?? rawId ?? '')
  const secType = decodePart(rawSecType ?? 'STK') || 'STK'
  return {
    id,
    symbol,
    secType,
  }
}

function secTypeFromSnaptrade(kindOrCode?: string | null): string {
  const norm = (kindOrCode ?? '').replace(/[_\s-]/g, '').toUpperCase()
  switch (norm) {
    case 'STOCK':
    case 'EQUITY':
    case 'ETF':
    case 'ADR':
    case 'CEF':
      return 'STK'
    case 'MUTUALFUND':
    case 'MUTUALFUNDS':
    case 'MF':
      return 'FUND'
    case 'OPTION':
    case 'OPTIONS':
      return 'OPT'
    case 'CRYPTO':
    case 'CRYPTOCURRENCY':
      return 'CRYPTO'
    case 'FUTURE':
    case 'FUTURES':
      return 'FUT'
    default:
      return 'STK'
  }
}

function exchangeOrSmart(exchange?: string | null): string {
  return exchange?.trim() || 'SMART'
}

function contractFromUniversalSymbol(raw: SnaptradeUniversalSymbolRaw): Contract {
  const c = new Contract()
  c.symbol = raw.raw_symbol ?? raw.symbol ?? ''
  c.localSymbol = raw.id ?? raw.symbol ?? c.symbol
  c.secType = secTypeFromSnaptrade(raw.type?.code)
  c.currency = raw.currency?.code ?? 'USD'
  c.exchange = exchangeOrSmart(raw.exchange?.mic_code ?? raw.exchange?.code)
  return c
}

function contractFromOptionSymbol(raw: NonNullable<SnaptradeOrderRaw['option_symbol']>): Contract {
  const c = new Contract()
  c.symbol = raw.underlying_symbol?.raw_symbol ?? raw.underlying_symbol?.symbol ?? raw.ticker ?? ''
  c.localSymbol = raw.id ?? raw.ticker ?? c.symbol
  c.secType = 'OPT'
  c.currency = raw.underlying_symbol?.currency?.code ?? 'USD'
  c.exchange = exchangeOrSmart(raw.underlying_symbol?.exchange?.mic_code ?? raw.underlying_symbol?.exchange?.code)
  if (raw.expiration_date) c.lastTradeDateOrContractMonth = raw.expiration_date.replace(/-/g, '')
  if (raw.strike_price != null) c.strike = raw.strike_price
  if (raw.option_type) c.right = raw.option_type === 'CALL' ? 'C' : 'P'
  c.multiplier = '100'
  return c
}

function contractFromInstrument(raw: SnaptradeInstrumentRaw | undefined): Contract {
  const c = new Contract()
  if (!raw) {
    c.secType = 'STK'
    c.exchange = 'SMART'
    c.currency = 'USD'
    return c
  }

  if (raw.kind === 'option') {
    c.symbol = raw.underlying?.raw_symbol ?? raw.underlying?.symbol ?? raw.symbol ?? ''
    c.localSymbol = raw.id ?? raw.symbol ?? c.symbol
    c.secType = 'OPT'
    c.currency = raw.underlying?.currency ?? 'USD'
    c.exchange = exchangeOrSmart(raw.underlying?.exchange)
    if (raw.expiration_date) c.lastTradeDateOrContractMonth = raw.expiration_date.replace(/-/g, '')
    if (raw.strike_price != null) c.strike = num(raw.strike_price)
    if (raw.option_type) c.right = raw.option_type === 'CALL' ? 'C' : 'P'
    c.multiplier = '100'
    return c
  }

  c.symbol = raw.raw_symbol ?? raw.symbol ?? ''
  c.localSymbol = raw.id ?? raw.symbol ?? c.symbol
  c.secType = secTypeFromSnaptrade(raw.kind)
  c.currency = raw.currency ?? 'USD'
  c.exchange = exchangeOrSmart(raw.exchange)
  return c
}

function orderTypeToSnaptrade(orderType: string): SnaptradeOrderType {
  switch ((orderType || 'MKT').toUpperCase()) {
    case 'MKT':
    case 'MARKET':
      return 'Market'
    case 'LMT':
    case 'LIMIT':
      return 'Limit'
    case 'STP':
    case 'STOP':
      return 'Stop'
    case 'STP LMT':
    case 'STOPLIMIT':
    case 'STOP_LIMIT':
      return 'StopLimit'
    default:
      throw new BrokerError('EXCHANGE', `SnapTrade does not support order type "${orderType}".`)
  }
}

function orderTypeToIbkr(orderType?: string | null): string {
  switch ((orderType ?? '').replace(/[_\s-]/g, '').toUpperCase()) {
    case 'MARKET': return 'MKT'
    case 'LIMIT': return 'LMT'
    case 'STOP': return 'STP'
    case 'STOPLIMIT': return 'STP LMT'
    default: return orderType ?? 'MKT'
  }
}

function tifToSnaptrade(tif: string): SnaptradeTif {
  switch ((tif || 'DAY').toUpperCase()) {
    case 'DAY':
      return 'Day'
    case 'GTC':
      return 'GTC'
    case 'FOK':
      return 'FOK'
    case 'IOC':
      return 'IOC'
    default:
      throw new BrokerError('EXCHANGE', `SnapTrade does not support time in force "${tif}".`)
  }
}

function tifToIbkr(tif?: string): string {
  if (!tif) return 'DAY'
  return tif === 'Day' ? 'DAY' : tif.toUpperCase()
}

function actionToSnaptrade(action: string): SnaptradeAction {
  const norm = action.replace(/_OPEN$/i, '_TO_OPEN').replace(/_CLOSE$/i, '_TO_CLOSE').toUpperCase()
  if (
    norm === 'BUY' ||
    norm === 'SELL' ||
    norm === 'BUY_TO_OPEN' ||
    norm === 'BUY_TO_CLOSE' ||
    norm === 'SELL_TO_OPEN' ||
    norm === 'SELL_TO_CLOSE'
  ) {
    return norm
  }
  throw new BrokerError('EXCHANGE', `SnapTrade does not support action "${action}".`)
}

function actionToIbkr(action?: string): string {
  const norm = (action ?? 'BUY').toUpperCase()
  if (norm.startsWith('SELL')) return 'SELL'
  return 'BUY'
}

function snaptradeStatusToIbkr(status?: string): string {
  const norm = (status ?? '').toUpperCase()
  switch (norm) {
    case 'PENDING':
    case 'ACCEPTED':
    case 'PARTIAL':
    case 'QUEUED':
    case 'TRIGGERED':
    case 'ACTIVATED':
    case 'REPLACE_PENDING':
    case 'PENDING_RISK_REVIEW':
      return 'Submitted'
    case 'REPLACED':
      return 'Cancelled'
    case 'CANCEL_PENDING':
      return 'PendingCancel'
    case 'EXECUTED':
      return 'Filled'
    case 'CANCELED':
    case 'PARTIAL_CANCELED':
      return 'Cancelled'
    case 'FAILED':
    case 'REJECTED':
    case 'EXPIRED':
    case 'STOPPED':
    case 'SUSPENDED':
    case 'NONE':
      return 'Inactive'
    default:
      return status || 'Submitted'
  }
}

function makeOrderState(status?: string): OrderState {
  const os = new OrderState()
  os.status = snaptradeStatusToIbkr(status)
  return os
}

function canonicalOrderId(raw: SnaptradeOrderRaw): string {
  return raw.brokerage_order_id ?? ''
}

function orderContract(raw: SnaptradeOrderRaw): Contract {
  if (raw.option_symbol) return contractFromOptionSymbol(raw.option_symbol)
  if (raw.universal_symbol) return contractFromUniversalSymbol(raw.universal_symbol)

  const c = new Contract()
  c.symbol = raw.symbol ?? ''
  c.localSymbol = raw.symbol ?? ''
  c.secType = 'STK'
  c.currency = 'USD'
  c.exchange = 'SMART'
  return c
}

function orderQuantity(raw: SnaptradeOrderRaw): Decimal {
  const total = decimal(raw.total_quantity)
  if (!total.isZero()) return total.abs()
  return decimal(raw.open_quantity).plus(decimal(raw.filled_quantity)).abs()
}

function rawOrderToOpenOrder(raw: SnaptradeOrderRaw): OpenOrder {
  const order = new Order()
  order.action = actionToIbkr(raw.action)
  order.totalQuantity = orderQuantity(raw)
  order.orderType = orderTypeToIbkr(raw.order_type)
  order.tif = tifToIbkr(raw.time_in_force)
  if (raw.limit_price != null) order.lmtPrice = raw.limit_price
  if (raw.stop_price != null) order.auxPrice = raw.stop_price

  return {
    orderId: canonicalOrderId(raw),
    contract: orderContract(raw),
    order,
    orderState: makeOrderState(raw.status),
    avgFillPrice: raw.execution_price ?? undefined,
  }
}

export class SnaptradeBroker implements IBroker {
  // ---- Self-registration ----

  static configSchema = z.object({
    clientId: z.string().min(1),
    consumerKey: z.string().min(1),
    userId: z.string().min(1),
    userSecret: z.string().min(1),
    accountId: z.string().min(1),
    basePath: optionalString,
  })

  static configFields: BrokerConfigField[] = [
    {
      name: 'clientId',
      type: 'text',
      label: 'Client ID',
      placeholder: 'SnapTrade partner client ID',
      required: true,
    },
    {
      name: 'userId',
      type: 'text',
      label: 'User ID',
      placeholder: 'SnapTrade userId for the connected user',
      required: true,
    },
    {
      name: 'accountId',
      type: 'text',
      label: 'Account ID',
      placeholder: 'Connected brokerage account UUID',
      required: true,
    },
    {
      name: 'basePath',
      type: 'text',
      label: 'API Base URL (optional)',
      placeholder: 'https://api.snaptrade.com/api/v1',
      description: 'Leave blank for the SDK default SnapTrade endpoint.',
    },
    {
      name: 'consumerKey',
      type: 'password',
      label: 'Consumer Key',
      placeholder: 'SnapTrade partner consumer key',
      required: true,
      sensitive: true,
    },
    {
      name: 'userSecret',
      type: 'password',
      label: 'User Secret',
      placeholder: 'Secret returned when the SnapTrade user was registered',
      required: true,
      sensitive: true,
    },
  ]

  static fromConfig(config: { id: string; label?: string; brokerConfig: Record<string, unknown> }): SnaptradeBroker {
    const bc = SnaptradeBroker.configSchema.parse(config.brokerConfig)
    return new SnaptradeBroker({
      id: config.id,
      label: config.label,
      clientId: bc.clientId,
      consumerKey: bc.consumerKey,
      userId: bc.userId,
      userSecret: bc.userSecret,
      accountId: bc.accountId,
      basePath: bc.basePath,
    })
  }

  readonly id: string
  readonly label: string

  private readonly config: SnaptradeBrokerConfig
  private client?: SnaptradeSdkClient

  constructor(config: SnaptradeBrokerConfig) {
    this.config = config
    this.id = config.id ?? 'snaptrade'
    this.label = config.label ?? 'SnapTrade'
  }

  // ==================== Lifecycle ====================

  async init(): Promise<void> {
    const Snaptrade = await loadSnaptradeConstructor()
    this.client = new Snaptrade({
      clientId: this.config.clientId,
      consumerKey: this.config.consumerKey,
      basePath: this.config.basePath,
    })

    try {
      await this.client.apiStatus.check()
      const account = await this.client.accountInformation.getUserAccountDetails(this.auth())
      const raw = account.data
      console.log(
        `SnaptradeBroker[${this.id}]: connected (account=${this.config.accountId}, institution=${raw.institution_name ?? raw.name ?? 'unknown'})`,
      )
    } catch (err) {
      throw BrokerError.from(new Error(snaptradeErrorMessage(err)), 'AUTH')
    }
  }

  async close(): Promise<void> {
    // SnapTrade SDK is request/response based; there is no persistent connection.
  }

  // ==================== Contract search ====================

  async searchContracts(pattern: string): Promise<ContractDescription[]> {
    if (!pattern) return []
    const client = this.requireClient()
    try {
      const response = await client.referenceData.symbolSearchUserAccount({
        ...this.auth(),
        substring: pattern,
      })
      return response.data.map(raw => ({
        contract: contractFromUniversalSymbol(raw),
        derivativeSecTypes: [],
      }))
    } catch {
      return []
    }
  }

  async getContractDetails(query: Contract): Promise<ContractDetails | null> {
    const nativeKey = query.aliceId?.includes('|') ? query.aliceId.slice(query.aliceId.indexOf('|') + 1) : undefined
    const contract = nativeKey ? this.resolveNativeKey(nativeKey) : await this.resolveContractQuery(query)
    if (!contract) return null

    return {
      contract,
      marketName: contract.exchange ?? '',
      longName: contract.symbol ?? '',
      minTick: 0,
      orderTypes: 'MKT,LMT,STP,STP LMT',
      validExchanges: contract.exchange ?? 'SMART',
    } as unknown as ContractDetails
  }

  // ==================== Trading operations ====================

  async placeOrder(contract: Contract, order: Order): Promise<PlaceOrderResult> {
    const client = this.requireClient()
    try {
      const request = this.buildPlaceOrderRequest(contract, order)
      const response = await client.trading.placeForceOrder(request)
      return this.placeOrderResult(response.data)
    } catch (err) {
      return { success: false, error: snaptradeErrorMessage(err) }
    }
  }

  async modifyOrder(orderId: string, changes: Partial<Order>): Promise<PlaceOrderResult> {
    const client = this.requireClient()
    try {
      const existing = await this.getOrder(orderId)
      if (!existing) return { success: false, error: `Order ${orderId} not found` }

      const merged = new Order()
      Object.assign(merged, existing.order, changes)
      const orderType = orderTypeToSnaptrade(merged.orderType || 'MKT')
      const request: Record<string, unknown> = {
        ...this.auth(),
        accountId: this.config.accountId,
        brokerage_order_id: existing.orderId || orderId,
        action: actionToIbkr(merged.action),
        order_type: orderType,
        time_in_force: tifToSnaptrade(merged.tif || 'DAY'),
      }

      const ticker = existing.contract.symbol
      if (ticker) request.symbol = ticker
      if (hasQuantity(merged)) request.units = merged.totalQuantity.toNumber()
      this.addOrderPrices(request, orderType, merged)

      const response = await client.trading.replaceOrder(request)
      return this.placeOrderResult(response.data, existing.orderId || orderId)
    } catch (err) {
      return { success: false, error: snaptradeErrorMessage(err) }
    }
  }

  async cancelOrder(orderId: string, _orderCancel?: OrderCancel): Promise<PlaceOrderResult> {
    const client = this.requireClient()
    try {
      const response = await client.trading.cancelUserAccountOrder({
        ...this.auth(),
        brokerage_order_id: orderId,
      })
      return this.placeOrderResult(response.data, orderId)
    } catch (err) {
      return { success: false, error: snaptradeErrorMessage(err) }
    }
  }

  async closePosition(contract: Contract, quantity?: Decimal): Promise<PlaceOrderResult> {
    const positions = await this.getPositions()
    const nativeKey = this.getNativeKey(contract)
    const pos = positions.find(p =>
      this.getNativeKey(p.contract) === nativeKey ||
      (contract.symbol != null && p.contract.symbol === contract.symbol),
    )
    if (!pos) return { success: false, error: `No open position for ${contract.symbol ?? nativeKey}` }

    const closeOrder = new Order()
    if (pos.contract.secType === 'OPT') {
      closeOrder.action = pos.side === 'long' ? 'SELL_TO_CLOSE' : 'BUY_TO_CLOSE'
    } else {
      closeOrder.action = pos.side === 'long' ? 'SELL' : 'BUY'
    }
    closeOrder.orderType = 'MKT'
    closeOrder.totalQuantity = quantity ?? pos.quantity
    closeOrder.tif = 'DAY'
    return this.placeOrder(pos.contract, closeOrder)
  }

  // ==================== Queries ====================

  async getAccount(): Promise<AccountInfo> {
    const client = this.requireClient()
    try {
      const [details, balances, positions] = await Promise.all([
        client.accountInformation.getUserAccountDetails(this.auth()),
        client.accountInformation.getUserAccountBalance(this.auth()),
        this.getPositions(),
      ])

      const cash = sumBalances(balances.data, 'cash')
      const buyingPower = sumBalances(balances.data, 'buying_power')
      const positionsValue = positions.reduce((sum, p) => sum + p.marketValue, 0)
      const netLiquidation = details.data.balance?.total?.amount ?? cash + positionsValue
      const unrealizedPnL = positions.reduce((sum, p) => sum + p.unrealizedPnL, 0)

      return {
        netLiquidation,
        totalCashValue: cash,
        unrealizedPnL,
        realizedPnL: 0,
        buyingPower,
      }
    } catch (err) {
      throw BrokerError.from(new Error(snaptradeErrorMessage(err)))
    }
  }

  async getPositions(): Promise<Position[]> {
    const client = this.requireClient()
    try {
      const response = await client.accountInformation.getAllAccountPositions(this.auth())
      return (response.data.results ?? [])
        .map(raw => this.mapPosition(raw))
        .filter((position): position is Position => position != null)
    } catch (err) {
      throw BrokerError.from(new Error(snaptradeErrorMessage(err)))
    }
  }

  async getOrders(orderIds: string[]): Promise<OpenOrder[]> {
    if (orderIds.length === 0) return []
    const requested = new Set(orderIds)
    const results = await this.fetchRecentOrders('all')
    const found = results.filter(order => requested.has(order.orderId))
    const foundIds = new Set(found.map(order => order.orderId))

    for (const id of orderIds) {
      if (foundIds.has(id)) continue
      const order = await this.getOrder(id)
      if (order) found.push(order)
    }
    return found
  }

  async getOrder(orderId: string): Promise<OpenOrder | null> {
    const client = this.requireClient()
    try {
      const response = await client.accountInformation.getUserAccountOrderDetail({
        ...this.auth(),
        brokerage_order_id: orderId,
      })
      return rawOrderToOpenOrder(response.data)
    } catch {
      return null
    }
  }

  async listOpenOrders(): Promise<OpenOrder[]> {
    return this.fetchRecentOrders('open')
  }

  async getQuote(contract: Contract): Promise<Quote> {
    const client = this.requireClient()
    const symbol = contract.symbol
    if (!symbol) throw new BrokerError('EXCHANGE', 'Cannot resolve contract to a SnapTrade symbol')

    try {
      const response = await client.trading.getUserAccountQuotes({
        ...this.auth(),
        symbols: symbol,
        useTicker: true,
      })
      const quote = response.data[0]
      if (!quote) throw new BrokerError('EXCHANGE', `No quote returned for ${symbol}`)
      return this.mapQuote(quote, contract)
    } catch (err) {
      throw BrokerError.from(new Error(snaptradeErrorMessage(err)))
    }
  }

  async getMarketClock(): Promise<MarketClock> {
    return {
      isOpen: true,
      timestamp: new Date(),
    }
  }

  // ==================== Capabilities ====================

  getCapabilities(): AccountCapabilities {
    return {
      supportedSecTypes: ['STK', 'FUND', 'CRYPTO', 'OPT', 'FUT'],
      supportedOrderTypes: ['MKT', 'LMT', 'STP', 'STP LMT'],
    }
  }

  // ==================== Contract identity ====================

  getNativeKey(contract: Contract): string {
    const id = contract.localSymbol || contract.conId?.toString() || contract.symbol || ''
    const symbol = contract.symbol || contract.localSymbol || id
    return buildNativeKeyFromParts(id, symbol, contract.secType || 'STK')
  }

  resolveNativeKey(nativeKey: string): Contract {
    const parsed = parseNativeKey(nativeKey)
    const c = new Contract()
    c.localSymbol = parsed.id
    c.symbol = parsed.symbol
    c.secType = parsed.secType
    c.currency = 'USD'
    c.exchange = 'SMART'
    return c
  }

  // ==================== Internal ====================

  private auth(): SnaptradeAuthParams {
    return {
      userId: this.config.userId,
      userSecret: this.config.userSecret,
      accountId: this.config.accountId,
    }
  }

  private requireClient(): SnaptradeSdkClient {
    if (!this.client) {
      throw new BrokerError('CONFIG', `SnaptradeBroker[${this.id}] is not initialized.`)
    }
    return this.client
  }

  private async resolveContractQuery(query: Contract): Promise<Contract | null> {
    if (query.localSymbol || query.symbol) {
      if (query.localSymbol) return this.resolveNativeKey(this.getNativeKey(query))
      const matches = await this.searchContracts(query.symbol ?? '')
      const exact = matches.find(desc =>
        desc.contract.symbol?.toUpperCase() === query.symbol?.toUpperCase() ||
        desc.contract.localSymbol === query.localSymbol,
      )
      return exact?.contract ?? matches[0]?.contract ?? null
    }
    return null
  }

  private buildPlaceOrderRequest(contract: Contract, order: Order): Record<string, unknown> {
    const orderType = orderTypeToSnaptrade(order.orderType || 'MKT')
    const request: Record<string, unknown> = {
      userId: this.config.userId,
      userSecret: this.config.userSecret,
      account_id: this.config.accountId,
      action: actionToSnaptrade(order.action || 'BUY'),
      order_type: orderType,
      time_in_force: tifToSnaptrade(order.tif || 'DAY'),
      trading_session: order.outsideRth ? 'EXTENDED' : 'REGULAR',
    }

    const symbolId = contract.localSymbol
    if (symbolId && symbolId !== contract.symbol) {
      request.universal_symbol_id = symbolId
      request.symbol = null
    } else if (contract.symbol) {
      request.symbol = contract.symbol
      request.universal_symbol_id = null
    } else {
      throw new BrokerError('EXCHANGE', 'Cannot resolve contract to SnapTrade symbol or universal_symbol_id')
    }

    if (hasQuantity(order)) {
      request.units = order.totalQuantity.toNumber()
      request.notional_value = null
    } else if (order.cashQty !== UNSET_DOUBLE && order.cashQty > 0) {
      if (orderType !== 'Market' || tifToSnaptrade(order.tif || 'DAY') !== 'Day') {
        throw new BrokerError('EXCHANGE', 'SnapTrade notional orders are only supported for Market + Day orders.')
      }
      request.notional_value = order.cashQty
      request.units = null
    } else {
      throw new BrokerError('EXCHANGE', 'Order must include totalQuantity or cashQty.')
    }

    this.addOrderPrices(request, orderType, order)
    return request
  }

  private addOrderPrices(request: Record<string, unknown>, orderType: SnaptradeOrderType, order: Order): void {
    if (orderType === 'Limit' || orderType === 'StopLimit') {
      if (!isSetPrice(order.lmtPrice)) {
        throw new BrokerError('EXCHANGE', `${orderType} order requires lmtPrice.`)
      }
      request.price = order.lmtPrice
    }
    if (orderType === 'Stop' || orderType === 'StopLimit') {
      if (!isSetPrice(order.auxPrice)) {
        throw new BrokerError('EXCHANGE', `${orderType} order requires auxPrice as stop price.`)
      }
      request.stop = order.auxPrice
    }
  }

  private placeOrderResult(raw: SnaptradeOrderRaw, fallbackOrderId?: string): PlaceOrderResult {
    const orderId = canonicalOrderId(raw) || fallbackOrderId
    const os = makeOrderState(raw.status)
    return {
      success: true,
      orderId,
      orderState: os,
    }
  }

  private mapPosition(raw: SnaptradePositionRaw): Position | null {
    const qty = decimal(raw.units)
    if (qty.isZero()) return null

    const contract = contractFromInstrument(raw.instrument)
    const marketPrice = num(raw.price)
    const avgCost = num(raw.cost_basis)
    const absQty = qty.abs()
    const signedQty = qty
    const marketValue = absQty.mul(marketPrice).toNumber()
    const unrealizedPnL = signedQty.mul(new Decimal(marketPrice).minus(avgCost)).toNumber()

    return {
      contract,
      side: qty.isNegative() ? 'short' : 'long',
      quantity: absQty,
      avgCost,
      marketPrice,
      marketValue,
      unrealizedPnL,
      realizedPnL: 0,
    }
  }

  private async fetchRecentOrders(state: 'all' | 'open' | 'executed'): Promise<OpenOrder[]> {
    const client = this.requireClient()
    try {
      const response = await client.accountInformation.getUserAccountOrders({
        ...this.auth(),
        state,
        days: ORDER_LOOKBACK_DAYS,
      })
      return response.data.map(rawOrderToOpenOrder)
    } catch (err) {
      throw BrokerError.from(new Error(snaptradeErrorMessage(err)))
    }
  }

  private mapQuote(raw: SnaptradeQuoteRaw, fallbackContract: Contract): Quote {
    const contract = raw.symbol ? contractFromUniversalSymbol(raw.symbol) : fallbackContract
    const last = raw.last_trade_price ?? 0
    return {
      contract,
      last,
      bid: raw.bid_price ?? last,
      ask: raw.ask_price ?? last,
      volume: 0,
      timestamp: new Date(),
    }
  }
}

function sumBalances(balances: SnaptradeBalanceRaw[], field: 'cash' | 'buying_power'): number {
  return balances.reduce((sum, balance) => sum + num(balance[field]), 0)
}

/**
 * TigerBroker — IBroker adapter for Tiger Trade (老虎证券 / TigerFintech).
 *
 * Uses Tiger Open API v3 REST over HTTPS with RSA-signed requests.
 * Supports US equities, Hong Kong stocks (SEHK), and ETFs in both markets.
 *
 * Key differences from IBKR/Alpaca:
 * - REST API (not persistent socket) — init() just validates credentials
 * - Auth: RSA private key signs every request (no session/token needed)
 * - Order IDs: Tiger returns large int64 global IDs; we use those as string orderIds
 * - HK stocks: symbol format "00700", exchange "SEHK", currency HKD
 * - Order ID pre-allocation: place_order requires a pre-fetched order_id from order_no
 *
 * Tiger API response structure: all arrays are wrapped in { items: [...] }
 * All JSON field names are camelCase (e.g. netLiquidation, cashValue, latestPrice).
 */

import { z } from 'zod'
import { Contract, Order, OrderState } from '@traderalice/ibkr'
import Decimal from 'decimal.js'
import type { ContractDescription, ContractDetails, OrderCancel } from '@traderalice/ibkr'
import {
  BrokerError,
  type IBroker,
  type AccountCapabilities,
  type AccountInfo,
  type Position,
  type PlaceOrderResult,
  type OpenOrder,
  type Quote,
  type MarketClock,
  type BrokerConfigField,
} from '../types.js'
import { TigerClient } from './tiger-client.js'
import {
  contractToTigerParams,
  tigerContractToDescription,
  tigerContractToDetails,
  tigerOrderToOpenOrder,
  tigerPositionToUnified,
  tigerAssetsToAccountInfo,
  tigerStatusToOrderState,
  ibkrOrderTypeToTiger,
  buildNativeKey,
  resolveNativeKey as resolveNativeKeyHelper,
} from './tiger-contracts.js'
import type {
  TigerBrokerConfig,
  TigerOrderRaw,
  TigerPositionRaw,
  TigerContractRaw,
  TigerQuoteBriefRaw,
  TigerMarketStatusRaw,
  TigerOrderIdData,
} from './tiger-types.js'

/**
 * Extract items from a Tiger API response.
 * Tiger wraps all lists in: data = { items: [...] }
 * But some endpoints return a list directly or a single object.
 */
function extractItems<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[]
  const obj = data as Record<string, unknown> | null
  if (obj && Array.isArray(obj.items)) return obj.items as T[]
  return []
}

export class TigerBroker implements IBroker {
  // ---- Self-registration ----

  static configSchema = z.object({
    tigerId: z.string().min(1),
    privateKey: z.string().min(1),
    account: z.string().min(1),
    paper: z.boolean().default(false),
    license: z.string().optional(),
    serverUrl: z.string().optional(),
  })

  static configFields: BrokerConfigField[] = [
    {
      name: 'tigerId',
      type: 'text',
      label: 'Tiger ID',
      placeholder: 'Developer app ID from Tiger Open Platform',
      required: true,
    },
    {
      name: 'privateKey',
      type: 'password',
      label: 'RSA Private Key',
      placeholder: 'Base64-encoded PKCS#1 DER or PEM private key',
      required: true,
      sensitive: true,
    },
    {
      name: 'account',
      type: 'text',
      label: 'Account ID',
      placeholder: 'Trading account ID (e.g. DU12345 for paper)',
      required: true,
    },
    {
      name: 'paper',
      type: 'boolean',
      label: 'Paper Trading',
      default: false,
      description: 'Paper accounts typically have IDs starting with "DU".',
    },
    {
      name: 'license',
      type: 'text',
      label: 'License (optional)',
      placeholder: 'e.g. TBSG, TBNZ, TBUS',
      description: 'Account license code. Auto-detected if left blank.',
    },
    {
      name: 'serverUrl',
      type: 'text',
      label: 'Gateway URL (optional)',
      placeholder: 'https://openapi.tigerfintech.com/gateway',
      description: 'Override the default Tiger gateway URL.',
    },
  ]

  static fromConfig(config: { id: string; label?: string; brokerConfig: Record<string, unknown> }): TigerBroker {
    const bc = TigerBroker.configSchema.parse(config.brokerConfig)
    return new TigerBroker({
      id: config.id,
      label: config.label,
      tigerId: bc.tigerId,
      privateKey: bc.privateKey,
      account: bc.account,
      paper: bc.paper,
      license: bc.license,
      serverUrl: bc.serverUrl,
    })
  }

  // ---- Instance ----

  readonly id: string
  readonly label: string

  private readonly account: string
  private readonly client: TigerClient
  private initialized = false

  constructor(config: TigerBrokerConfig) {
    this.id = config.id ?? 'tiger'
    this.label = config.label ?? 'Tiger Trade'
    this.account = config.account

    this.client = new TigerClient({
      tigerId: config.tigerId,
      privateKey: config.privateKey,
      serverUrl: config.serverUrl,
    })
  }

  // ==================== Lifecycle ====================

  /**
   * Validate credentials by fetching managed accounts.
   * REST API — no persistent connection to establish.
   */
  async init(): Promise<void> {
    if (this.initialized) return

    try {
      const data = await this.client.execute('accounts', {
        account: this.account,
        lang: 'en_US',
      })
      if (!data) {
        throw new BrokerError('AUTH', 'Tiger API returned no account data — check tigerId, privateKey, and account.')
      }
      this.initialized = true
      console.log(`TigerBroker[${this.id}]: connected (account=${this.account})`)
    } catch (err) {
      if (err instanceof BrokerError) throw err
      throw BrokerError.from(err, 'AUTH')
    }
  }

  async close(): Promise<void> {
    // REST API — no persistent connection to close
  }

  // ==================== Contract search ====================

  /**
   * Search for contracts by symbol pattern.
   *
   * Tiger does not offer fuzzy symbol search (unlike IBKR reqMatchingSymbols).
   * We treat `pattern` as an exact symbol lookup. Returns empty if not found.
   *
   * Tiger response: data = { items: [TigerContractRaw, ...] }
   */
  async searchContracts(pattern: string): Promise<ContractDescription[]> {
    if (!pattern) return []

    try {
      const data = await this.client.execute('contracts', {
        account: this.account,
        symbols: [pattern.toUpperCase()],
        sec_type: 'STK',
        lang: 'en_US',
      })

      // Tiger wraps contract results in data.items[]
      return extractItems<TigerContractRaw>(data).map(tigerContractToDescription)
    } catch {
      return []
    }
  }

  /**
   * Get detailed contract info for a specific contract.
   * Uses Tiger's v3 `contract` endpoint for complete details.
   */
  async getContractDetails(query: Contract): Promise<ContractDetails | null> {
    const symbol = query.symbol ?? ''
    if (!symbol) return null

    try {
      const tigerParams = contractToTigerParams(query)
      const data = await this.client.execute('contract', {
        account: this.account,
        ...tigerParams,
        lang: 'en_US',
      }, '3.0')

      if (!data) return null

      const items = extractItems<TigerContractRaw>(data)
      const raw = items[0] ?? (data as TigerContractRaw)
      return raw ? tigerContractToDetails(raw) : null
    } catch {
      return null
    }
  }

  // ==================== Trading operations ====================

  /**
   * Place an order.
   *
   * Tiger flow:
   *   1. Fetch a fresh order_id via `order_no` endpoint
   *   2. Submit order via `place_order` endpoint
   *   3. Return the global `id` (int64) as the canonical orderId
   */
  async placeOrder(contract: Contract, order: Order): Promise<PlaceOrderResult> {
    try {
      // Step 1: get order_no
      const orderNoData = await this.client.execute('order_no', {
        account: this.account,
        lang: 'en_US',
      }) as TigerOrderIdData | null

      const tigerOrderId = orderNoData?.order_id
      if (!tigerOrderId) {
        return { success: false, error: 'Failed to obtain order ID from Tiger API' }
      }

      // Step 2: place order
      const tigerContractParams = contractToTigerParams(contract)
      const bizContent: Record<string, unknown> = {
        account: this.account,
        contract: tigerContractParams,
        action: order.action,
        order_type: ibkrOrderTypeToTiger(order.orderType ?? 'LMT'),
        order_id: tigerOrderId,
        quantity: order.totalQuantity?.toNumber() ?? 0,
        time_in_force: order.tif ?? 'DAY',
        outside_rth: order.outsideRth ?? false,
        lang: 'en_US',
      }

      if (order.lmtPrice != null && order.lmtPrice > 0) {
        bizContent.limit_price = order.lmtPrice
      }
      if (order.auxPrice != null && order.auxPrice > 0) {
        bizContent.aux_price = order.auxPrice
      }
      if (order.trailingPercent != null) {
        bizContent.trailing_percent = order.trailingPercent
      }

      const placeData = await this.client.execute('place_order', bizContent) as TigerOrderIdData | null

      const globalId = placeData?.id
      if (!globalId) {
        return { success: false, error: 'Tiger did not return a global order ID' }
      }

      const os = new OrderState()
      os.status = 'Submitted'

      return {
        success: true,
        orderId: String(globalId),
        orderState: os,
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Modify an existing order.
   * Fetches the original order to extract contract + base fields, applies changes.
   */
  async modifyOrder(orderId: string, changes: Partial<Order>): Promise<PlaceOrderResult> {
    try {
      const existing = await this.getOrder(orderId)
      if (!existing) {
        return { success: false, error: `Order ${orderId} not found` }
      }

      const orig = existing.order
      const tigerContractParams = contractToTigerParams(existing.contract)

      const bizContent: Record<string, unknown> = {
        account: this.account,
        id: parseInt(orderId, 10),
        contract: tigerContractParams,
        action: orig.action,
        order_type: ibkrOrderTypeToTiger(
          (changes.orderType ?? orig.orderType) ?? 'LMT',
        ),
        quantity: (changes.totalQuantity ?? orig.totalQuantity)?.toNumber() ?? 0,
        limit_price: changes.lmtPrice ?? orig.lmtPrice,
        aux_price: changes.auxPrice ?? orig.auxPrice,
        time_in_force: changes.tif ?? orig.tif ?? 'DAY',
        outside_rth: changes.outsideRth ?? orig.outsideRth ?? false,
        lang: 'en_US',
      }

      if (changes.trailingPercent != null) {
        bizContent.trailing_percent = changes.trailingPercent
      }

      await this.client.execute('modify_order', bizContent)

      const os = new OrderState()
      os.status = 'Submitted'
      return {
        success: true,
        orderId,
        orderState: os,
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Cancel an order by its global ID.
   */
  async cancelOrder(orderId: string, _orderCancel?: OrderCancel): Promise<PlaceOrderResult> {
    try {
      await this.client.execute('cancel_order', {
        account: this.account,
        id: parseInt(orderId, 10),
        lang: 'en_US',
      })

      const os = new OrderState()
      os.status = 'Cancelled'
      return { success: true, orderId, orderState: os }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Close an open position by placing a closing market order.
   */
  async closePosition(contract: Contract, quantity?: Decimal): Promise<PlaceOrderResult> {
    const positions = await this.getPositions()
    const symbol = contract.symbol ?? ''

    const pos = positions.find(p => p.contract.symbol === symbol)
    if (!pos) {
      return { success: false, error: `No open position for ${symbol}` }
    }

    const closeOrder = new Order()
    closeOrder.action = pos.side === 'long' ? 'SELL' : 'BUY'
    closeOrder.orderType = 'MKT'
    closeOrder.totalQuantity = quantity ?? pos.quantity
    closeOrder.tif = 'DAY'

    return this.placeOrder(pos.contract, closeOrder)
  }

  // ==================== Queries ====================

  /**
   * Get account summary (net liquidation, buying power, margins, etc.).
   *
   * Uses Tiger's `assets` endpoint.
   * Tiger response: data = { items: [{ netLiquidation, cashValue, buyingPower, ... }] }
   * All fields in the item use camelCase (not snake_case).
   */
  async getAccount(): Promise<AccountInfo> {
    const data = await this.client.execute('assets', {
      account: this.account,
      lang: 'en_US',
    })
    return tigerAssetsToAccountInfo(data)
  }

  /**
   * Get current open positions.
   *
   * Tiger response: data = { items: [TigerPositionRaw, ...] }
   * Contract fields (symbol, currency, secType) are FLAT on each position item.
   * Position quantity uses field name "position" (not "quantity").
   */
  async getPositions(): Promise<Position[]> {
    const data = await this.client.execute('positions', {
      account: this.account,
      sec_type: 'STK',
      currency: 'ALL',
      market: 'ALL',
      lang: 'en_US',
    })

    return extractItems<TigerPositionRaw>(data)
      // Tiger uses "position" field for quantity (SPECIAL MAPPING)
      .filter(p => (p.position ?? 0) !== 0)
      .map(tigerPositionToUnified)
  }

  /**
   * Get orders by IDs. Fetches each order individually since Tiger lacks bulk lookups.
   */
  async getOrders(orderIds: string[]): Promise<OpenOrder[]> {
    const results: OpenOrder[] = []
    for (const id of orderIds) {
      const order = await this.getOrder(id)
      if (order) results.push(order)
    }
    return results
  }

  /**
   * Get a single order by global ID.
   * Tiger's `orders` endpoint accepts `id` (global int64) or `order_id` (account-level).
   * Response may be { items: [...] } for multiple orders, or a flat object for a single order.
   */
  async getOrder(orderId: string): Promise<OpenOrder | null> {
    try {
      const data = await this.client.execute('orders', {
        account: this.account,
        id: parseInt(orderId, 10),
        lang: 'en_US',
      })

      if (!data) return null

      const dataObj = data as Record<string, unknown>

      // Handle { items: [...] } structure
      if (Array.isArray(dataObj.items)) {
        const raw = (dataObj.items as TigerOrderRaw[])[0]
        return raw ? tigerOrderToOpenOrder(raw) : null
      }

      // Handle direct list
      if (Array.isArray(data)) {
        const raw = (data as TigerOrderRaw[])[0]
        return raw ? tigerOrderToOpenOrder(raw) : null
      }

      // Handle single flat order object (Tiger returns this when querying by id)
      if (dataObj.symbol || dataObj.id) {
        return tigerOrderToOpenOrder(dataObj as TigerOrderRaw)
      }

      return null
    } catch {
      return null
    }
  }

  /**
   * Get a real-time quote for a contract.
   *
   * Resolves symbol from contract.symbol, contract.localSymbol, or contract.aliceId.
   * Tiger response for `brief`: data = { items: [TigerQuoteBriefRaw, ...] }
   * Quote fields use camelCase: latestPrice, preClose, timestamp, bidPrice, askPrice, etc.
   */
  async getQuote(contract: Contract): Promise<Quote> {
    // Resolve symbol — also handles aliceId-only contracts (e.g. aliceId="AVGO")
    const aliceId = contract.aliceId ?? ''
    const symbol = contract.symbol
      || contract.localSymbol
      || (aliceId.includes('|') ? aliceId.split('|')[1] : aliceId)
      || ''

    if (!symbol) throw new BrokerError('CONFIG', 'Contract must have a symbol to get a quote')

    // Tiger quote endpoint: "quote_real_time" (not "brief")
    // Response is a DIRECT LIST: data = [{symbol, latestPrice, ...}, ...]
    const data = await this.client.execute('quote_real_time', {
      symbols: [symbol],
      include_hour_trading: false,
      lang: 'en_US',
    })

    // quote_real_time returns data as a direct array (unlike other endpoints that use data.items[])
    const items = Array.isArray(data) ? (data as TigerQuoteBriefRaw[]) : extractItems<TigerQuoteBriefRaw>(data)
    const raw = items.find(q => q.symbol === symbol) ?? items[0]

    if (!raw) {
      throw new BrokerError('EXCHANGE', `No quote returned for ${symbol}`)
    }

    return {
      contract,
      // Tiger: "latestPrice" (SPECIAL MAPPING in BRIEF_FIELD_MAPPINGS → latest_price)
      last: raw.latestPrice ?? 0,
      // Tiger: "bidPrice" (SPECIAL MAPPING → bid_price)
      bid: raw.bidPrice ?? 0,
      // Tiger: "askPrice" (SPECIAL MAPPING → ask_price)
      ask: raw.askPrice ?? 0,
      volume: raw.volume ?? 0,
      // Tiger: "highPrice" (camelCase → high_price)
      high: raw.highPrice,
      // Tiger: "lowPrice" (camelCase → low_price)
      low: raw.lowPrice,
      // Tiger: "timestamp" (SPECIAL MAPPING → latest_time)
      timestamp: raw.timestamp ? new Date(raw.timestamp) : new Date(),
    }
  }

  /**
   * Get market open/close status.
   *
   * Queries Tiger's `market_state` endpoint for both US and HK markets.
   * Returns `isOpen: true` if either market is currently in a trading session.
   * Tiger response fields use camelCase: tradingStatus, openTime.
   */
  async getMarketClock(): Promise<MarketClock> {
    const results = await Promise.allSettled([
      this.fetchMarketState('US'),
      this.fetchMarketState('HK'),
    ])

    const statuses = results
      .filter((r): r is PromiseFulfilledResult<TigerMarketStatusRaw[]> => r.status === 'fulfilled')
      .flatMap(r => r.value)

    const isOpen = statuses.some(s =>
      // Tiger uses "tradingStatus" (camelCase) in market_state response
      s.tradingStatus === 'Trading' || s.status === 'Trading',
    )

    const now = Date.now()
    // Tiger uses "openTime" (camelCase) in market_state response
    const nextOpen = statuses
      .map(s => s.openTime)
      .filter((t): t is number => t != null && t > now)
      .sort()[0]

    return {
      isOpen,
      nextOpen: nextOpen ? new Date(nextOpen) : undefined,
      timestamp: new Date(),
    }
  }

  private async fetchMarketState(market: string): Promise<TigerMarketStatusRaw[]> {
    const data = await this.client.execute('market_state', {
      market,
      lang: 'en_US',
    })
    return extractItems<TigerMarketStatusRaw>(data)
  }

  // ==================== Capabilities ====================

  getCapabilities(): AccountCapabilities {
    return {
      // Tiger supports US STK, HK STK, HK warrants/bull-bear certs (WAR/IOPT),
      // US options (OPT), and ETFs (all treated as STK)
      supportedSecTypes: ['STK', 'OPT', 'WAR', 'IOPT', 'FUT'],
      supportedOrderTypes: ['MKT', 'LMT', 'STP', 'STP LMT', 'TRAIL'],
    }
  }

  // ==================== Contract identity ====================

  /**
   * Extract the Tiger native key from a contract.
   * Format: "AAPL" (US stock), "00700.HK" (HK stock), "00700.HK.OPT" (HK option).
   */
  getNativeKey(contract: Contract): string {
    return buildNativeKey(contract)
  }

  /**
   * Reconstruct a trade-ready Contract from a Tiger native key.
   */
  resolveNativeKey(nativeKey: string): Contract {
    return resolveNativeKeyHelper(nativeKey)
  }
}

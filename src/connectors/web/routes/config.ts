import { Hono } from 'hono'
import { loadConfig, writeConfigSection, readAIProviderConfig, readMarketDataConfig, validSections, writeAIBackend, type ConfigSection, type AIBackend } from '../../../core/config.js'
import { getSDKExecutor, buildRouteMap } from '../../../domain/market-data/client/typebb/index.js'

interface ConfigRouteOpts {
  onConnectorsChange?: () => Promise<void>
}

/** Config routes: GET /, PUT /ai-provider, PUT /:section, GET /api-keys/status */
export function createConfigRoutes(opts?: ConfigRouteOpts) {
  const app = new Hono()

  app.get('/', async (c) => {
    try {
      const config = await loadConfig()
      return c.json(config)
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  app.put('/ai-provider', async (c) => {
    try {
      const body = await c.req.json<{ backend?: string }>()
      const backend = body.backend
      if (backend !== 'claude-code' && backend !== 'vercel-ai-sdk' && backend !== 'agent-sdk') {
        return c.json({ error: 'Invalid backend. Must be "claude-code", "vercel-ai-sdk", or "agent-sdk".' }, 400)
      }
      await writeAIBackend(backend as AIBackend)
      return c.json({ backend })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  app.put('/:section', async (c) => {
    try {
      const section = c.req.param('section') as ConfigSection
      if (!validSections.includes(section)) {
        return c.json({ error: `Invalid section "${section}". Valid: ${validSections.join(', ')}` }, 400)
      }
      const body = await c.req.json()
      const validated = await writeConfigSection(section, body)
      // Hot-reload connectors / OpenBB server when their config changes
      if (section === 'connectors' || section === 'marketData') {
        await opts?.onConnectorsChange?.()
      }
      return c.json(validated)
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        return c.json({ error: 'Validation failed', details: JSON.parse(err.message) }, 400)
      }
      return c.json({ error: String(err) }, 500)
    }
  })

  app.get('/api-keys/status', async (c) => {
    try {
      const config = await readAIProviderConfig()
      return c.json({
        anthropic: !!config.apiKeys.anthropic,
        openai: !!config.apiKeys.openai,
        google: !!config.apiKeys.google,
      })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  return app
}

/** Market data routes: POST /test-provider */
export function createMarketDataRoutes() {
  // sdkProvider:   override when the SDK registry name differs from the OpenBB HTTP provider name
  // sdkCredField:  the auto-prefixed credential key the SDK provider expects (name + '_' + credSuffix)
  const TEST_ENDPOINTS: Record<string, { credField: string; path: string; sdkProvider?: string; sdkCredField?: string }> = {
    fred:             { credField: 'fred_api_key',             sdkCredField: 'federal_reserve_api_key', sdkProvider: 'federal_reserve', path: '/api/v1/economy/fred_search?query=GDP&provider=fred' },
    bls:              { credField: 'bls_api_key',              sdkCredField: 'bls_api_key',             path: '/api/v1/economy/survey/bls_search?query=unemployment&provider=bls' },
    eia:              { credField: 'eia_api_key',              sdkCredField: 'eia_api_key',             path: '/api/v1/commodity/short_term_energy_outlook?provider=eia' },
    econdb:           { credField: 'econdb_api_key',           sdkCredField: 'econdb_api_key',          path: '/api/v1/economy/available_indicators?provider=econdb' },
    fmp:              { credField: 'fmp_api_key',              sdkCredField: 'fmp_api_key',             path: '/api/v1/equity/screener?provider=fmp&limit=1' },
    nasdaq:           { credField: 'nasdaq_api_key',                                                    path: '/api/v1/equity/search?query=AAPL&provider=nasdaq&is_symbol=true' },
    intrinio:         { credField: 'intrinio_api_key',         sdkCredField: 'intrinio_api_key',        path: '/api/v1/equity/search?query=AAPL&provider=intrinio&limit=1' },
    tradingeconomics: { credField: 'tradingeconomics_api_key',                                          path: '/api/v1/economy/calendar?provider=tradingeconomics' },
  }

  const app = new Hono()

  app.post('/test-provider', async (c) => {
    try {
      const { provider, key } = await c.req.json<{ provider: string; key: string }>()
      const endpoint = TEST_ENDPOINTS[provider]
      if (!endpoint) return c.json({ ok: false, error: `Unknown provider: ${provider}` }, 400)
      if (!key) return c.json({ ok: false, error: 'No API key provided' }, 400)

      const marketDataConfig = await readMarketDataConfig()

      if (marketDataConfig.backend === 'typebb-sdk') {
        // In-process SDK call — no external HTTP needed
        const executor = getSDKExecutor()
        const routeMap = buildRouteMap()

        // Parse path: strip /api/v1 prefix and extract query params
        const parsed = new URL(endpoint.path, 'http://localhost')
        const sdkPath = parsed.pathname.replace(/^\/api\/v1/, '')
        const params: Record<string, string> = {}
        parsed.searchParams.forEach((v, k) => { if (k !== 'provider') params[k] = v })

        const model = routeMap.get(sdkPath)
        if (!model) return c.json({ ok: false, error: `No SDK route for: ${sdkPath}` }, 500)

        const sdkProvider = endpoint.sdkProvider ?? provider
        const credKey = endpoint.sdkCredField ?? endpoint.credField
        const credentials = { [credKey]: key }
        await executor.execute(sdkProvider, model, params, credentials)
        return c.json({ ok: true })
      }

      // openbb-api mode: forward to external sidecar via HTTP
      const credHeader = JSON.stringify({ [endpoint.credField]: key })
      const url = `${marketDataConfig.apiUrl}${endpoint.path}`

      const res = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        headers: { 'X-OpenBB-Credentials': credHeader },
      })

      if (res.ok) return c.json({ ok: true })
      const body = await res.text().catch(() => '')
      return c.json({ ok: false, error: `OpenBB returned ${res.status}: ${body.slice(0, 200)}` })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ ok: false, error: msg.includes('timeout') ? 'Cannot reach OpenBB API' : msg })
    }
  })

  return app
}

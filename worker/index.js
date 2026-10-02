/**
 * AetherDroid — Control Plane (Hono backend)
 * Phase 6: Real Runtime Host Bridge
 *
 * IMPORTANT:
 * - Cloudflare Workers Assets is used for static files.
 * - Do NOT use Hono serveStatic().
 * - Android lifecycle/input/signaling are forwarded
 *   to the real Runtime Host.
 *
 * Runtime Host:
 *   RUNTIME_HOST_ID=https://your-public-runtime-host
 *
 * It is also accepted when the value ends with /health.
 */

import { Hono } from 'hono'

const app = new Hono()

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

app.use('/api/*', async (c, next) => {
  await next()

  c.header(
    'Access-Control-Allow-Origin',
    '*'
  )

  c.header(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, OPTIONS'
  )

  c.header(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  )
})

app.options('/api/*', (c) =>
  c.text('', 204)
)

// ---------------------------------------------------------------------------
// Runtime Host bridge
// ---------------------------------------------------------------------------

function getRuntimeHost(c) {
  const value = String(
    c.env?.RUNTIME_HOST_ID ?? ''
  ).trim()

  if (!value) {
    throw new Error(
      'RUNTIME_HOST_ID is not configured'
    )
  }

  return value
    .replace(/\/health\/?$/i, '')
    .replace(/\/+$/, '')
}

async function runtimeFetch(
  c,
  pathname,
  options = {}
) {
  const base =
    getRuntimeHost(c)

  const path =
    pathname.startsWith('/')
      ? pathname
      : `/${pathname}`

  const headers = new Headers(
    options.headers ?? {}
  )

  if (
    options.body &&
    !headers.has(
      'Content-Type'
    ) &&
    !(options.body instanceof ArrayBuffer) &&
    !(options.body instanceof Uint8Array) &&
    !(options.body instanceof Blob)
  ) {
    headers.set(
      'Content-Type',
      'application/json'
    )
  }

  return fetch(
    `${base}${path}`,
    {
      ...options,
      headers,
    }
  )
}

async function runtimeJson(
  response
) {
  const text =
    await response.text()

  if (!text) {
    return {}
  }

  try {
    return JSON.parse(text)
  } catch {
    return {
      ok: response.ok,
      raw: text,
    }
  }
}

function runtimeError(
  data,
  fallback
) {
  if (
    data &&
    typeof data.error ===
      'string'
  ) {
    return data.error
  }

  if (
    data &&
    typeof data.message ===
      'string'
  ) {
    return data.message
  }

  return fallback
}

// ---------------------------------------------------------------------------
// Simulated persistence layer
//
// IMPORTANT:
// Cloudflare Workers isolates are ephemeral.
// This keeps the original API structure, but is not durable storage.
// ---------------------------------------------------------------------------

const PERSIST_KEY =
  'aetherdroid.state'

function createState() {
  return {
    sessions: new Map(),
    packages: new Map(),
    createdAt: Date.now(),
  }
}

function loadPersisted() {
  try {
    const existing =
      globalThis[PERSIST_KEY]

    if (
      existing &&
      existing.sessions instanceof Map &&
      existing.packages instanceof Map
    ) {
      return existing
    }

    const state =
      createState()

    globalThis[PERSIST_KEY] =
      state

    return state
  } catch (err) {
    console.error(
      '[persistence] init failed:',
      err?.stack ?? err
    )

    const state =
      createState()

    try {
      globalThis[PERSIST_KEY] =
        state
    } catch {}

    return state
  }
}

function db() {
  return loadPersisted()
}

function sessions() {
  return db().sessions
}

function packages() {
  return db().packages
}

// ---------------------------------------------------------------------------
// Session configuration
// ---------------------------------------------------------------------------

const OS_VERSIONS = [
  '13',
  '12',
  '11',
]

const REGIONS = [
  'us-east',
  'eu-west',
  'ap-south',
]

function makeSession(
  overrides = {}
) {
  const id =
    overrides.id ??
    `ad-${Math.random()
      .toString(16)
      .slice(2, 6)}`

  return {
    id,

    name:
      overrides.name ??
      `Cloud Phone ${id
        .slice(-4)
        .toUpperCase()}`,

    status: 'booting',

    cpu:
      Number(overrides.cpu) > 0
        ? Number(overrides.cpu)
        : 2,

    ram:
      Number(overrides.ram) > 0
        ? Number(overrides.ram)
        : 4,

    os:
      overrides.os ??
      OS_VERSIONS[
        Math.floor(
          Math.random() *
            OS_VERSIONS.length
        )
      ],

    region:
      overrides.region ??
      REGIONS[
        Math.floor(
          Math.random() *
            REGIONS.length
        )
      ],

    createdAt:
      overrides.createdAt ??
      new Date().toISOString(),

    bootedAt:
      overrides.bootedAt ?? null,

    lastSeen:
      overrides.lastSeen ??
      new Date().toISOString(),

    uptimeSeconds: 0,

    pc: null,

    lastInputSeq: 0,

    installedApks:
      Array.isArray(
        overrides.installedApks
      )
        ? overrides.installedApks
        : [],

    ...overrides,
  }
}

function getSession(id) {
  if (!id) {
    return null
  }

  return (
    sessions().get(id) ??
    null
  )
}

function serializeSession(
  session
) {
  if (!session) {
    return null
  }

  const bootedMs =
    session.bootedAt &&
    !Number.isNaN(
      new Date(
        session.bootedAt
      ).getTime()
    )
      ? new Date(
          session.bootedAt
        ).getTime()
      : 0

  const uptime =
    bootedMs > 0
      ? Math.max(
          0,
          Math.floor(
            (Date.now() -
              bootedMs) /
              1000
          )
        )
      : 0

  const h =
    Math.floor(
      uptime / 3600
    )

  const d =
    Math.floor(h / 24)

  return {
    ...session,

    pc: undefined,

    _touchAnchor:
      undefined,

    _pendingInstall:
      undefined,

    uptimeSeconds:
      uptime,

    vRuntime:
      `${d}d ${h % 24}h`,
  }
}

// ---------------------------------------------------------------------------
// APK package registry
// ---------------------------------------------------------------------------

function seedPackages() {
  const store =
    packages()

  if (store.size > 0) {
    return
  }

  const seed = [
    {
      id: 'apk-seed-chrome',
      name: 'Chrome',
      package:
        'com.android.chrome',
      version: '120.0',
      size: '84.2 MB',
    },

    {
      id: 'apk-seed-vlc',
      name: 'Vlc',
      package:
        'org.videolan.vlc',
      version: '3.5.1',
      size: '32.7 MB',
    },
  ]

  for (const item of seed) {
    store.set(
      item.id,
      {
        ...item,
        status: 'pending',
        addedAt:
          new Date().toISOString(),
      }
    )
  }
}

function touchSession(id) {
  const session =
    getSession(id)

  if (session) {
    session.lastSeen =
      new Date().toISOString()
  }

  return session
}

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

const NODES = [
  {
    id: 'host-a',
    label: 'Host A · us-east',
    cores: 16,
  },

  {
    id: 'host-b',
    label: 'Host B · eu-west',
    cores: 12,
  },

  {
    id: 'host-c',
    label: 'Host C · ap-south',
    cores: 8,
  },
]

function nodeHealth(
  node,
  sessionList
) {
  const region =
    node.label.split('· ')[1]

  const hosted =
    sessionList.filter(
      (session) =>
        session.region ===
          region &&
        session.status ===
          'online'
    )

  const t =
    Date.now() / 1000

  const load =
    Math.min(
      0.95,
      Math.max(
        0.08,
        hosted.length *
            0.22 +
          0.15 +
          Math.sin(
            t / 37 +
              node.cores
          ) *
            0.08
      )
    )

  const disk =
    Math.min(
      0.95,
      Math.max(
        0.2,
        0.35 +
          hosted.length *
            0.1 +
          Math.cos(
            t / 53
          ) *
            0.05
      )
    )

  const net =
    Math.min(
      940,
      Math.max(
        20,
        Math.round(
          hosted.length *
              180 +
            Math.abs(
              Math.sin(
                t / 11
              )
            ) *
              120
        )
      )
    )

  const healthy =
    load < 0.85 &&
    disk < 0.9

  return {
    id: node.id,
    label: node.label,
    cores: node.cores,
    load,
    disk,
    netMbps: net,
    status: healthy
      ? 'healthy'
      : 'degraded',
    instances:
      hosted.length,
    lastPing:
      new Date().toISOString(),
  }
}

function sweepStaleSessions() {
  const now =
    Date.now()

  let removed = 0

  for (
    const [id, session] of
      sessions()
  ) {
    const lastSeenMs =
      new Date(
        session.lastSeen ??
          0
      ).getTime()

    if (
      session.status ===
        'offline' &&
      lastSeenMs &&
      now - lastSeenMs >
        24 *
          3600 *
          1000
    ) {
      sessions().delete(id)
      removed++
    }
  }

  if (removed > 0) {
    console.log(
      `[watchdog] reaped ${removed} stale offline session(s)`
    )
  }
}

// ---------------------------------------------------------------------------
// API: /api/runtime-health
// ---------------------------------------------------------------------------

app.get(
  '/api/runtime-health',
  async (c) => {
    try {
      const response =
        await runtimeFetch(
          c,
          '/health',
          {
            method: 'GET',
          }
        )

      const data =
        await runtimeJson(
          response
        )

      return c.json(
        {
          ok:
            response.ok &&
            data?.ok !== false,

          runtime:
            data,

          status:
            response.status,
        },
        response.ok
          ? 200
          : 502
      )
    } catch (err) {
      console.error(
        '[api/runtime-health] failed:',
        err?.stack ?? err
      )

      return c.json(
        {
          ok: false,
          error:
            err?.message ??
            'Runtime Host unavailable',
        },
        502
      )
    }
  }
)

// ---------------------------------------------------------------------------
// API: /api/watchdog
// ---------------------------------------------------------------------------

app.get(
  '/api/watchdog',
  (c) => {
    try {
      sweepStaleSessions()

      const list =
        Array.from(
          sessions().values()
        )

      const nodes =
        NODES.map(
          (node) =>
            nodeHealth(
              node,
              list
            )
        )

      const degraded =
        nodes.filter(
          (node) =>
            node.status !==
            'healthy'
        ).length

      return c.json({
        ok: true,

        overall:
          degraded === 0
            ? 'operational'
            : degraded ===
                nodes.length
              ? 'down'
              : 'degraded',

        watchdogLastRun:
          new Date().toISOString(),

        uptimePct:
          degraded === 0
            ? '99.9'
            : degraded ===
                nodes.length
              ? '0'
              : '98.2',

        nodes,
      })
    } catch (err) {
      console.error(
        '[api/watchdog] failed:',
        err?.stack ?? err
      )

      return c.json(
        {
          ok: false,
          error:
            'Watchdog probe failed',
        },
        500
      )
    }
  }
)

// ---------------------------------------------------------------------------
// API: /api/apks
// ---------------------------------------------------------------------------

app.get(
  '/api/apks',
  (c) => {
    try {
      seedPackages()

      const list =
        Array.from(
          packages().values()
        ).map((pkg) => ({
          ...pkg,
        }))

      return c.json({
        ok: true,
        apks: list,
      })
    } catch (err) {
      console.error(
        '[api/apks GET] failed:',
        err?.stack ?? err
      )

      return c.json(
        {
          ok: false,
          error:
            'Failed to load packages',
        },
        500
      )
    }
  }
)

app.post(
  '/api/apks',
  async (c) => {
    try {
      const body =
        await c.req
          .json()
          .catch(() => ({}))

      if (
        !body?.id ||
        !body?.name
      ) {
        return c.json(
          {
            ok: false,
            error:
              'id and name required',
          },
          400
        )
      }

      const name =
        String(body.name)

      const pkg = {
        id: String(body.id),

        name,

        package:
          body.package ??
          `com.aetherdroid.${name
            .toLowerCase()
            .replace(
              /[^a-z0-9]/g,
              ''
            )}`,

        version:
          body.version ??
          '1.0.0',

        size:
          body.size ?? '—',

        status: 'pending',

        addedAt:
          new Date().toISOString(),
      }

      packages().set(
        pkg.id,
        pkg
      )

      return c.json(
        {
          ok: true,
          apk: pkg,
        },
        201
      )
    } catch (err) {
      console.error(
        '[api/apks POST] failed:',
        err?.stack ?? err
      )

      return c.json(
        {
          ok: false,
          error:
            'Failed to register package',
        },
        500
      )
    }
  }
)

// ---------------------------------------------------------------------------
// API: /api/install
//
// The old implementation only simulated installation.
// Real APK installation is handled by Runtime Host.
//
// Supported:
// - body.apkData: base64 APK
// - body.apkUrl: public URL to APK
// - body.apkName: filename
//
// If only apkId is supplied, the package is registered but there is no
// APK binary available to install.
// ---------------------------------------------------------------------------

app.post(
  '/api/install',
  async (c) => {
    try {
      const body =
        await c.req.json()

      const {
        sessionId,
        apkId,
      } = body ?? {}

      if (
        !sessionId ||
        !apkId
      ) {
        return c.json(
          {
            ok: false,
            error:
              'sessionId and apkId required',
          },
          400
        )
      }

      const session =
        touchSession(
          sessionId
        )

      if (!session) {
        return c.json(
          {
            ok: false,
            error:
              'Instance not found',
          },
          404
        )
      }

      if (
        session.status !==
        'online'
      ) {
        return c.json(
          {
            ok: false,
            error:
              'Instance not online',
          },
          409
        )
      }

      seedPackages()

      const pkg =
        packages().get(
          apkId
        )

      if (!pkg) {
        return c.json(
          {
            ok: false,
            error:
              'Package not found',
          },
          404
        )
      }

      if (
        session.installedApks.includes(
          apkId
        )
      ) {
        return c.json(
          {
            ok: false,
            error:
              'Package already installed on this instance',
          },
          409
        )
      }

      /*
       * If an APK URL is supplied, download it from the Worker and
       * forward the binary to Runtime Host.
       */
      if (
        body?.apkUrl
      ) {
        const apkResponse =
          await fetch(
            String(
              body.apkUrl
            )
          )

        if (!apkResponse.ok) {
          return c.json(
            {
              ok: false,
              error:
                `Failed to download APK: HTTP ${apkResponse.status}`,
            },
            502
          )
        }

        const apkBytes =
          await apkResponse.arrayBuffer()

        const safeName =
          String(
            body?.apkName ??
              pkg.name
          )
            .replace(
              /[^a-zA-Z0-9._-]/g,
              ''
            )

        const fileName =
          safeName.endsWith(
            '.apk'
          )
            ? safeName
            : `${safeName}.apk`

        const runtimeResponse =
          await runtimeFetch(
            c,
            `/instances/${encodeURIComponent(
              sessionId
            )}/apk`,
            {
              method: 'PUT',
              headers: {
                'Content-Type':
                  'application/vnd.android.package-archive',

                'X-Filename':
                  fileName,
              },
              body:
                apkBytes,
            }
          )

        const runtimeData =
          await runtimeJson(
            runtimeResponse
          )

        if (
          !runtimeResponse.ok
        ) {
          return c.json(
            {
              ok: false,
              error:
                runtimeError(
                  runtimeData,
                  'Runtime Host APK installation failed'
                ),
              runtime:
                runtimeData,
            },
            502
          )
        }

        session.installedApks.push(
          apkId
        )

        pkg.status =
          'installed'

        session.lastSeen =
          new Date().toISOString()

        return c.json({
          ok: true,
          sessionId,
          apkId,
          runtime:
            runtimeData,
        })
      }

      /*
       * Base64 APK support.
       */
      if (
        typeof body?.apkData ===
        'string'
      ) {
        const base64 =
          body.apkData
            .replace(
              /^data:.*?;base64,/,
              ''
            )
            .replace(
              /\s/g,
              ''
            )

        let binary

        try {
          const raw =
            atob(base64)

          binary =
            new Uint8Array(
              raw.length
            )

          for (
            let i = 0;
            i < raw.length;
            i++
          ) {
            binary[i] =
              raw.charCodeAt(i)
          }
        } catch {
          return c.json(
            {
              ok: false,
              error:
                'Invalid base64 APK data',
            },
            400
          )
        }

        const fileName =
          String(
            body?.apkName ??
              `${pkg.name}.apk`
          ).replace(
            /[^a-zA-Z0-9._-]/g,
            ''
          )

        const runtimeResponse =
          await runtimeFetch(
            c,
            `/instances/${encodeURIComponent(
              sessionId
            )}/apk`,
            {
              method: 'PUT',
              headers: {
                'Content-Type':
                  'application/vnd.android.package-archive',

                'X-Filename':
                  fileName,
              },
              body:
                binary,
            }
          )

        const runtimeData =
          await runtimeJson(
            runtimeResponse
          )

        if (
          !runtimeResponse.ok
        ) {
          return c.json(
            {
              ok: false,
              error:
                runtimeError(
                  runtimeData,
                  'Runtime Host APK installation failed'
                ),
              runtime:
                runtimeData,
            },
            502
          )
        }

        session.installedApks.push(
          apkId
        )

        pkg.status =
          'installed'

        session.lastSeen =
          new Date().toISOString()

        return c.json({
          ok: true,
          sessionId,
          apkId,
          runtime:
            runtimeData,
        })
      }

      /*
       * Do not pretend that an APK was installed when only metadata exists.
       */
      return c.json(
        {
          ok: false,
          error:
            'APK binary is required. Provide apkUrl or apkData.',
        },
        400
      )
    } catch (err) {
      console.error(
        '[api/install] failed:',
        err?.stack ?? err
      )

      return c.json(
        {
          ok: false,
          error:
            'Install failed',
        },
        500
      )
    }
  }
)

// ---------------------------------------------------------------------------
// API: /api/instances
// ---------------------------------------------------------------------------

app.get(
  '/api/instances',
  async (c) => {
    try {
      const store =
        sessions()

      const list = []

      for (
        const session of
          store.values()
      ) {
        try {
          const serialized =
            serializeSession(
              session
            )

          if (
            serialized
          ) {
            list.push(
              serialized
            )
          }
        } catch (err) {
          console.error(
            '[api/instances] serialize failed:',
            err?.stack ?? err
          )
        }
      }

      return c.json({
        ok: true,
        instances: list,
      })
    } catch (err) {
      console.error(
        '[api/instances] failed:',
        err?.stack ?? err
      )

      return c.json(
        {
          ok: false,
          error:
            'Failed to load instances',
        },
        500
      )
    }
  }
)

// ---------------------------------------------------------------------------
// API: /api/status
// ---------------------------------------------------------------------------

app.get(
  '/api/status',
  (c) => {
    try {
      const id =
        c.req.query('id')

      if (id) {
        const session =
          getSession(id)

        if (!session) {
          return c.json(
            {
              ok: false,
              error:
                'Instance not found',
            },
            404
          )
        }

        return c.json({
          ok: true,
          instance:
            serializeSession(
              session
            ),
        })
      }

      const list =
        Array.from(
          sessions().values()
        )

      return c.json({
        ok: true,

        stats: {
          active:
            list.filter(
              (session) =>
                session.status ===
                'online'
            ).length,

          vcpu:
            list.reduce(
              (
                total,
                session
              ) =>
                total +
                (session.status ===
                'online'
                  ? Number(
                      session.cpu
                    ) || 0
                  : 0),
              0
            ),

          ram:
            list.reduce(
              (
                total,
                session
              ) =>
                total +
                (session.status ===
                'online'
                  ? Number(
                      session.ram
                    ) || 0
                  : 0),
              0
            ),
        },
      })
    } catch (err) {
      console.error(
        '[api/status] failed:',
        err?.stack ?? err
      )

      return c.json(
        {
          ok: false,
          error:
            'Status request failed',
        },
        500
      )
    }
  }
)

// ---------------------------------------------------------------------------
// API: /api/start
//
// REAL:
// Cloudflare Worker -> Runtime Host -> Android Emulator
// ---------------------------------------------------------------------------

app.post(
  '/api/start',
  async (c) => {
    try {
      const body =
        await c.req
          .json()
          .catch(() => ({}))

      const session =
        makeSession({
          name:
            body?.name,

          cpu:
            Number(body?.cpu) >
            0
              ? Number(
                  body.cpu
                )
              : 2,

          ram:
            Number(body?.ram) >
            0
              ? Number(
                  body.ram
                )
              : 4,
        })

      /*
       * Save first so the Runtime Host and Worker use the same ID.
       */
      sessions().set(
        session.id,
        session
      )

      const runtimeResponse =
        await runtimeFetch(
          c,
          `/instances/${encodeURIComponent(
            session.id
          )}/start`,
          {
            method: 'POST',
          }
        )

      const runtimeData =
        await runtimeJson(
          runtimeResponse
        )

      if (
        !runtimeResponse.ok ||
        runtimeData?.ok === false
      ) {
        sessions().delete(
          session.id
        )

        return c.json(
          {
            ok: false,
            error:
              runtimeError(
                runtimeData,
                'Runtime Host failed to start instance'
              ),
            runtime:
              runtimeData,
          },
          502
        )
      }

      session.status =
        'online'

      session.bootedAt =
        new Date().toISOString()

      session.lastSeen =
        new Date().toISOString()

      sessions().set(
        session.id,
        session
      )

      return c.json(
        {
          ok: true,

          instance:
            serializeSession(
              session
            ),

          runtime:
            runtimeData,
        },
        201
      )
    } catch (err) {
      console.error(
        '[api/start] failed:',
        err?.stack ?? err
      )

      return c.json(
        {
          ok: false,
          error:
            err?.message ??
            'Failed to provision instance',
        },
        502
      )
    }
  }
)

// ---------------------------------------------------------------------------
// API: /api/power
//
// REAL:
// start / stop / restart -> Runtime Host
// ---------------------------------------------------------------------------

app.post(
  '/api/power',
  async (c) => {
    try {
      const body =
        await c.req.json()

      const {
        id,
        action,
      } = body ?? {}

      if (
        !id ||
        ![
          'start',
          'stop',
          'restart',
        ].includes(action)
      ) {
        return c.json(
          {
            ok: false,
            error:
              'id and valid action required',
          },
          400
        )
      }

      let session =
        getSession(id)

      if (
        !session &&
        action === 'start'
      ) {
        session =
          makeSession({
            id,
          })

        sessions().set(
          id,
          session
        )
      }

      if (!session) {
        return c.json(
          {
            ok: false,
            error:
              'Instance not found',
          },
          404
        )
      }

      const runtimeResponse =
        await runtimeFetch(
          c,
          `/instances/${encodeURIComponent(
            id
          )}/${action}`,
          {
            method: 'POST',
          }
        )

      const runtimeData =
        await runtimeJson(
          runtimeResponse
        )

      if (
        !runtimeResponse.ok ||
        runtimeData?.ok === false
      ) {
        return c.json(
          {
            ok: false,
            error:
              runtimeError(
                runtimeData,
                'Runtime Host power action failed'
              ),
            runtime:
              runtimeData,
          },
          502
        )
      }

      if (
        action === 'stop'
      ) {
        session.status =
          'offline'

        session.bootedAt =
          null

        session.pc =
          null
      } else {
        session.status =
          'online'

        session.bootedAt =
          new Date().toISOString()

        session.pc =
          null
      }

      session.lastSeen =
        new Date().toISOString()

      sessions().set(
        id,
        session
      )

      return c.json({
        ok: true,

        instance:
          serializeSession(
            session
          ),

        runtime:
          runtimeData,
      })
    } catch (err) {
      console.error(
        '[api/power] failed:',
        err?.stack ?? err
      )

      return c.json(
        {
          ok: false,
          error:
            err?.message ??
            'Power action failed',
        },
        502
      )
    }
  }
)

// ---------------------------------------------------------------------------
// API: /api/signal
//
// REAL:
// Browser -> Worker -> Runtime Host
//
// Runtime Host owns the actual WebRTC PeerConnection.
// ---------------------------------------------------------------------------

app.post(
  '/api/signal',
  async (c) => {
    try {
      const body =
        await c.req.json()

      const {
        sessionId,
        sdp,
        type,
      } = body ?? {}

      if (!sessionId) {
        return c.json(
          {
            ok: false,
            error:
              'sessionId is required',
          },
          400
        )
      }

      const session =
        touchSession(
          sessionId
        )

      if (!session) {
        return c.json(
          {
            ok: false,
            error:
              'Instance not found',
          },
          404
        )
      }

      if (
        session.status !==
        'online'
      ) {
        return c.json(
          {
            ok: false,
            error:
              'Instance not online',
          },
          409
        )
      }

      if (
        typeof sdp !==
        'string' ||
        !sdp
      ) {
        return c.json(
          {
            ok: false,
            error:
              'sdp is required',
          },
          400
        )
      }

      const runtimeResponse =
        await runtimeFetch(
          c,
          '/signal',
          {
            method: 'POST',

            body:
              JSON.stringify({
                sessionId,
                sdp,
                type:
                  type ??
                  'offer',
              }),
          }
        )

      const runtimeData =
        await runtimeJson(
          runtimeResponse
        )

      if (
        !runtimeResponse.ok ||
        runtimeData?.ok === false
      ) {
        return c.json(
          {
            ok: false,
            error:
              runtimeError(
                runtimeData,
                'Runtime Host signaling failed'
              ),
            runtime:
              runtimeData,
          },
          502
        )
      }

      session.pc = {
        type:
          type ??
          'offer',

        state:
          runtimeData?.answer
            ? 'answered'
            : 'signaling',

        updatedAt:
          new Date().toISOString(),
      }

      session.lastSeen =
        new Date().toISOString()

      return c.json({
        ok: true,
        sessionId,

        answer:
          runtimeData?.answer ??
          runtimeData,

        iceServers:
          runtimeData?.iceServers ??
          [
            {
              urls:
                'stun:stun.l.google.com:19302',
            },
          ],
      })
    } catch (err) {
      console.error(
        '[api/signal] failed:',
        err?.stack ?? err
      )

      return c.json(
        {
          ok: false,
          error:
            err?.message ??
            'Signaling failed',
        },
        502
      )
    }
  }
)

// ---------------------------------------------------------------------------
// API: /api/input
//
// REAL:
// Browser -> Worker -> Runtime Host -> ADB
// ---------------------------------------------------------------------------

const ANDROID_RESOLUTION = {
  width: 1080,
  height: 1920,
}

function clamp01(value) {
  const number =
    Number(value)

  if (
    !Number.isFinite(
      number
    )
  ) {
    return 0
  }

  return Math.min(
    1,
    Math.max(
      0,
      number
    )
  )
}

function adbCoord(
  value,
  max
) {
  return Math.round(
    clamp01(value) *
      max
  )
}

function translateTouch(
  session,
  body
) {
  const {
    type,
    x,
    y,
  } = body

  const X =
    adbCoord(
      x,
      ANDROID_RESOLUTION.width
    )

  const Y =
    adbCoord(
      y,
      ANDROID_RESOLUTION.height
    )

  if (type === 'down') {
    session._touchAnchor = {
      x: X,
      y: Y,
      ts: Date.now(),
    }

    return `input motionevent DOWN ${X} ${Y}`
  }

  if (type === 'move') {
    return `input motionevent MOVE ${X} ${Y}`
  }

  if (type === 'up') {
    const anchor =
      session._touchAnchor

    session._touchAnchor =
      null

    if (anchor) {
      const dist =
        Math.hypot(
          X - anchor.x,
          Y - anchor.y
        )

      if (dist < 20) {
        return `input tap ${X} ${Y}`
      }

      return (
        `input swipe ${anchor.x} ${anchor.y} ` +
        `${X} ${Y}`
      )
    }

    return `input tap ${X} ${Y}`
  }

  return null
}

function translateKey(body) {
  const KEYCODES = {
    back: 4,
    home: 3,
    recents: 187,
    power: 26,
  }

  const code =
    Number.isInteger(
      body?.keycode
    )
      ? body.keycode
      : KEYCODES[
          body?.key
        ]

  if (!code) {
    return null
  }

  return `input keyevent ${code}`
}

app.post(
  '/api/input',
  async (c) => {
    try {
      const body =
        await c.req.json()

      const {
        sessionId,
        kind,
        seq,
      } = body ?? {}

      if (
        !sessionId ||
        ![
          'touch',
          'key',
          'installation',
          'heartbeat',
        ].includes(kind)
      ) {
        return c.json(
          {
            ok: false,
            error:
              'sessionId and valid kind (touch|key|installation|heartbeat) required',
          },
          400
        )
      }

      const session =
        touchSession(
          sessionId
        )

      if (!session) {
        return c.json(
          {
            ok: false,
            error:
              'Instance not found',
          },
          404
        )
      }

      if (
        session.status !==
        'online'
      ) {
        return c.json(
          {
            ok: false,
            error:
              'Instance not online',
          },
          409
        )
      }

      if (
        Number.isInteger(seq)
      ) {
        if (
          seq <=
          session.lastInputSeq
        ) {
          return c.json(
            {
              ok: false,
              error:
                'Stale event dropped',
            },
            409
          )
        }

        session.lastInputSeq =
          seq
      }

      /*
       * Keep the original translation logic so the frontend API
       * remains compatible.
       */
      let command = null

      if (
        kind === 'heartbeat'
      ) {
        command =
          'echo keepalive ok'
      } else if (
        kind === 'touch'
      ) {
        command =
          translateTouch(
            session,
            body
          )
      } else if (
        kind === 'key'
      ) {
        command =
          translateKey(body)
      } else if (
        kind ===
        'installation'
      ) {
        const apkName =
          body?.apkName ??
          'app'

        command =
          `pm install -r /data/local/tmp/` +
          `${String(
            apkName
          ).replace(
            /[^a-zA-Z0-9._-]/g,
            ''
          )}.apk`

        session._pendingInstall =
          {
            apkName,
            startedAt:
              Date.now(),
          }
      }

      if (!command) {
        return c.json(
          {
            ok: false,
            error:
              'Unrecognized input payload',
          },
          400
        )
      }

      /*
       * Send the original event to Runtime Host.
       * Runtime Host is responsible for the actual ADB operation.
       */
      const runtimeResponse =
        await runtimeFetch(
          c,
          '/input',
          {
            method: 'POST',

            body:
              JSON.stringify({
                ...body,
                sessionId,
              }),
          }
        )

      const runtimeData =
        await runtimeJson(
          runtimeResponse
        )

      if (
        !runtimeResponse.ok ||
        runtimeData?.ok === false
      ) {
        return c.json(
          {
            ok: false,
            error:
              runtimeError(
                runtimeData,
                'Runtime Host input failed'
              ),
            runtime:
              runtimeData,
          },
          502
        )
      }

      session.lastSeen =
        new Date().toISOString()

      return c.json({
        ok: true,
        sessionId,
        command,
        runtime:
          runtimeData,
      })
    } catch (err) {
      console.error(
        '[api/input] failed:',
        err?.stack ?? err
      )

      return c.json(
        {
          ok: false,
          error:
            err?.message ??
            'Input bridge failure',
        },
        502
      )
    }
  }
)

// ---------------------------------------------------------------------------
// Static Assets / SPA fallback
//
// IMPORTANT:
// This project uses Cloudflare Workers Assets.
// Do NOT import or use Hono serveStatic().
// ---------------------------------------------------------------------------

app.get(
  '*',
  async (c) => {
    try {
      const assets =
        c.env?.ASSETS

      if (
        assets &&
        typeof assets.fetch ===
          'function'
      ) {
        return await assets.fetch(
          c.req.raw
        )
      }

      console.error(
        '[assets] ASSETS binding unavailable'
      )

      return c.text(
        'Static Assets binding is not configured.',
        500
      )
    } catch (err) {
      console.error(
        '[assets] failed:',
        err?.stack ?? err
      )

      return c.text(
        'Failed to load application.',
        500
      )
    }
  }
)

export default app

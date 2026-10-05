import { Hono } from 'hono'

const app = new Hono()

// D1:
// Binding: DB
// Database ID:
// 86dc7fb1-83f1-4492-a7c4-a43b1cbcdcdd

app.get('/api/db-test', async (c) => {
  try {
    const result = await c.env.DB
      .prepare('SELECT 1 AS ok')
      .first()

    return c.json({
      ok: true,
      database: 'connected',
      result
    })
  } catch (error) {
    console.error('[D1] error:', error)

    return c.json({
      ok: false,
      database: 'error',
      error: error?.message ?? 'D1 connection failed'
    }, 500)
  }
})

app.get('*', async (c) => {
  const assets = c.env.ASSETS

  if (assets) {
    return assets.fetch(c.req.raw)
  }

  return c.text('ASSETS binding is not configured.', 500)
})

export default app

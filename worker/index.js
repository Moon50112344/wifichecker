// worker/index.js — Cloudflare Worker: phục vụ static assets + API /api/* lưu vào D1
// Xác thực bằng Firebase Auth ID token (gửi ở header: Authorization: Bearer <token>)
// Mỗi user chỉ thấy/sửa/xóa được dữ liệu của chính mình (lọc theo uid).

const PROJECT_ID = 'wifichecker-ccf9b'; // khớp với firebaseConfig trong dashboard.html
let keyCache = { keys: null, expiry: 0 };

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function b64urlToBuffer(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function b64urlToJson(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return JSON.parse(atob(str));
}

// Lấy JWKS của Firebase (chứa public key để verify chữ ký JWT), cache theo max-age
async function getFirebaseJwks() {
  const now = Date.now();
  if (keyCache.keys && now < keyCache.expiry) return keyCache.keys;
  const res = await fetch(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
  );
  if (!res.ok) throw new Error('Không tải được Firebase public keys');
  const cacheControl = res.headers.get('cache-control') || '';
  const m = cacheControl.match(/max-age=(\d+)/);
  const maxAge = m ? parseInt(m[1], 10) * 1000 : 3600 * 1000;
  const jwks = await res.json();
  keyCache = { keys: jwks.keys, expiry: now + maxAge };
  return jwks.keys;
}

// Verify Firebase Auth ID token → trả về { uid, email, emailVerified } hoặc null
async function verifyFirebaseToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  let header, payload;
  try {
    header = b64urlToJson(parts[0]);
    payload = b64urlToJson(parts[1]);
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) return null; // hết hạn
  if (!payload.iat || payload.iat > now + 300) return null; // phát hành trong tương lai
  if (payload.iss !== `https://securetoken.google.com/${PROJECT_ID}`) return null;
  if (payload.aud !== PROJECT_ID) return null;
  if (!payload.sub || typeof payload.sub !== 'string') return null;

  // Verify chữ ký RS256 bằng public key khớp kid
  try {
    const keys = await getFirebaseJwks();
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const data = new TextEncoder().encode(parts[0] + '.' + parts[1]);
    const sig = b64urlToBuffer(parts[2]);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, sig, data);
    if (!valid) return null;
  } catch {
    return null;
  }

  return {
    uid: payload.sub,
    email: payload.email || null,
    emailVerified: !!payload.email_verified,
  };
}

async function handleApi(request, env, url) {
  const user = await verifyFirebaseToken(request.headers.get('Authorization')).catch(() => null);
  if (!user) return json({ error: 'Chưa đăng nhập hoặc phiên hết hạn' }, 401);

  const path = url.pathname.replace(/^\/api/, '');
  const method = request.method;

  try {
    // GET /api/checkers — danh sách của user hiện tại (không trả password)
    if (path === '/checkers' && method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT id, username, status, created_at FROM wifi_checkers WHERE user_id = ? ORDER BY created_at DESC'
      )
        .bind(user.uid)
        .all();
      return json({ checkers: results });
    }

    // POST /api/checkers — tạo mới
    if (path === '/checkers' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!username || !password) return json({ error: 'Vui lòng nhập tên đăng nhập và mật khẩu' }, 400);
      const id = crypto.randomUUID();
      const createdAt = Date.now();
      await env.DB.prepare(
        'INSERT INTO wifi_checkers (id, user_id, username, password, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind(id, user.uid, username, password, 'offline', createdAt)
        .run();
      return json({ id, username, status: 'offline', created_at: createdAt }, 201);
    }

    const m = path.match(/^\/checkers\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);

      // GET /api/checkers/:id — chi tiết 1 bản ghi (có password, dùng cho webremote.html)
      if (method === 'GET') {
        const row = await env.DB.prepare(
          'SELECT id, username, password, status, created_at FROM wifi_checkers WHERE id = ? AND user_id = ?'
        )
          .bind(id, user.uid)
          .first();
        if (!row) return json({ error: 'Không tìm thấy' }, 404);
        return json(row);
      }

      // DELETE /api/checkers/:id — xóa (chỉ của chính user)
      if (method === 'DELETE') {
        const res = await env.DB.prepare(
          'DELETE FROM wifi_checkers WHERE id = ? AND user_id = ?'
        )
          .bind(id, user.uid)
          .run();
        if (res.meta.changes === 0) return json({ error: 'Không tìm thấy' }, 404);
        return json({ ok: true });
      }

      // PATCH /api/checkers/:id — cập nhật status (online/offline), dùng cho webremote/device
      if (method === 'PATCH') {
        const body = await request.json().catch(() => ({}));
        const status = body.status === 'online' ? 'online' : 'offline';
        const res = await env.DB.prepare(
          'UPDATE wifi_checkers SET status = ? WHERE id = ? AND user_id = ?'
        )
          .bind(status, id, user.uid)
          .run();
        if (res.meta.changes === 0) return json({ error: 'Không tìm thấy' }, 404);
        return json({ ok: true });
      }
    }

    return json({ error: 'Endpoint không tồn tại' }, 404);
  } catch (err) {
    return json({ error: 'Lỗi server: ' + err.message }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url);
    }
    // Mọi route khác: phục vụ static file (dashboard.html, login, webremote...) từ assets
    return env.ASSETS.fetch(request);
  },
};

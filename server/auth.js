// 鉴权：HMAC 签名的轻量 token（不依赖第三方库），格式 base64url(payload).sig
// 生产环境通过环境变量 SERVER_SECRET 固定密钥；未设置时进程启动随机生成（重启后旧 token 失效）
import crypto from 'crypto'

const SECRET = process.env.SERVER_SECRET || crypto.randomBytes(32).toString('hex')
const TOKEN_TTL = 7 * 24 * 3600 * 1000 // 7 天

export function signToken(userId) {
  const payload = Buffer.from(
    JSON.stringify({ uid: userId, exp: Date.now() + TOKEN_TTL })
  ).toString('base64url')
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null
  const dot = token.indexOf('.')
  if (dot < 0) return null
  const payload = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expect)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString())
    if (!data || !data.uid || !data.exp || data.exp < Date.now()) return null
    return data
  } catch {
    return null
  }
}

// Express 中间件：校验 Authorization: Bearer <token>，挂载 req.user
export function authMiddleware(store) {
  return (req, res, next) => {
    const header = req.headers['authorization'] || ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null
    const data = verifyToken(token)
    if (!data) return res.json({ code: 1001, msg: '未登录或 token 失效' })
    const user = store.users.get(data.uid)
    if (!user) return res.json({ code: 1001, msg: '用户不存在，请重新登录' })
    req.user = user
    next()
  }
}

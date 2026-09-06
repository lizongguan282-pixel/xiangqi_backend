// 用户模块（api.md §1）
import { Router } from 'express'
import { store, findOrCreateUser } from '../store.js'
import { signToken, authMiddleware } from '../auth.js'

const router = Router()

// code2session 换取 openid；未配置 WX_APPID/WX_SECRET 时为开发模式（code 直接当 openid）
async function code2session(code) {
  const appid = process.env.WX_APPID
  const secret = process.env.WX_SECRET
  if (!appid || !secret) {
    return { openid: `dev_${code}` }
  }
  const url =
    'https://api.weixin.qq.com/sns/jscode2session' +
    `?appid=${encodeURIComponent(appid)}` +
    `&secret=${encodeURIComponent(secret)}` +
    `&js_code=${encodeURIComponent(code)}` +
    '&grant_type=authorization_code'
  const resp = await fetch(url)
  const data = await resp.json()
  if (!data || !data.openid) {
    throw new Error(`微信 code2session 失败: ${JSON.stringify(data)}`)
  }
  return { openid: data.openid }
}

// POST /api/user/login（补充 §1.1：增加可选 avatarUrl）
router.post('/login', async (req, res) => {
  try {
    const { code, nickname, avatarUrl } = req.body || {}
    if (!code || typeof code !== 'string') {
      return res.json({ code: 4000, msg: '参数错误：缺少 code' })
    }
    const { openid } = await code2session(code)
    const user = findOrCreateUser(openid, nickname, avatarUrl)
    res.json({
      code: 0,
      msg: 'ok',
      data: {
        token: signToken(user.userId),
        userId: user.userId,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
        god: !!user.god,
      },
    })
  } catch (e) {
    res.json({ code: 5000, msg: e.message || '服务器内部错误' })
  }
})

router.use(authMiddleware(store))

// GET /api/user/me（断线重连用；补充 §1.3：补 avatarUrl）
router.get('/me', (req, res) => {
  res.json({
    code: 0,
    msg: 'ok',
    data: {
      userId: req.user.userId,
      nickname: req.user.nickname,
      avatarUrl: req.user.avatarUrl,
      god: !!req.user.god,
    },
  })
})

export default router

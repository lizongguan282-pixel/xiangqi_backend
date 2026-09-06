// 中国象棋（揭棋）联机后端入口：REST + WebSocket
// 启动：node server/index.js （或 bash entrypoint.sh）
// 环境变量：
//   PORT           HTTP/WS 端口，默认 8080
//   WX_APPID / WX_SECRET  微信小程序 code2session 凭证；未配置时登录为开发模式
//   SERVER_SECRET  token 签名密钥；未配置时进程启动随机生成
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import express from 'express'
import { store } from './store.js'
import { initWs } from './ws.js'
import { settle } from './gameLogic.js'
import userRouter from './routes/user.js'
import roomRouter from './routes/room.js'
import gameRouter from './routes/game.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
app.use(express.json({ limit: '64kb' }))

// 静态资源：/static/* → 项目根 public/static/*（BGM 音频等外链资源）
// Content-Type 由 express.static 按扩展名自动处理（.mp3 → audio/mpeg）
app.use(
  '/static',
  express.static(path.join(__dirname, '..', 'public', 'static'), {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 音频缓存 7 天
  })
)

app.get('/health', (req, res) => res.json({ code: 0, msg: 'ok', data: { status: 'up' } }))

app.use('/api/user', userRouter)
app.use('/api/room', roomRouter)
app.use('/api/game', gameRouter)

// 兜底 404 / 异常
app.use('/api', (req, res) => res.json({ code: 4040, msg: '接口不存在' }))
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.json({ code: 4000, msg: '请求体不是合法 JSON' })
  }
  console.error('[server error]', err)
  res.json({ code: 5000, msg: '服务器内部错误' })
})

const server = http.createServer(app)
initWs(server)

// 计时权威：每秒巡检对局，局时/步时归零判超时负并广播 game_over
setInterval(() => {
  for (const room of store.rooms.values()) {
    if (room.game && room.game.status === 'playing') settle(room)
  }
}, 1000)

const PORT = process.env.PORT || 8080
server.listen(PORT, '0.0.0.0', () => {
  console.log(`象棋揭棋后端已启动：http://0.0.0.0:${PORT}  (WebSocket: /ws?token=xxx)`)
  if (!process.env.WX_APPID || !process.env.WX_SECRET) {
    console.log('[提示] 未配置 WX_APPID/WX_SECRET，登录接口运行在开发模式（code 直接映射 openid）')
  }
})

// WebSocket 推送中心：wss://域名/ws?token=xxx
// 消息：客户端 {"type":"ping"} → 服务端 {"type":"pong"}
// 服务端推送：room_update / game_start / move_applied / game_over /
//            undo_request / undo_result / opponent_offline（见 api.md §4）
import { WebSocketServer } from 'ws'
import { verifyToken } from './auth.js'
import { store, playerColor } from './store.js'

// userId -> Set<ws>（同一用户多端登录，同 token 重连直接复用）
const sockets = new Map()
// userId -> Timer：对手离线 10 秒宽限计时（补充 §3.3 防抖，避免前端反复弹 Toast）
const offlineTimers = new Map()
const OFFLINE_GRACE_MS = 10000

// 局内快捷表情：code 白名单 e1~e30（前端每加表情同步扩），同一房间 500ms 限频
const EMOJI_CODE_RE = /^e([1-9]|[12][0-9]|30)$/
const EMOJI_MIN_INTERVAL_MS = 500
const emojiLastAt = new Map() // roomId -> last sent timestamp

// 局内快捷语音：code 白名单 v1~v8，同一房间 500ms 限频（与 emoji 同构、独立计数）
const PHRASE_CODE_RE = /^v([1-8])$/
const PHRASE_MIN_INTERVAL_MS = 500
const phraseLastAt = new Map() // roomId -> last sent timestamp

export function initWs(server) {
  const wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws, req) => {
    let userId = null
    try {
      const url = new URL(req.url, 'http://localhost')
      const data = verifyToken(url.searchParams.get('token') || '')
      if (data && store.users.has(data.uid)) userId = data.uid
    } catch {
      // URL 解析失败，按未授权处理
    }
    if (!userId) {
      ws.close(4001, 'unauthorized')
      return
    }

    if (!sockets.has(userId)) sockets.set(userId, new Set())
    sockets.get(userId).add(ws)

    // 重连成功：取消未触发的离线宽限计时，不补发 opponent_offline
    const pending = offlineTimers.get(userId)
    if (pending) {
      clearTimeout(pending)
      offlineTimers.delete(userId)
    }

    ws.on('message', (buf) => {
      let msg
      try {
        msg = JSON.parse(buf.toString())
      } catch {
        return
      }
      if (!msg) return
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }))
        return
      }
      // 局内快捷表情转发：客户端 → 服务端校验 → 推房间双方
      if (msg.type === 'emoji') {
        handleEmoji(userId, msg)
      }
      // 局内快捷语音转发：与 emoji 同构，独立限频/白名单
      if (msg.type === 'phrase') {
        handlePhrase(userId, msg)
      }
    })
    ws.on('error', () => {})
    ws.on('close', () => {
      const set = sockets.get(userId)
      if (set) {
        set.delete(ws)
        if (!set.size) sockets.delete(userId)
      }
      handleDisconnect(userId)
    })
  })

  return wss
}

// 处理上行 emoji：校验房间归属、code 白名单、限频，通过后推送给房间双方
function handleEmoji(userId, msg) {
  const roomId = typeof msg.roomId === 'string' ? msg.roomId : ''
  const code = typeof msg.code === 'string' ? msg.code : ''
  const room = store.rooms.get(roomId)
  if (!room) return // 房间不存在：静默丢弃
  // 发送者必须是房间内 red/black 任一方，拒绝旁观者
  const from = playerColor(room, userId)
  if (!from) return
  // code 白名单
  if (!EMOJI_CODE_RE.test(code)) return
  // 同房间 500ms 限频，超出直接丢弃
  const now = Date.now()
  const last = emojiLastAt.get(roomId) || 0
  if (now - last < EMOJI_MIN_INTERVAL_MS) return
  emojiLastAt.set(roomId, now)
  // from 由服务端按玩家颜色注入，绝不采信客户端
  const data = { from, code }
  for (const color of ['red', 'black']) {
    const p = room[color]
    if (p) sendToUser(p.userId, 'emoji', data)
  }
}

// 处理上行 phrase：与 emoji 完全同构，仅 type/白名单/限频计数器不同；不落库
function handlePhrase(userId, msg) {
  const roomId = typeof msg.roomId === 'string' ? msg.roomId : ''
  const code = typeof msg.code === 'string' ? msg.code : ''
  const room = store.rooms.get(roomId)
  if (!room) return // 房间不存在：静默丢弃
  // 发送者必须是房间内 red/black 任一方，拒绝旁观者
  const from = playerColor(room, userId)
  if (!from) return
  // code 白名单：v1~v8
  if (!PHRASE_CODE_RE.test(code)) return
  // 同房间 500ms 限频（与 emoji 独立计数），超出直接丢弃
  const now = Date.now()
  const last = phraseLastAt.get(roomId) || 0
  if (now - last < PHRASE_MIN_INTERVAL_MS) return
  phraseLastAt.set(roomId, now)
  // from 由服务端按玩家颜色注入，绝不采信客户端
  const data = { from, code }
  for (const color of ['red', 'black']) {
    const p = room[color]
    if (p) sendToUser(p.userId, 'phrase', data)
  }
}

export function isOnline(userId) {
  return sockets.has(userId)
}

export function sendToUser(userId, type, data) {
  const set = sockets.get(userId)
  if (!set) return
  const text = JSON.stringify({ type, data })
  for (const ws of set) {
    try {
      ws.send(text)
    } catch {
      // 单连接发送失败忽略
    }
  }
}

// 向房间内双方推送；dataFor(color) 可按视角生成不同 data（如 State 含 myColor/暗子屏蔽）
export function broadcastRoom(room, type, dataFor) {
  for (const color of ['red', 'black']) {
    const p = room[color]
    if (!p) continue
    sendToUser(p.userId, type, dataFor ? dataFor(color) : null)
  }
}

// 对手全部连接断开时，启动 10 秒宽限计时；期满仍未重连且在房间内，才给对局中的另一方推一次 opponent_offline
// （补充 §3.3：不要一断心跳就发；重连成功不补发）
function handleDisconnect(userId) {
  if (sockets.has(userId)) return // 仍有其他设备在线
  if (offlineTimers.has(userId)) return // 宽限计时已存在，不重复启动
  offlineTimers.set(
    userId,
    setTimeout(() => {
      offlineTimers.delete(userId)
      if (sockets.has(userId)) return // 10 秒内重连成功，不发
      for (const room of store.rooms.values()) {
        const color = playerColor(room, userId)
        if (!color) continue
        const opp = room[color === 'red' ? 'black' : 'red']
        if (opp && room.status !== 'ended') {
          sendToUser(opp.userId, 'opponent_offline', {})
        }
      }
    }, OFFLINE_GRACE_MS)
  )
}

// 房间模块（api.md §2）
import { Router } from 'express'
import { store, genRoomId, playerColor, roomView } from '../store.js'
import { authMiddleware } from '../auth.js'
import { startGame, buildStateView, endGame } from '../gameLogic.js'
import { broadcastRoom, sendToUser } from '../ws.js'

const router = Router()
router.use(authMiddleware(store))

const DEFAULT_GAME_TIME = 600
const DEFAULT_STEP_TIME = 60

// POST /api/room/create  创建者 = 红方（红先）
router.post('/create', (req, res) => {
  const body = req.body || {}
  const mode = ['standard', 'flip', 'random'].includes(body.mode) ? body.mode : 'flip'
  const gameTime = Number.isInteger(body.gameTime) && body.gameTime > 0 ? body.gameTime : DEFAULT_GAME_TIME
  const stepTime = Number.isInteger(body.stepTime) && body.stepTime > 0 ? body.stepTime : DEFAULT_STEP_TIME

  const room = {
    roomId: genRoomId(),
    mode,
    gameTime,
    stepTime,
    status: 'waiting', // waiting → playing → ended
    red: { userId: req.user.userId, nickname: req.user.nickname, ready: false },
    black: null,
    createTime: Date.now(),
    game: null,
  }
  store.rooms.set(room.roomId, room)
  res.json({ code: 0, msg: 'ok', data: roomView(room) })
})

// POST /api/room/join  邀请链接进入
router.post('/join', (req, res) => {
  const { roomId } = req.body || {}
  const room = roomId && store.rooms.get(roomId)
  if (!room) return res.json({ code: 2001, msg: '房间不存在' })

  const myColor = playerColor(room, req.user.userId)
  if (myColor) {
    // 已在房间（断线重连/重复加入）：幂等返回
    return res.json({ code: 0, msg: 'ok', data: roomView(room) })
  }
  if (room.status !== 'waiting' || room.game) {
    return res.json({ code: 2003, msg: '对局中不可加入' })
  }
  if (room.black) return res.json({ code: 2002, msg: '房间已满' })

  room.black = { userId: req.user.userId, nickname: req.user.nickname, ready: false }
  broadcastRoom(room, 'room_update', () => roomView(room))
  res.json({ code: 0, msg: 'ok', data: roomView(room) })
})

// GET /api/room/:roomId
router.get('/:roomId', (req, res) => {
  const room = store.rooms.get(req.params.roomId)
  if (!room) return res.json({ code: 2001, msg: '房间不存在' })
  res.json({ code: 0, msg: 'ok', data: roomView(room) })
})

// POST /api/room/ready  双方 ready=true 自动开局并发牌
router.post('/ready', (req, res) => {
  const { roomId, ready } = req.body || {}
  const room = roomId && store.rooms.get(roomId)
  if (!room) return res.json({ code: 2001, msg: '房间不存在' })
  const color = playerColor(room, req.user.userId)
  if (!color) return res.json({ code: 4000, msg: '你不在该房间中' })

  if (room.status === 'waiting') {
    room[color].ready = !!ready
  }

  const redReady = !!(room.red && room.red.ready)
  const blackReady = !!(room.black && room.black.ready)

  // 双方就绪 → 自动开局（服务端发牌），推送 game_start
  if (room.status === 'waiting' && room.black && redReady && blackReady) {
    startGame(room)
    broadcastRoom(room, 'room_update', () => roomView(room))
    broadcastRoom(room, 'game_start', (c) => buildStateView(room, c, room[c].userId))
  } else if (room.status === 'waiting') {
    broadcastRoom(room, 'room_update', () => roomView(room))
  }

  res.json({ code: 0, msg: 'ok', data: { redReady, blackReady } })
})

// POST /api/room/leave
router.post('/leave', (req, res) => {
  const { roomId } = req.body || {}
  const room = roomId && store.rooms.get(roomId)
  if (!room) return res.json({ code: 2001, msg: '房间不存在' })
  const color = playerColor(room, req.user.userId)
  if (!color) return res.json({ code: 0, msg: 'ok', data: {} })

  // 对局中离开 = 认输，广播 game_over
  if (room.game && room.game.status === 'playing') {
    endGame(room, color === 'red' ? 'black' : 'red', '认输')
  }

  const opponent = room[color === 'red' ? 'black' : 'red']
  room[color] = null

  if (!room.red && !room.black) {
    store.rooms.delete(room.roomId)
  } else if (color === 'red') {
    // 创建者离开：房间关闭，通知另一方
    if (opponent) {
      sendToUser(opponent.userId, 'room_update', { ...roomView(room), status: 'closed', red: null })
    }
    store.rooms.delete(room.roomId)
  } else {
    broadcastRoom(room, 'room_update', () => roomView(room))
  }
  res.json({ code: 0, msg: 'ok', data: {} })
})

export default router

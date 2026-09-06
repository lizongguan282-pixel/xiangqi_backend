// 对局模块（api.md §3）
import { Router } from 'express'
import { store, playerColor } from '../store.js'
import { authMiddleware } from '../auth.js'
import {
  settle,
  doMove,
  endGame,
  applyUndo,
  startGame,
  buildStateView,
  godSwap,
} from '../gameLogic.js'
import { broadcastRoom, sendToUser } from '../ws.js'

const router = Router()
router.use(authMiddleware(store))

// 统一取房间 + 校验参与者
function getRoom(req, res) {
  const room = store.rooms.get(req.params.roomId)
  if (!room) {
    res.json({ code: 2001, msg: '房间不存在' })
    return null
  }
  const color = playerColor(room, req.user.userId)
  if (!color) {
    res.json({ code: 4000, msg: '你不在该房间中' })
    return null
  }
  return { room, color }
}

const opponentOf = (c) => (c === 'red' ? 'black' : 'red')

// GET /api/game/:roomId/state  进入对局页 / 断线重连 / 轮询降级
router.get('/:roomId/state', (req, res) => {
  const ctx = getRoom(req, res)
  if (!ctx) return
  settle(ctx.room)
  res.json({ code: 0, msg: 'ok', data: buildStateView(ctx.room, ctx.color, req.user.userId) })
})

// POST /api/game/:roomId/move  走棋（服务端权威校验 + 计时 + 终局判定）
router.post('/:roomId/move', (req, res) => {
  const ctx = getRoom(req, res)
  if (!ctx) return
  const { room, color } = ctx
  const { from, to } = req.body || {}

  const result = doMove(room, color, from, to)
  if (result.error) {
    return res.json({ code: result.error, msg: result.msg })
  }

  // 推送对手落子（对手视角 State，不含被吃暗子真身）
  const oppColor = opponentOf(color)
  const opp = room[oppColor]
  if (opp) sendToUser(opp.userId, 'move_applied', buildStateView(room, oppColor, opp.userId))

  const data = buildStateView(room, color, req.user.userId)
  // 被吃暗子真身只随走子方响应返回
  if (result.captured) data.captured = result.captured
  res.json({ code: 0, msg: 'ok', data })
})

// POST /api/game/:roomId/resign  认输
router.post('/:roomId/resign', (req, res) => {
  const ctx = getRoom(req, res)
  if (!ctx) return
  const { room, color } = ctx
  if (!room.game || room.game.status !== 'playing') {
    return res.json({ code: 4004, msg: '对局已结束' })
  }
  const winner = opponentOf(color)
  endGame(room, winner, '认输')
  res.json({ code: 0, msg: 'ok', data: { winner, reason: '认输' } })
})

// POST /api/game/:roomId/undo-request  请求悔棋（协商制，可选）
router.post('/:roomId/undo-request', (req, res) => {
  const ctx = getRoom(req, res)
  if (!ctx) return
  const { room, color } = ctx
  if (!room.game || room.game.status !== 'playing') {
    return res.json({ code: 4004, msg: '对局已结束' })
  }
  room.game.undoRequest = { from: color }
  const opp = room[opponentOf(color)]
  if (opp) sendToUser(opp.userId, 'undo_request', { from: color })
  res.json({ code: 0, msg: 'ok', data: { from: color } })
})

// POST /api/game/:roomId/undo-response  应答悔棋
router.post('/:roomId/undo-response', (req, res) => {
  const ctx = getRoom(req, res)
  if (!ctx) return
  const { room, color } = ctx
  const g = room.game
  if (!g || g.status !== 'playing') return res.json({ code: 4004, msg: '对局已结束' })
  if (!g.undoRequest) return res.json({ code: 4000, msg: '没有待处理的悔棋请求' })
  if (g.undoRequest.from === color) return res.json({ code: 4000, msg: '不能应答自己的悔棋请求' })

  const agree = !!(req.body && req.body.agree)
  if (agree && applyUndo(room)) {
    broadcastRoom(room, 'undo_result', (c) => ({
      agree: true,
      state: buildStateView(room, c, room[c].userId),
    }))
  } else {
    g.undoRequest = null
    broadcastRoom(room, 'undo_result', () => ({ agree: false }))
  }
  res.json({ code: 0, msg: 'ok', data: { agree } })
})

// POST /api/game/:roomId/rematch  再来一局：双方都请求后重新发牌
router.post('/:roomId/rematch', (req, res) => {
  const ctx = getRoom(req, res)
  if (!ctx) return
  const { room, color } = ctx
  const g = room.game
  if (!g) return res.json({ code: 4000, msg: '对局尚未开始' })
  // 仅终局后接受再来一局请求；对局进行中的请求（双击/重试）忽略，
  // 避免把 rematch 标记写到下一局污染后续判定
  if (g.status !== 'ended') {
    return res.json({
      code: 0,
      msg: 'ok',
      data: {
        started: false,
        redRematch: g.rematch.red,
        blackRematch: g.rematch.black,
      },
    })
  }

  g.rematch[color] = true
  let started = false
  if (g.rematch.red && g.rematch.black) {
    startGame(room) // 重新发牌、重置计时，状态回 playing，moveCount 归零
    // 向双方 WS 都推送完整新 State（不能只回第二个请求方，否则先点的一方卡死）
    broadcastRoom(room, 'game_start', (c) => buildStateView(room, c, room[c].userId))
    started = true
  }
  res.json({
    code: 0,
    msg: 'ok',
    data: {
      started,
      redRematch: room.game.rematch.red,
      blackRematch: room.game.rematch.black,
    },
  })
})

// POST /api/game/:roomId/god-swap  上帝模式换身份（上帝模式实现方案 §2.3）
// 校验失败一律返回 4000 普通业务错误，不向非上帝暴露该功能的存在
router.post('/:roomId/god-swap', (req, res) => {
  const ctx = getRoom(req, res)
  if (!ctx) return
  if (!req.user.god) return res.json({ code: 4000, msg: '无权限' })

  const { from, toType } = req.body || {}
  const result = godSwap(ctx.room, from, toType)
  if (result.error) return res.json({ code: result.error, msg: result.msg })

  // 返回上帝视角完整 State（暗棋带真身）；不推送对手、不改 moveCount/计时
  res.json({
    code: 0,
    msg: 'ok',
    data: buildStateView(ctx.room, ctx.color, req.user.userId),
  })
})

export default router

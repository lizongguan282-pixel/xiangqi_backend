// 对局核心逻辑：直接复用根目录前端规则引擎 xiangqi.js（纯 JS，服务端同构）
// 内部表示：引擎的字符棋盘（大写红/小写黑）+ 10x9 hidden 暗子标记矩阵
// 对外表示：api.md §3.1 的 State（棋子对象 {t,color,hidden}，按视角屏蔽暗子真身）
import {
  createFlipGame,
  createRandomFlipGame,
  createInitialBoard,
  legalMoves,
  pieceMoves,
  applyMove,
  isInCheck,
  gameStatus as engineGameStatus,
  isRed,
} from '../xiangqi.js'
import { broadcastRoom } from './ws.js'
import { playerView, isGodUser } from './store.js'

export function falseMatrix() {
  return Array.from({ length: 10 }, () => Array(9).fill(false))
}

// 掩码盘（新增模式 §3.0）：暗子替换为位置方占位子（row>=5→'Q'红，row<=4→'q'黑）
// 明子保留真身大小写。引擎在掩码盘上跑，归属/吃子/送将自动按有效阵营判定
// flip/standard 模式下暗子颜色恒等于位置方，掩码等价于原值，零影响
function maskBoard(board, hidden) {
  return board.map((row, r) =>
    row.map((p, c) => {
      if (!p) return null
      if (hidden[r][c]) return r >= 5 ? 'Q' : 'q'
      return p
    })
  )
}

function validCoord(v) {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    Number.isInteger(v[0]) &&
    Number.isInteger(v[1]) &&
    v[0] >= 0 &&
    v[0] <= 9 &&
    v[1] >= 0 &&
    v[1] <= 8
  )
}

// 开局（双方就绪 / 再来一局）：揭棋由服务端发牌，随机只发生在这里
export function startGame(room) {
  const flipMode = room.mode !== 'standard'
  let board
  let hidden
  if (room.mode === 'random') {
    // 全随机：30 枚红黑棋子合并全盘洗牌（新增模式 §2）
    ;({ board, hidden } = createRandomFlipGame())
  } else if (flipMode) {
    ;({ board, hidden } = createFlipGame())
  } else {
    board = createInitialBoard()
    hidden = falseMatrix()
  }
  const now = Date.now()
  room.game = {
    status: 'playing', // playing | ended
    mode: room.mode,
    flipMode,
    board, // 字符棋盘，含暗子真实身份（绝不下发）
    hidden, // 10x9 暗子标记
    turn: 'red', // 红先
    clocks: { red: room.gameTime, black: room.gameTime }, // 双方剩余局时（秒）
    stepRemain: room.stepTime, // 当前行棋方剩余步时（秒）
    turnStartedAt: now,
    gameTime: room.gameTime,
    stepTime: room.stepTime,
    moveCount: 0,
    lastMove: null,
    tray: { red: [], black: [] }, // 各方吃到的子：{ t(大写真实类型), color(被吃子颜色), wasHidden }
    history: [], // 悔棋快照
    winner: null,
    reason: null,
    rematch: { red: false, black: false },
    undoRequest: null, // { from: 'red'|'black' }
  }
  room.status = 'playing'
  return room.game
}

// 终局：reason ∈ 绝杀/困毙/认输/超时；广播 game_over
export function endGame(room, winner, reason) {
  const g = room.game
  if (!g || g.status !== 'playing') return
  g.status = 'ended'
  g.winner = winner
  g.reason = reason
  room.status = 'ended'
  broadcastRoom(room, 'game_over', () => ({ winner, reason }))
}

// 惰性计时结算：扣减当前行棋方局时/步时；任一归零判超时负
// 轮询取局面、走棋、定时巡检都会调用，幂等
export function settle(room, now = Date.now()) {
  const g = room.game
  if (!g || g.status !== 'playing') return
  const elapsed = (now - g.turnStartedAt) / 1000
  if (elapsed <= 0) return
  const side = g.turn
  if (elapsed >= g.stepRemain || elapsed >= g.clocks[side]) {
    g.clocks[side] = Math.max(0, g.clocks[side] - elapsed)
    g.stepRemain = 0
    endGame(room, side === 'red' ? 'black' : 'red', '超时')
    return
  }
  g.clocks[side] -= elapsed
  g.stepRemain -= elapsed
  g.turnStartedAt = now
}

// 走棋。返回 {} 成功（含 captured 表示吃到暗子的真身，仅给走子方），或 { error, msg }
export function doMove(room, color, from, to) {
  settle(room)
  const g = room.game
  if (!g || g.status === 'ended') return { error: 4004, msg: '对局已结束' }
  if (g.turn !== color) return { error: 4001, msg: '不该你走棋' }
  if (!validCoord(from) || !validCoord(to)) return { error: 4002, msg: '非法走法：坐标无效' }

  const [fr, fc] = from
  const [tr, tc] = to
  const ch = g.board[fr][fc]
  // 有效阵营（新增模式 §3.1）：暗子→所在半场方，明子→真身颜色
  const effRed = ch ? (g.hidden[fr][fc] ? fr >= 5 : isRed(ch)) : null
  if (effRed === null || effRed !== (color === 'red')) {
    return { error: 4002, msg: '非法走法：该位置没有你的棋子' }
  }

  // 走法校验跑在掩码盘上：归属/吃子/送将自动按有效阵营（新增模式 §3.0）
  const mBoard = maskBoard(g.board, g.hidden)
  const isLegal = legalMoves(mBoard, fr, fc, g.hidden, g.flipMode).some(
    ([r, c]) => r === tr && c === tc
  )
  if (!isLegal) {
    // 伪合法（按棋子行为能走）但走后送将/将帅照面 → 4003；其余 → 4002
    const pseudo = pieceMoves(mBoard, fr, fc, g.hidden, g.flipMode).some(
      ([r, c]) => r === tr && c === tc
    )
    return pseudo
      ? { error: 4003, msg: '送将 / 将帅照面' }
      : { error: 4002, msg: '非法走法' }
  }

  // 快照（悔棋用）
  g.history.push({
    board: g.board.map((r) => r.slice()),
    hidden: g.hidden.map((r) => r.slice()),
    turn: g.turn,
    clocks: { ...g.clocks },
    stepRemain: g.stepRemain,
    turnStartedAt: g.turnStartedAt,
    moveCount: g.moveCount,
    lastMove: g.lastMove ? { from: g.lastMove.from.slice(), to: g.lastMove.to.slice() } : null,
    tray: { red: g.tray.red.map((e) => ({ ...e })), black: g.tray.black.map((e) => ({ ...e })) },
  })

  // 吃子（在翻开/移动前取目标信息）
  const targetCh = g.board[tr][tc]
  const targetHidden = !!targetCh && !!g.hidden[tr][tc]
  let captured = null
  if (targetCh) {
    const entry = {
      t: targetCh.toUpperCase(),
      color: isRed(targetCh) ? 'red' : 'black',
      wasHidden: targetHidden,
    }
    g.tray[color].push(entry)
    // 被吃暗子的真身只随走子方响应返回，绝不广播
    if (targetHidden) captured = { t: entry.t, color: entry.color, revealed: true }
  }

  // 执行走子
  g.board = applyMove(g.board, fr, fc, tr, tc)
  // 暗子第一次被移动即翻开：起点清空、落点为明子（同时覆盖被吃暗子的盖子标记）
  g.hidden[fr][fc] = false
  g.hidden[tr][tc] = false

  g.lastMove = { from: [fr, fc], to: [tr, tc] }
  g.moveCount += 1
  g.undoRequest = null
  g.turn = color === 'red' ? 'black' : 'red'
  g.turnStartedAt = Date.now()
  g.stepRemain = g.stepTime // 落子重置步时

  // 落子后切回真实棋盘判定（新增模式 §3.3）：
  // 1) 翻棋送将（random 特有）：翻开的真身若是敌子（当场易主），且在落点直接攻击行棋方
  //    自己的将帅 → 对方下一手即可吃将、行棋方无应对，立即判负，reason=绝杀。
  //    掩码盘落子前发现不了（掩码时它是己方 Q/q）。flip/standard 下翻出的恒为己方子，
  //    且合法走法已过滤送将，此处 isInCheck 必为 false，天然不触发。
  const moverRed = color === 'red'
  if (isInCheck(g.board, moverRed, g.hidden, g.flipMode)) {
    endGame(room, moverRed ? 'black' : 'red', '绝杀')
    return { captured }
  }
  // 2) 正常终局判定（真盘）：行棋方（已切换为对方）无合法着法 → 被将=绝杀、未被将=困毙。
  //    翻开的敌子归对方所有，hasLegalMove 计入对方着法，避免误判困毙。
  const st = engineGameStatus(g.board, g.turn === 'red', g.hidden, g.flipMode)
  if (st.over) {
    endGame(room, st.winner, st.reason === '将死' ? '绝杀' : '困毙')
  }
  return { captured }
}

// 悔棋：回退最后一步（协商一致后调用）
export function applyUndo(room) {
  const g = room.game
  if (!g || g.status !== 'playing' || g.history.length === 0) return false
  const snap = g.history.pop()
  g.board = snap.board
  g.hidden = snap.hidden
  g.turn = snap.turn
  g.clocks = snap.clocks
  g.stepRemain = snap.stepRemain
  g.turnStartedAt = snap.turnStartedAt
  g.moveCount = snap.moveCount
  g.lastMove = snap.lastMove
  g.tray = snap.tray
  g.undoRequest = null
  return true
}

// ---- 视角视图（api.md §3.1 State）----

function pieceView(ch, hidden, r, c, god, randomMode) {
  if (!ch) return null
  const realColor = isRed(ch) ? 'red' : 'black'
  // random 模式：暗子 color 掩码为位置方颜色，真身颜色绝不下发（新增模式 §2.3）
  const color = randomMode && hidden[r][c] ? (r >= 5 ? 'red' : 'black') : realColor
  // 暗子默认只下发 "?"（防作弊看牌）
  // 上帝模式：仅非 random 的上帝视角下暗棋带真实类型（上帝模式实现方案 §2.2）
  if (hidden[r][c]) {
    return god ? { t: ch.toUpperCase(), color, hidden: true } : { t: '?', color, hidden: true }
  }
  return { t: ch.toUpperCase(), color, hidden: false }
}

function playersView(room) {
  // 补充 §1.2：State.players 带 avatarUrl（复用 store.playerView，不带 ready）
  return { red: playerView(room.red), black: playerView(room.black) }
}

export function buildStateView(room, viewerColor, viewerUserId) {
  settle(room)
  const g = room.game
  const randomMode = room.mode === 'random'
  // 上帝模式：random 模式下强制关闭（新增模式 §5）；其余仅上帝本人可见
  const god = !randomMode && isGodUser(viewerUserId)

  // 尚未开局：返回等待态，供轮询降级使用
  if (!g) {
    const waiting = {
      status: room.status,
      mode: room.mode,
      myColor: viewerColor,
      players: playersView(room),
    }
    if (god) waiting.god = true
    return waiting
  }

  const board = g.board.map((row, r) =>
    row.map((ch, c) => pieceView(ch, g.hidden, r, c, god, randomMode))
  )
  // 将军状态按真实棋盘计算（新增模式 §3.3：翻开的子按真身、真实颜色参与攻击；
  // 暗子不攻击在两盘结果一致，这里统一用真盘，与落子后终局判定同源）
  const check =
    g.status === 'playing'
      ? isInCheck(g.board, g.turn === 'red', g.hidden, g.flipMode)
      : false

  // 战利品视角：
  // - random 模式全公开（新增模式 §4）：双方均见真实 t/color
  // - flip 模式：自己吃到的暗子见真身；对方吃到的暗子恒为 "?"
  const trayView = (side) =>
    g.tray[side].map((e) => {
      const showReal = randomMode || side === viewerColor || !e.wasHidden
      return { t: showReal ? e.t : '?', color: e.color, wasHidden: e.wasHidden }
    })

  const view = {
    status: g.status,
    mode: g.mode,
    turn: g.turn,
    myColor: viewerColor,
    board,
    hidden: g.hidden.map((r) => r.slice()),
    lastMove: g.lastMove
      ? { from: g.lastMove.from.slice(), to: g.lastMove.to.slice() }
      : null,
    check,
    clocks: {
      red: Math.max(0, Math.ceil(g.clocks.red)),
      black: Math.max(0, Math.ceil(g.clocks.black)),
    },
    stepRemain: Math.max(0, Math.ceil(g.stepRemain)),
    moveCount: g.moveCount,
    players: playersView(room),
    capturedTray: { red: trayView('red'), black: trayView('black') },
  }
  if (g.status === 'ended') {
    view.winner = g.winner
    view.reason = g.reason
  }
  if (god) view.god = true
  return view
}

// ---- 上帝模式：换身份（上帝模式实现方案 §2.3）----

// 可作为交换目标/来源的类型（将帅 K 除外；A=仕 B=相 N=马 R=车 C=炮 P=兵）
const GOD_SWAP_TYPES = ['A', 'B', 'N', 'R', 'C', 'P']

// 两枚未翻开暗棋交换真身：同色、仍在棋盘、hidden === true，随机配对
// 不改 moveCount/计时/turn，不向对手推送任何消息（对手无感知）
// random 模式下强制关闭（新增模式 §5）
export function godSwap(room, from, toType) {
  const g = room.game
  if (!g || g.status === 'ended') return { error: 4004, msg: '对局已结束' }
  if (room.mode === 'random') return { error: 4000, msg: '该模式不支持' }
  if (!validCoord(from)) return { error: 4000, msg: '参数错误：from 无效' }
  if (!GOD_SWAP_TYPES.includes(toType)) return { error: 4000, msg: '参数错误：toType 无效' }

  const [r, c] = from
  if (!g.hidden[r][c] || !g.board[r][c]) return { error: 4000, msg: '仅未翻开的暗棋可更换' }
  const ch = g.board[r][c]
  if (ch.toUpperCase() === 'K') return { error: 4000, msg: '将帅不可更换' }

  // 候选：同一方、仍在棋盘上、未翻开的暗棋中真身 === toType（排除自身）
  const redPiece = isRed(ch)
  const candidates = []
  for (let tr = 0; tr <= 9; tr++) {
    for (let tc = 0; tc <= 8; tc++) {
      if (tr === r && tc === c) continue
      if (!g.hidden[tr][tc]) continue
      const tch = g.board[tr][tc]
      if (!tch || isRed(tch) !== redPiece || tch.toUpperCase() !== toType) continue
      candidates.push([tr, tc])
    }
  }
  if (!candidates.length) return { error: 4000, msg: '目标类型已无可交换的暗棋' }

  const [tr, tc] = candidates[Math.floor(Math.random() * candidates.length)]
  ;[g.board[r][c], g.board[tr][tc]] = [g.board[tr][tc], g.board[r][c]]
  return { swapped: { from: [r, c], with: [tr, tc] } }
}

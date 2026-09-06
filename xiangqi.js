// 中国象棋规则引擎
// 棋盘: board[row][col]，row 0 为黑方底线（棋盘上方），row 9 为红方底线（棋盘下方）
// 大写 = 红方（K帅 A仕 B相 N马 R车 C炮 P兵），小写 = 黑方（k将 a士 b象 n马 r车 c炮 p卒）
// 红方先行，红方向上走（row 减小）

export const RED = 'red'
export const BLACK = 'black'

export const PIECE_NAMES = {
  K: '帅',
  A: '仕',
  B: '相',
  N: '马',
  R: '车',
  C: '炮',
  P: '兵',
  k: '将',
  a: '士',
  b: '象',
  n: '马',
  r: '车',
  c: '炮',
  p: '卒',
}

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

export function isRed(p) {
  return p !== null && p !== undefined && p === p.toUpperCase()
}

export function colorOf(p) {
  return p ? (isRed(p) ? RED : BLACK) : null
}

// 开局摆法：黑上红下，红方第一排 车马相仕帅仕相马车，炮在二、八路，兵在一、三、五、七、九路
export function createInitialBoard() {
  const board = Array.from({ length: 10 }, () => Array(9).fill(null))
  const back = ['R', 'N', 'B', 'A', 'K', 'A', 'B', 'N', 'R']
  for (let c = 0; c < 9; c++) {
    board[0][c] = back[c].toLowerCase()
    board[9][c] = back[c]
  }
  board[2][1] = 'c'
  board[2][7] = 'c'
  board[7][1] = 'C'
  board[7][7] = 'C'
  for (let c = 0; c < 9; c += 2) {
    board[3][c] = 'p'
    board[6][c] = 'P'
  }
  return board
}

function inPalace(p, r, c) {
  return inPalaceSide(isRed(p), r, c)
}

function inPalaceSide(redSide, r, c) {
  if (c < 3 || c > 5) return false
  return redSide ? r >= 7 && r <= 9 : r >= 0 && r <= 2
}

// 揭棋：位置原始类型（由标准开局摆法决定，上下对称，与颜色无关）
export function standardTypeAt(r, c) {
  if (r === 0 || r === 9) return ['R', 'N', 'B', 'A', 'K', 'A', 'B', 'N', 'R'][c]
  if (r === 2 || r === 7) return c === 1 || c === 7 ? 'C' : null
  if (r === 3 || r === 6) return c % 2 === 0 ? 'P' : null
  return null
}

// 棋子的行为类型：未翻开的暗子按所在位置的原有棋子行为，翻开（或标准模式）按真身
function behaviorType(p, r, c, hidden) {
  if (hidden && hidden[r] && hidden[r][c]) {
    const t = standardTypeAt(r, c)
    if (t) return t
  }
  return p.toUpperCase()
}

// 单子走法（伪合法：不含"走后自将"过滤，不含将帅照面过滤）
// hidden 为可选的 10x9 暗子标记；flipMode = 揭棋模式
// 揭棋：未翻开的暗子按位置行为走子/吃子（受限）；翻开的仕可任意斜走、相可过河
export function pieceMoves(board, r, c, hidden, flipMode) {
  const p = board[r][c]
  if (!p) return []
  const red = isRed(p)
  const moves = []
  const inBoard = (tr, tc) => tr >= 0 && tr <= 9 && tc >= 0 && tc <= 8
  const canPut = (tr, tc) => {
    const t = board[tr][tc]
    return !t || isRed(t) !== red
  }
  // 揭棋下翻开的子（非帅将，帅将开局明置）解除九宫/河界限制
  const free = !!flipMode && !(hidden && hidden[r][c])
  // 暗子行为方向跟"位置所在一方"（全随机模式下暗子颜色可能与位置方不同；
  // flip 模式下颜色恒等于位置方，此改写零影响）。吃子权限仍按真实颜色（red）
  const behavRed = !!(hidden && hidden[r][c]) ? r >= 5 : red

  switch (behaviorType(p, r, c, hidden)) {
    case 'K': {
      // 帅/将：九宫内横竖走一格
      for (const [dr, dc] of DIRS) {
        const tr = r + dr
        const tc = c + dc
        if (inBoard(tr, tc) && inPalace(p, tr, tc) && canPut(tr, tc)) moves.push([tr, tc])
      }
      break
    }
    case 'A': {
      // 士/仕：斜走一格；揭棋翻开后不受九宫限制；暗子九宫跟位置方
      for (const [dr, dc] of [
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ]) {
        const tr = r + dr
        const tc = c + dc
        if (inBoard(tr, tc) && (free || inPalaceSide(behavRed, tr, tc)) && canPut(tr, tc)) moves.push([tr, tc])
      }
      break
    }
    case 'B': {
      // 象/相：田字，塞象眼；揭棋翻开后可过河；暗子河界跟位置方
      for (const [dr, dc] of [
        [2, 2],
        [2, -2],
        [-2, 2],
        [-2, -2],
      ]) {
        const tr = r + dr
        const tc = c + dc
        if (!inBoard(tr, tc)) continue
        if (!free) {
          if (behavRed && tr < 5) continue
          if (!behavRed && tr > 4) continue
        }
        if (board[r + dr / 2][c + dc / 2]) continue
        if (canPut(tr, tc)) moves.push([tr, tc])
      }
      break
    }
    case 'N': {
      // 马：日字，蹩马腿
      const jumps = [
        [-2, -1],
        [-2, 1],
        [2, -1],
        [2, 1],
        [-1, -2],
        [1, -2],
        [-1, 2],
        [1, 2],
      ]
      const legs = [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]
      for (let i = 0; i < 8; i++) {
        const [dr, dc] = jumps[i]
        const tr = r + dr
        const tc = c + dc
        if (!inBoard(tr, tc)) continue
        const [lr, lc] = legs[Math.floor(i / 2)]
        if (board[r + lr][c + lc]) continue
        if (canPut(tr, tc)) moves.push([tr, tc])
      }
      break
    }
    case 'R': {
      // 车：直线任意距离，遇子停（敌可吃）
      for (const [dr, dc] of DIRS) {
        let tr = r + dr
        let tc = c + dc
        while (inBoard(tr, tc)) {
          const t = board[tr][tc]
          if (t) {
            if (isRed(t) !== red) moves.push([tr, tc])
            break
          }
          moves.push([tr, tc])
          tr += dr
          tc += dc
        }
      }
      break
    }
    case 'C': {
      // 炮：走同车，吃子须隔恰好一枚炮架
      for (const [dr, dc] of DIRS) {
        let tr = r + dr
        let tc = c + dc
        let screen = false
        while (inBoard(tr, tc)) {
          const t = board[tr][tc]
          if (!screen) {
            if (t) {
              screen = true
            } else {
              moves.push([tr, tc])
            }
          } else if (t) {
            if (isRed(t) !== red) moves.push([tr, tc])
            break
          }
          tr += dr
          tc += dc
        }
      }
      break
    }
    case 'P': {
      // 兵/卒：向前一格；过河后可横走，不后退；暗子方向跟位置方
      const fwd = behavRed ? -1 : 1
      const tr = r + fwd
      if (inBoard(tr, c) && canPut(tr, c)) moves.push([tr, c])
      const crossed = behavRed ? r <= 4 : r >= 5
      if (crossed) {
        for (const dc of [-1, 1]) {
          const tc = c + dc
          if (inBoard(r, tc) && canPut(r, tc)) moves.push([r, tc])
        }
      }
      break
    }
  }
  return moves
}

export function findKing(board, red) {
  const k = red ? 'K' : 'k'
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) {
      if (board[r][c] === k) return [r, c]
    }
  }
  return null
}

// (r,c) 是否被 byRed 方攻击（将帅照面 = 敌将沿直线攻击，已包含在内）
// hidden 为可选暗子标记：未翻开的暗子不构成攻击（揭棋规则），但仍占位挡线/挡炮架
// flipMode = 揭棋：翻开的士（任意斜走）/象（可过河）也可构成攻击
export function isAttacked(board, r, c, byRed, hidden, flipMode) {
  // 直线：车、将（照面）、炮
  for (const [dr, dc] of DIRS) {
    let tr = r + dr
    let tc = c + dc
    let met = 0
    while (tr >= 0 && tr <= 9 && tc >= 0 && tc <= 8) {
      const t = board[tr][tc]
      if (t) {
        if (isRed(t) === byRed && !(hidden && hidden[tr][tc])) {
          const T = t.toUpperCase()
          if (met === 0 && (T === 'R' || T === 'K')) return true
          if (met === 1 && T === 'C') return true
        }
        met++
        if (met >= 2) break
      }
      tr += dr
      tc += dc
    }
  }
  // 马（含蹩马腿判断）
  const jumps = [
    [-2, -1],
    [-2, 1],
    [2, -1],
    [2, 1],
    [-1, -2],
    [1, -2],
    [-1, 2],
    [1, 2],
  ]
  for (const [dr, dc] of jumps) {
    const nr = r + dr
    const nc = c + dc
    if (nr < 0 || nr > 9 || nc < 0 || nc > 8) continue
    const t = board[nr][nc]
    if (t && isRed(t) === byRed && !(hidden && hidden[nr][nc]) && t.toUpperCase() === 'N') {
      const lr = Math.abs(dr) === 2 ? nr + (dr > 0 ? -1 : 1) : nr
      const lc = Math.abs(dc) === 2 ? nc + (dc > 0 ? -1 : 1) : nc
      if (!board[lr][lc]) return true
    }
  }
  // 兵/卒（过河后可横击）
  if (byRed) {
    if (r + 1 <= 9 && board[r + 1][c] === 'P' && !(hidden && hidden[r + 1][c])) return true
    if (r <= 4) {
      for (const dc of [-1, 1]) {
        const tc = c + dc
        if (tc >= 0 && tc <= 8 && board[r][tc] === 'P' && !(hidden && hidden[r][tc])) return true
      }
    }
  } else {
    if (r - 1 >= 0 && board[r - 1][c] === 'p' && !(hidden && hidden[r - 1][c])) return true
    if (r >= 5) {
      for (const dc of [-1, 1]) {
        const tc = c + dc
        if (tc >= 0 && tc <= 8 && board[r][tc] === 'p' && !(hidden && hidden[r][tc])) return true
      }
    }
  }
  // 揭棋：翻开的士（斜一格，任意位置）/象（田字，可过河，塞象眼）也可构成攻击
  if (flipMode) {
    for (const [dr, dc] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      const nr = r + dr
      const nc = c + dc
      if (nr < 0 || nr > 9 || nc < 0 || nc > 8) continue
      const t = board[nr][nc]
      if (t && isRed(t) === byRed && !(hidden && hidden[nr][nc]) && t.toUpperCase() === 'A') return true
    }
    for (const [dr, dc] of [
      [2, 2],
      [2, -2],
      [-2, 2],
      [-2, -2],
    ]) {
      const nr = r + dr
      const nc = c + dc
      if (nr < 0 || nr > 9 || nc < 0 || nc > 8) continue
      const t = board[nr][nc]
      if (t && isRed(t) === byRed && !(hidden && hidden[nr][nc]) && t.toUpperCase() === 'B') {
        if (!board[r + dr / 2][c + dc / 2]) return true
      }
    }
  }
  return false
}

export function isInCheck(board, red, hidden, flipMode) {
  const pos = findKing(board, red)
  if (!pos) return false
  return isAttacked(board, pos[0], pos[1], !red, hidden, flipMode)
}

// 合法着法 = 伪合法过滤掉"走后己方被将/将帅照面"
export function legalMoves(board, r, c, hidden, flipMode) {
  const p = board[r][c]
  if (!p) return []
  const red = isRed(p)
  return pieceMoves(board, r, c, hidden, flipMode).filter(([tr, tc]) => {
    const captured = board[tr][tc]
    board[tr][tc] = p
    board[r][c] = null
    const bad = isInCheck(board, red, hidden, flipMode)
    board[r][c] = p
    board[tr][tc] = captured
    return !bad
  })
}

export function hasLegalMove(board, red, hidden, flipMode) {
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) {
      const p = board[r][c]
      if (p && isRed(p) === red && legalMoves(board, r, c, hidden, flipMode).length) return true
    }
  }
  return false
}

export function applyMove(board, r, c, tr, tc) {
  const nb = board.map((row) => row.slice())
  nb[tr][tc] = nb[r][c]
  nb[r][c] = null
  return nb
}

// 行棋方无合法着法：被将 = 将死，未被将 = 困毙，均判负
export function gameStatus(board, redToMove, hidden, flipMode) {
  const check = isInCheck(board, redToMove, hidden, flipMode)
  if (!hasLegalMove(board, redToMove, hidden, flipMode)) {
    return {
      over: true,
      winner: redToMove ? BLACK : RED,
      reason: check ? '将死' : '困毙',
    }
  }
  return { over: false, check }
}

// 随机翻棋（揭棋）开局：帅/将明置，其余 15 子（2车2马2炮2相2仕5兵）随机洗牌盖住
// 返回 { board: 真实棋子棋盘, hidden: 10x9 盖子标记 }
export function createFlipGame() {
  const board = createInitialBoard()
  const hidden = Array.from({ length: 10 }, () => Array(9).fill(false))
  for (const red of [true, false]) {
    const backRow = red ? 9 : 0
    const cannonRow = red ? 7 : 2
    const pawnRow = red ? 6 : 3
    const types = ['R', 'R', 'N', 'N', 'B', 'B', 'A', 'A', 'C', 'C', 'P', 'P', 'P', 'P', 'P']
    for (let i = types.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const t = types[i]
      types[i] = types[j]
      types[j] = t
    }
    const squares = []
    for (let c = 0; c < 9; c++) {
      if (c !== 4) squares.push([backRow, c])
    }
    squares.push([cannonRow, 1], [cannonRow, 7])
    for (let c = 0; c < 9; c += 2) {
      squares.push([pawnRow, c])
    }
    squares.forEach(([r, c], idx) => {
      board[r][c] = red ? types[idx] : types[idx].toLowerCase()
      hidden[r][c] = true
    })
  }
  return { board, hidden }
}

// 揭棋全随机开局：帅/将明置，其余 30 枚（红黑各15）合并洗牌，随机盖到全盘暗子位
// 红方底线的暗子可能是黑棋，反之亦然；走法行为跟位置方，吃子权限跟真实颜色
export function createRandomFlipGame() {
  const board = createInitialBoard()
  const hidden = Array.from({ length: 10 }, () => Array(9).fill(false))
  const types = ['R', 'R', 'N', 'N', 'B', 'B', 'A', 'A', 'C', 'C', 'P', 'P', 'P', 'P', 'P']
  const pieces = []
  for (const red of [true, false]) {
    for (const t of types) pieces.push(red ? t : t.toLowerCase())
  }
  for (let i = pieces.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = pieces[i]
    pieces[i] = pieces[j]
    pieces[j] = tmp
  }
  const squares = []
  for (const [backRow, cannonRow, pawnRow] of [
    [0, 2, 3],
    [9, 7, 6],
  ]) {
    for (let c = 0; c < 9; c++) {
      if (c !== 4) squares.push([backRow, c])
    }
    squares.push([cannonRow, 1], [cannonRow, 7])
    for (let c = 0; c < 9; c += 2) {
      squares.push([pawnRow, c])
    }
  }
  squares.forEach(([r, c], idx) => {
    board[r][c] = pieces[idx]
    hidden[r][c] = true
  })
  return { board, hidden }
}

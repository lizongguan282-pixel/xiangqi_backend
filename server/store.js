// 内存存储：用户、房间（MVP 单机内存；后续可换 Redis/DB，接口不变）
import crypto from 'crypto'

export const store = {
  users: new Map(), // userId -> { userId, openid, nickname }
  openidIndex: new Map(), // openid -> userId
  rooms: new Map(), // roomId -> room
  seq: 10000,
}

// 微信登录：code 换 openid 后查找/创建用户；开发模式（未配置 WX_APPID/WX_SECRET）用 code 当 openid
// avatarUrl 可选：小程序端 chooseAvatar 拉到的头像 URL，存用户表并随 Room/State 玩家信息下发
// god：昵称（去空格）精确等于 "炫" → 上帝模式（上帝模式实现方案 §2.1），随昵称更新
export function findOrCreateUser(openid, nickname, avatarUrl) {
  let userId = store.openidIndex.get(openid)
  if (userId) {
    const user = store.users.get(userId)
    if (nickname) {
      user.nickname = nickname
      user.god = nickname.trim() === '炫'
    }
    if (avatarUrl) user.avatarUrl = avatarUrl
    return user
  }
  userId = `u_${++store.seq}`
  const user = {
    userId,
    openid,
    nickname: nickname || `玩家${store.seq}`,
    avatarUrl: avatarUrl || null,
    god: !!nickname && nickname.trim() === '炫',
  }
  store.users.set(userId, user)
  store.openidIndex.set(openid, userId)
  return user
}

// 上帝模式判定（按 userId 查用户记录）
export function isGodUser(userId) {
  const u = userId && store.users.get(userId)
  return !!(u && u.god)
}

export function genRoomId() {
  let roomId
  do {
    roomId = 'R' + crypto.randomBytes(5).toString('hex').toUpperCase().slice(0, 8)
  } while (store.rooms.has(roomId))
  return roomId
}

// 用户在房间中的执子颜色；不在房间返回 null
export function playerColor(room, userId) {
  if (room.red && room.red.userId === userId) return 'red'
  if (room.black && room.black.userId === userId) return 'black'
  return null
}

// 玩家对外结构：userId/nickname/avatarUrl（avatarUrl 实时取自用户表，未设置过为 null）
// withReady=true 时附带 ready 字段（Room.red/black 用；State.players 不带）
export function playerView(p, withReady) {
  if (!p) return null
  const u = store.users.get(p.userId)
  const view = {
    userId: p.userId,
    nickname: p.nickname,
    avatarUrl: (u && u.avatarUrl) || null,
  }
  if (withReady) view.ready = !!p.ready
  return view
}

// 房间对象对外结构（api.md §2 Room + 补充 §1.2 avatarUrl）
export function roomView(room) {
  return {
    roomId: room.roomId,
    mode: room.mode,
    gameTime: room.gameTime,
    stepTime: room.stepTime,
    status: room.status,
    red: playerView(room.red, true),
    black: playerView(room.black, true),
    createTime: room.createTime,
  }
}

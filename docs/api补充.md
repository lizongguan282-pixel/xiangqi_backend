# 后端补充说明 — 接口扩展字段与约定

> 本文档相对 `docs/api.md` 为新增/变更项。后端按此实现后，前端当前代码即可零修改接通。
> **复制整段交给后端即可**。

---

## 一、接口变更（都是兼容扩展，纯加字段，旧代码不依赖的路径不破）

### 1.1 POST `/api/user/login` — 请求体增加可选 `avatarUrl`

**Request（原）：**
```json
{ "code": "...", "nickname": "张三" }
```
**Request（现，兼容旧）：**
```json
{ "code": "...", "nickname": "张三", "avatarUrl": "https://thirdwx.qlogo.cn/.../0" }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| avatarUrl | string | 否 | 小程序端通过 `<button open-type="chooseAvatar">` 拉到的微信头像 URL（也可能是相册选的本地临时文件/任意 CDN 地址） |

**要求**：后端在用户表或会话里把 `avatarUrl` 存起来，后续返回 `red/black` 玩家信息时一并下发。

---

### 1.2 Room / State 的玩家结构 — 增加 `avatarUrl`

`Room.red / Room.black`，以及 `State.players.red / State.players.black` 的结构由：
```json
{ "userId": "u_10001", "nickname": "张三" }
```
改为：
```json
{ "userId": "u_10001", "nickname": "张三", "avatarUrl": "https://..." }
```

| 字段 | 类型 | 说明 |
|---|---|---|
| avatarUrl | string \| null | 没传过头像或空则下发 `null` / 空字符串均可，前端已兜底默认图 |

**影响的接口与推送**：所有返回 `Room` 或 `State` 的地方都要带 avatarUrl，包括：
- `POST /api/room/create`
- `POST /api/room/join`
- `GET  /api/room/:roomId`
- POST `/api/room/ready`（redReady/blackReady 可选，建议不扩）
- `GET  /api/game/:roomId/state`
- WS `room_update`
- WS `game_start`
- WS `move_applied`

---

### 1.3 `GET /api/user/me` — 同样补 `avatarUrl`（建议）

**Response.data**：
```json
{ "userId": "u_10001", "nickname": "张三", "avatarUrl": "..." }
```
前端当前没调用，断线重连时若有需要可直接使用。

---

## 二、枚举值修正：`reason` 规范

**之前文档 §3.3 已定义，但服务端可能有不一致**，此处作为前端消费的权威枚举，**前后端必须统一**：

| reason | 含义 | 前端表现 |
|---|---|---|
| `绝杀` | 将死（checkmate） | 棋盘盖红印章 **"绝杀"** → 停留 3 秒 → 弹胜负弹窗 |
| `困毙` | stalemate | 棋盘盖印章 **"困毙"** → 停留 3 秒 → 弹胜负弹窗 |
| `认输` | resign | 直接宣判 |
| `超时` | clock timeout | 直接宣判 |
| `对手离线` | opponent 离线判负（可选） | 直接宣判（若后端支持） |

**重要**：不要下发 `将死`、`checkmate` 等其他值。若 reason 不是 `绝杀/困毙`，前端会立刻弹胜负弹窗不延时。
`game_over` 推送与 `GET state(status=ended)` 中 winner/reason 字段取值需保持完全一致，避免两条路径不同导致门闩失效。

---

## 三、Websocket 推送约定

以下内容属于**后端确认点**，前端已按这个契约写：

### 3.1 WS 连接
```
wss://gcwtnunyhfap.sealosbja.site/ws?token=<token>
```
- 连接用 URL query 传 token；非法 token → **立即关闭连接**（close code 1008/4001 皆可）
- 已连接过的同一 token 再次调用 `connectSocket` 应允许复用**或**被前端幂等跳过
- 客户端每 30s 发 `{"type":"ping"}`，服务端回复 `{"type":"pong"}` 即可，`pong` 不会派发给业务 handler

### 3.2 推送消息清单（必须全部实现）

| type | 触发时机 | data 结构 |
|---|---|---|
| `room_update` | 对方加入/离开/准备变化 | **完整 Room**（含 avatarUrl） |
| `game_start` | 双方 ready=服务端判定开局 / 再来一局 | **完整 State**（含 myColor、avatarUrl） |
| `move_applied` | 对手走子 | **当前视角 State**（对手视角的 capturedTray 里暗子 `t="?"`） |
| `game_over` | 终局 | `{ winner: "red"\|"black", reason: "绝杀"\|"困毙"\|"认输"\|"超时" }` |
| `undo_request` | 对方请求悔棋 | `{ from: "red"\|"black" }` |
| `undo_result` | 悔棋结果 | 同意：`{ agree:true, state:{ State } }`；拒绝：`{ agree:false }` |
| `opponent_offline` | 对手离线（后端可选，建议宽限 10s 心跳后再发） | `{}` |

### 3.3 `opponent_offline` 防抖要求（解决前端反复弹 Toast）
- 不要一断心跳就发，**至少对对方 socket 累计 10 秒无心跳且 joinRoom 状态下**再发一次
- 重连成功且对方恢复在线，不要补发之前的 `opponent_offline`
- 前端已经做了"收到 3 秒后再拉一次 `GET state` 验证"的兜底，但不要依赖前端兜底

---

## 四、揭棋（flip）规则 — 与前端 `xiangqi.js` 严格对齐

后端做走法校验、揭棋发牌、将军/将死/困毙/超时判负时，必须遵守以下揭棋规则（之前你让我改的那 3 条，全部同步到后端）：

### 4.1 未翻开暗子的行为
- **暗子按它所在位置的**标准开局原始棋子行为走子/吃子（例如车位移的暗子走车）
- **未翻开的暗子不构成攻击**：不算将军、不算将帅照面的攻击方；但占位/挡线/做炮架照常生效

### 4.2 翻开后行为按真实棋子，但以下两项解除限制（仅揭棋模式）
- **翻开的士/仕**：斜走 1 格，但**不再限九宫**（可出宫、可过河）
- **翻开的相/象**：走田字，但**不再限河界**（可过河）
- **塞象眼仍生效**
- 因为仕/相解除限制，它们现在**可以将军**（自由仕斜贴帅、自由相田字遥击都算将军），否则会出现"能走到帅脸上却不算将"的漏洞

### 4.3 揭棋发牌
- 帅/将初始即明置（且永远明置）
- 其余 30 颗暗子**服务端随机洗牌**后下发
- 任何一方视角的暗子永远 `t:"?" hidden:true`，**真身不下发给客户端**（防作弊）
- 玩家首次移动某暗子时，**服务端翻子**（走法必须符合"位置行为"，非法走法直接回 4002）
- 某暗子被吃时：服务端按 `capturedTray` 规则——吃方盘子里见真实 t，对方盘子里 t 恒为 `"?"`（通过 `wasHidden:true` 标志下发），并且只有**吃方响应/推送**中额外带 `captured` 字段告诉吃方该暗子身份，被吃方看不到

### 4.4 发牌/翻子实现建议（直接复用前端 xiangqi.js）
`src/game/xiangqi.js` 是纯 JS 无 UI 依赖，后端如果是 Node.js / Deno 可直接 `import`，其他语言可按同逻辑重写。关键导出：
- `createFlipGame()` → 生成带暗子的初始棋盘
- `pieceMoves(board, r, c, hidden, flipMode)` → 伪合法走法（含揭棋解限）
- `legalMoves(...)` → 过滤送将后的合法着法（校验困毙/将死）
- `isInCheck(board, side, hidden, flipMode)` → 是否被将军
- `gameStatus(board, turn, hidden, flipMode)` → `playing | checkmate-red | checkmate-black | stalemate-red | stalemate-black`

---

## 五、前端当前依赖的全部接口清单（查漏用）

后端按此表逐项勾选，缺一个前端就会报错（全部在 `src/api/index.js` 中封装）：

| 方法 | 路径 | 必须实现 | 备注 |
|---|---|---|---|
| POST | `/api/user/login` | ✅ | code+nickname+avatarUrl，返回 token+userId+nickname+avatarUrl |
| GET  | `/api/user/me` | ⚪ 建议 | 断线重连用 |
| POST | `/api/room/create` | ✅ | 创建者=红；可加 mode/gameTime/stepTime 默认 flip/600/60 |
| POST | `/api/room/join` | ✅ | **幂等**；房间不存在=2001；满=2002；对局中=2003 |
| GET  | `/api/room/:roomId` | ✅ | 查房间状态（含 red/black/ready/avatarUrl） |
| POST | `/api/room/ready` | ✅ | { roomId, ready }；双方 ready=true → **服务端自动发 game_start 推送** |
| POST | `/api/room/leave` | ✅ | 离开房间；对局中离开=认输 |
| GET  | `/api/game/:roomId/state` | ✅ | 轮询同步 / 断线重连主入口 |
| POST | `/api/game/:roomId/move` | ✅ | 回 4001/4002/4003/4004；成功回 State |
| POST | `/api/game/:roomId/resign` | ✅ | 认输，广播 game_over |
| POST | `/api/game/:roomId/undo-request` | ⚪ 可选 | 悔棋请求 |
| POST | `/api/game/:roomId/undo-response` | ⚪ 可选 | 悔棋应答 |
| POST | `/api/game/:roomId/rematch` | ⚪ 建议 | 再来一局，双方请求后自动重发牌并 game_start |
| WS   | `/ws?token=...` | ✅ | 含心跳 + 全部 §3.2 推送 |

---

## 六、验收自测清单（后端自测，全通过前端就不会挂）

- [ ] 登录能收到 token，带不带 avatarUrl 都正常
- [ ] A 创建房间 → B 加入（通过 joinRoom + roomId，或分享链接带 query roomId）都能成功
- [ ] 双方 ready 后，后端应**自动发牌并推送 game_start**（不是等前端开始）
- [ ] A 走一步，B 端 1s 内收到 move_applied（或轮询到 moveCount 增加）且棋盘/暗子视图正确
- [ ] A 制杀 → 后端回 State.status=ended + reason="绝杀" 且 WS 推 game_over winner+reason="绝杀"
- [ ] 困毙 → reason="困毙"；认输 → reason="认输"；超时 → reason="超时"
- [ ] A 离开房间（leaveRoom）→ B 收到 room_update（房间若空可删）
- [ ] 揭棋：A 吃 B 的暗子 → A 端 capturedTray 见真实身份且收到 captured；B 端 capturedTray 中 same piece t="?"
- [ ] 揭棋：暗子走子必须符合位置行为，翻开后才改真身行为；未翻开暗子不会造成将军
- [ ] 揭棋：翻开的仕/相自由活动（可过河出宫，仍算将军）

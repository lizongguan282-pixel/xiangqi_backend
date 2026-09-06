# 中国象棋（随机翻棋/揭棋）小程序 — 后端接口对接文档

> 本文档由前端整理，列出联机对战所需的全部后端接口。
> 前端现状：规则引擎已完成（`src/game/xiangqi.js`，纯 JS），同屏双人可玩；联机只需按本文档实现接口，前端替换数据来源即可。

---

## 0. 总体约定

| 项 | 约定 |
|---|---|
| 建议技术栈 | 任意；**推荐 Node.js**——前端规则引擎是纯 JS，可直接在服务端复用做走法校验/绝杀判定 |
| 通信方式 | REST + WebSocket（实时推送落子）；若无 WebSocket 可用轮询降级（见 §4.3） |
| 鉴权 | 登录后下发 `token`，后续请求带 Header：`Authorization: Bearer <token>` |
| 数据格式 | 请求/响应均为 JSON |
| 统一响应结构 | `{ "code": 0, "msg": "ok", "data": { } }`，`code=0` 成功，非 0 见 §7 错误码 |

**棋子表示约定**（board 中每个交叉点）：

```json
null                                  // 空位
{ "t": "K", "color": "red",  "hidden": false }   // 明子：t ∈ K/A/B/N/R/C/P（帅仕相马车炮兵）
{ "t": "?", "color": "black", "hidden": true  }   // 暗子：揭棋未翻开，t 恒为 "?"
```

- 棋盘为 10 行 × 9 列：`board[0]` 为黑方底线（屏幕上方），`board[9]` 为红方底线（屏幕下方），红方向上走（行号减小）
- **暗子的真实类型服务端绝不下发给任何一方**（发牌在服务端，见 §5）
- 坐标格式统一为 `[row, col]`，如 `[9, 1]`

---

## 1. 用户模块

### 1.1 微信登录

`POST /api/user/login`

请求：
```json
{
  "code": "wx.login() 获取的 code",
  "nickname": "欢迎页用户输入的名字"
}
```

处理逻辑：`code2session` 换取 openid；首次登录创建用户，并更新昵称。

响应 `data`：
```json
{
  "token": "jwt-or-session-token",
  "userId": "u_10001",
  "nickname": "张三"
}
```

### 1.2 获取我的信息（可选，断线重连用）

`GET /api/user/me` → `data: { "userId": "u_10001", "nickname": "张三" }`

---

## 2. 房间模块

房间状态机：`waiting`（等人）→ `ready`（双方准备）→ `playing`（对局中）→ `ended`（已结束）

**房间对象（Room）统一结构**：
```json
{
  "roomId": "R8X2KQ91",
  "mode": "flip",                // flip=揭棋（默认）| standard=标准
  "gameTime": 600,               // 局时（秒），对应房间卡"局时10分"
  "stepTime": 60,                // 步时（秒），对应"步时1分"
  "status": "waiting",
  "red":   { "userId": "u_10001", "nickname": "张三", "ready": true },
  "black": null,                 // null=尚未有对手加入
  "createTime": 1730000000000
}
```

### 2.1 创建房间

`POST /api/room/create`

请求：
```json
{ "mode": "flip", "gameTime": 600, "stepTime": 60 }
```

响应 `data`：上述 Room 结构。**约定：创建者 = 红方（红先）**。

### 2.2 加入房间（邀请链接进入时调用）

`POST /api/room/join`

请求：`{ "roomId": "R8X2KQ91" }`

响应 `data`：加入后的 Room 结构（`black` = 加入者）。
房满/对局中返回错误码 2002 / 2003。

### 2.3 查询房间

`GET /api/room/:roomId` → `data`: Room 结构

### 2.4 准备 / 取消准备

`POST /api/room/ready`

请求：`{ "roomId": "R8X2KQ91", "ready": true }`

响应 `data`：`{ "redReady": true, "blackReady": false }`

> 前端首页「开始」按钮即调此接口；**双方 ready=true 时服务端自动开局**，并向双方推送 `game_start`（§4）。

### 2.5 离开房间

`POST /api/room/leave`，请求：`{ "roomId": "R8X2KQ91" }`

### 2.6 邀请好友（无需接口）

前端用微信分享（`open-type="share"`），分享 path 为：
```
pages/index/index?roomId=R8X2KQ91
```
对方从分享卡片进入后，前端解析 `roomId` 自动调用 2.2 加入。

---

## 3. 对局模块

### 3.1 获取当前局面（进入对局页 / 断线重连）

`GET /api/game/:roomId/state`

响应 `data`（**局面结构 State**，后续多处复用）：
```json
{
  "status": "playing",
  "mode": "flip",
  "turn": "red",                       // 当前该谁走：red | black
  "myColor": "red",                    // 我执哪方
  "board": [
    [{"t":"?","color":"black","hidden":true}, null, ...],
    ...
  ],                                   // 10x9，我视角视图（对方暗子不下发真实类型）
  "hidden": [[false, ...], ...],       // 10x9，我视角下哪些位置是暗子
  "lastMove": { "from": [9,1], "to": [7,1] },
  "check": false,                      // 当前行棋方是否被将军
  "clocks": { "red": 598, "black": 600 },   // 双方剩余局时（秒）
  "stepRemain": 60,                    // 当前行棋方剩余步时（秒）
  "moveCount": 3,                      // 已走步数（每次落子 +1，用于轮询增量判断）
  "players": {
    "red":   { "userId": "u_10001", "nickname": "张三" },
    "black": { "userId": "u_10002", "nickname": "李四" }
  },
  "capturedTray": {
    "red":   [{ "t": "P", "color": "black", "wasHidden": false }],
    "black": [{ "t": "?", "color": "red",  "wasHidden": true }]
  }
}
```

`capturedTray` = 双方各自吃到的子列表（头像旁战利品展示用，同类型由前端堆叠计数）。
**视角约定**：自己吃到的暗子下发真实 `t`；对方吃到的暗子对观看者恒为 `"t":"?"`（明棋被吃则双方都可见真实 `t`）。

### 3.2 走棋

`POST /api/game/:roomId/move`

请求：
```json
{ "from": [9, 1], "to": [7, 1] }
```

服务端校验（见 §5）：轮次、棋子归属、走法合法性、不送将、将帅照面、揭棋翻子。

成功响应 `data`：走子后的**完整 State**（结构同 3.1）。
若此步吃掉暗子，额外返回：`"captured": { "t": "N", "color": "black", "revealed": true }`
**⚠️ captured（被吃暗子的真实身份）只随走子方（吃方）的响应返回，绝不广播给被吃方。**

失败错误码：4001 不该你走 / 4002 非法走法 / 4003 送将（或将帅照面）/ 4004 对局已结束。

### 3.3 认输

`POST /api/game/:roomId/resign`

响应 `data`：`{ "winner": "black", "reason": "认输" }`（reason ∈ 绝杀/困毙/认输/超时），同时广播 `game_over`。

### 3.4 悔棋（协商制，可选实现）

- 请求方：`POST /api/game/:roomId/undo-request` → 对方收到 WS 推送 `undo_request`
- 对方：`POST /api/game/:roomId/undo-response`，请求 `{ "agree": true }`
- 结果双方收到 WS 推送 `undo_result`：`{ "agree": true, "state": { State } }` 或 `{ "agree": false }`

> 若嫌复杂，联机版可去掉悔棋按钮，此组接口标注为可选。

### 3.5 再来一局

`POST /api/game/:roomId/rematch`

双方都请求后，服务端重新发牌、重置计时，状态回 `playing`，向双方推送 `game_start`。

---

## 4. 实时推送（WebSocket）

### 4.1 连接

```
wss://你的域名/ws?token=xxx
```

心跳：客户端每 30 秒发 `{"type":"ping"}`，服务端回 `{"type":"pong"}`。

### 4.2 服务端 → 客户端消息

所有消息均为 JSON，`type` 区分：

```jsonc
// 房间变化：对方加入/离开/准备状态变化（首页监听，驱动 UI）
{ "type": "room_update", "data": { /* Room 结构 */ } }

// 开局（双方就绪 / 再来一局）：data 为完整 State（3.1）
{ "type": "game_start", "data": { /* State */ } }

// 对手落子：建议直接下发完整 State（<2KB，实现最简单、不易出 bug）
// ⚠️ 对手收到的 State 中不含被吃暗子的真实身份（该子已从棋盘移除，身份只给吃方）
{ "type": "move_applied", "data": { /* State */ } }

// 终局
{ "type": "game_over", "data": { "winner": "red", "reason": "绝杀" } }

// 悔棋协商
{ "type": "undo_request", "data": { "from": "red" } }
{ "type": "undo_result",  "data": { "agree": true, "state": { /* State */ } } }

// 对手断线
{ "type": "opponent_offline", "data": {} }
```

`game_over.reason` 取值：`绝杀`（将死）、`困毙`、`认输`、`超时`。

### 4.3 轮询降级（暂不做 WebSocket 时）

对局页每 2 秒 `GET /api/game/:roomId/state`，比较 `moveCount`：
- 增大 → 用返回 State 刷新本地
- `status === "ended"` → 弹终局

---

## 5. 服务端必须承担的职责（重要）

**揭棋行为规则**（前后端/服务端校验必须一致，前端引擎 `xiangqi.js` 已按此实现）：
- 暗子未翻开时，按**所在位置**的标准开局棋子行为走子/吃子（车位走车、马位走马、炮位走炮、兵位走兵、相位走相、仕位走仕），与其真实身份无关，且**保留原棋子的区域限制**
- 暗子**第一次被移动时翻开**，之后按真实身份行棋；帅/将开局明置
- **翻开后解除区域限制**：翻开的仕/士可任意斜走一格（不受九宫限制）；翻开的相/象可过河（田字+塞象眼保留）；翻开的仕/相同样可构成将军
- **未翻开的暗子不参与将军判定**（不构成对将/帅的攻击；但仍占位挡线、挡炮架）
- 暗子被吃时，真实身份**只有吃方可见**，被吃方不知道自己丢了什么子

服务端必须做的：
1. **发牌（揭棋）**：帅/将明置于 (0,4)/(9,4)，其余 15 子（2车2马2炮2相2仕5兵）随机洗牌盖住。
   **随机只发生在服务端**，任何客户端都只拿到 `"t":"?"` 的暗子视图，防止作弊看牌。
2. **走法校验**：轮次 → 棋子归属 → 走法合法（暗子按位置行为）→ 不送将 → 将帅照面。
   前端引擎 `src/game/xiangqi.js` 为纯 JS，可直接复制到服务端使用：
   `pieceMoves / legalMoves / applyMove / isInCheck / gameStatus`（均已支持 hidden 参数），校验逻辑与前端完全一致。
3. **计时权威**：局时 600s / 步时 60s 以服务端为准；每次落子重置步时；任一计时归零 → 判负并广播 `game_over`（reason=超时）。
4. **终局判定**：行棋方无合法着法时——被将=绝杀（将死）、未被将=困毙，均判负；配合认输/超时共 4 种终局。
5. **吃暗子身份保密**：走子翻开的暗子对双方公开（棋盘可见）；但**被吃暗子的真实身份只随吃方的 move 响应返回**（`captured` 字段），对手收到的 `move_applied` 中该子已从棋盘移除、不携带身份。

---

## 6. 前端对接改动点（前后端对照表）

| 前端现有逻辑（本地版） | 对接后改为 |
|---|---|
| 对局页 `onLoad` 本地 `createFlipGame()` 发牌 | 用 `game_start` / `state` 接口下发的 board + hidden |
| 选中棋子本地算 `pieceMoves` 做绿点提示 | 保留本地提示；真正落子改为 `POST move`，以服务端校验结果为准 |
| `doMove` 本地 `applyMove` 改变棋盘 | `POST move` 成功后用返回 State 刷新本地 |
| 走子后本地判将军/绝杀/困毙 | 依据服务端 State 的 `check` 与 `game_over` 推送 |
| `tick()` 本地倒计时 | 显示服务端 `clocks/stepRemain`，本地每秒递减做平滑 |
| 悔棋：本地快照回退 | `undo-request / undo-response` 协商制 |
| 首页「开始」= 本地准备标记 | `POST room/ready` + 监听 `room_update` |
| 首页「邀请好友」 | 分享 path 带 `roomId`，对方进入自动 `join` |

---

## 7. 错误码

| code | 含义 |
|---|---|
| 0 | 成功 |
| 1001 | 未登录 / token 失效 |
| 2001 | 房间不存在 |
| 2002 | 房间已满 |
| 2003 | 对局中不可加入 |
| 4001 | 不该你走棋 |
| 4002 | 非法走法 |
| 4003 | 送将 / 将帅照面 |
| 4004 | 对局已结束 |
| 5000 | 服务器内部错误 |

---

## 8. 最小可用清单（MVP）

若想先跑通联机，后端至少实现这 6 个：

1. `POST /api/user/login`
2. `POST /api/room/create`
3. `POST /api/room/join`
4. `POST /api/room/ready`（含自动开局 + 发牌）
5. `GET /api/game/:roomId/state`（轮询版同步即可）
6. `POST /api/game/:roomId/move`（含服务端校验 + 计时 + 终局判定）

WebSocket / 悔棋 / 再来一局都可以放在第二期。

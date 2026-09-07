# 中国象棋（揭棋/随机翻棋）联机对战后端

微信小程序「中国象棋（随机翻棋/揭棋）」的联机对战后端：Node.js (ESM) + Express + ws (WebSocket)，内存存储，无外部依赖数据库。

> **API 契约唯一权威文档：[前端对接指南.md](./前端对接指南.md)**（随实现持续更新，含全部接口/推送/规则/错误码，可直接给前端）
>
> 部署地址：`https://gcwtnunyhfap.sealosbja.site` ｜ 本地开发：`http://localhost:8080`

---

## 1. 快速上手

```bash
npm install
npm start              # 或 bash entrypoint.sh，监听 0.0.0.0:8080
curl http://localhost:8080/health   # 健康检查 {"code":0,"data":{"status":"up"}}
```

环境变量（均可选，见 `server/index.js` 头部注释）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8080 | HTTP/WS 端口 |
| `WX_APPID` / `WX_SECRET` | 未配置 | 配置后走真实微信 `code2session`；**未配置 = 开发模式**（`openid = "dev_" + code`，code 可传任意字符串） |
| `SERVER_SECRET` | 启动时随机 | token 签名密钥；生产必须固定，否则重启后旧 token 全部失效 |

⚠️ 生产部署务必配置 `WX_APPID/WX_SECRET`。开发模式下若两台设备传了相同 code 会被识别为**同一用户**（B 加入房间时 `black` 永远为 null，永远开不了局——这是已知排查结论，见 §6）。

## 2. 代码结构（全量文件 → 职责）

```
server/
├── index.js          入口：Express 挂载（静态文件 /static → public/，/api 路由，/health）+ 每秒对局超时巡检
├── auth.js           HMAC token 签发/校验 + Bearer 中间件（零依赖）
├── store.js          内存存储：users/rooms、房间号生成、Room/player 视图（含 avatarUrl/god）
├── gameLogic.js      ★核心：发牌(flip/random)、走子校验、掩码盘、计时、终局判定、按视角生成 State、god-swap、悔棋快照
├── ws.js             WebSocket 中心：/ws?token=、ping/pong、按用户推送、对手离线 10s 防抖、emoji 转发
└── routes/
    ├── user.js       登录（含 avatarUrl/god）、/me
    ├── room.js       create/join/query/ready(自动开局)/leave
    └── game.js       state/move/resign/undo-request/undo-response/rematch/god-swap
xiangqi.js            规则引擎（前端同步版，纯 JS，服务端直接复用；含 createFlipGame/createRandomFlipGame）
public/static/        静态文件（bgm.mp3 背景音乐，/static/bgm.mp3 直链）
entrypoint.sh         Devbox 启动脚本
前端对接指南.md        API 契约（权威）
docs/                 历史需求文档归档（均已实现，只读参考）
```

规则引擎 `xiangqi.js` 与前端保持同构，**前端更新引擎后需整体替换此文件**（历史上已同步过：`behavRed` 暗子方向跟位置方、`createRandomFlipGame` 全盘洗牌）。

## 3. 功能实现状态（全部已实现并验证）

| 功能 | 说明 |
|---|---|
| 用户/房间/对局 REST 全套 | 登录(token)、建房/加入/查询/准备(自动开局)/离开、state/move/resign/undo/rematch |
| WebSocket 全套推送 | room_update / game_start / move_applied / game_over / undo_request / undo_result / opponent_offline(10s 防抖) / emoji |
| 揭棋模式 flip | 同色内洗牌；暗子按位置行为；吃暗子真身仅吃方可见（captured + capturedTray 视角裁剪） |
| 揭棋全随机 random | 30 枚跨色全盘洗牌；**掩码盘校验**（暗子=Q/q 占位，归属/吃子/送将按有效阵营=位置方）；暗子 color 掩码为位置方；战利品全公开；**翻棋送将立即判负**（落子后切真盘 isInCheck，reason=绝杀）；上帝模式强制关闭 |
| 标准模式 standard | 全明棋 |
| 上帝模式 | 昵称"炫"（去空格精确匹配）→ State 带 `god:true` + 暗子真身透视；`god-swap` 同色暗棋换真身（守恒、随机配对）；对手零感知；random 模式下关闭 |
| 计时权威 | 局时/步时服务端惰性扣减 + 每秒巡检，归零判负（reason=超时） |
| 静态文件 | `/static/*` → `public/static/*`，7 天缓存，支持 Range（音频拖进度） |
| emoji 局内表情 | 上行 `{type:"emoji",roomId,code}` → 推双方 `{type:"emoji",data:{from,code}}`；code 白名单 e1~e30；房间级 500ms 限频；from 服务端注入 |
| 再来一局 | 双方请求后重发牌 + **双方**推 game_start（moveCount:0）；仅 ended 后接受请求 |

## 4. 核心机制速记（改动前必读）

1. **视角裁剪**：所有下发 State 的地方（HTTP state / game_start / move_applied / undo_result / god-swap 响应）都必须经 `buildStateView(room, color, userId)` 按观看者裁剪——暗子真身、被吃暗子身份、god 字段绝不能泄给对手。新增下发入口时这是第一红线。
2. **掩码盘**（random 模式）：落子**前**合法性/4003 校验跑在掩码盘（暗子→Q/q）；落子**后**将军/终局判定切**真盘**（翻棋送将、将死/困毙、check 字段）。flip/standard 真身恒等位置方，两盘等价。
3. **判定口径**：`legalMoves/isInCheck/gameStatus` 直接调引擎；4001 轮次 / 4002 走法 / 4003 送将照面 / 4004 已结束；reason 枚举只有 `绝杀/困毙/认输/超时`。
4. **WS 推送按 userId**：`sendToUser` 不订阅房间，一个用户多端连接同收。 opponent_offline 有 10s 宽限防抖，重连不补发。
5. **数据全内存**：重启即清空（MVP 定位）。换持久化只需替换 `store.js` 并调整 `gameLogic.js` 里的读写调用。

## 5. 验证方式

无自动化测试框架，历史上用一次性 node 脚本做端到端断言（登录→建房→join→WS 双端收推送→走子→终局）。回归可直接照 [前端对接指南.md §6](./前端对接指南.md) 的 curl 或参考 docs/ 各需求文档的"验收清单"逐项手测。

## 6. 已知问题与注意事项

- **同 code 登录碰撞**（开发模式）：见 §1。线上排查结论：非后端 bug，是两端共享登录态/相同 code 导致同一 userId。
- **部署**：本地改动需重新部署 sealos 才生效（历史上多次出现"线上还是旧版本"的坑）。git 远端：`github.com/lizongguan282-pixel/xiangqi_backend`。
- **小程序域名**：外链音频 `https://gcwtnunyhfap.sealosbja.site/static/bgm.mp3` 需加入小程序 downloadFile 合法域名；表情图片走双端本地 `static/emoji/eN.png`，不涉域名。
- **换 BGM**：直接覆盖 `public/static/bgm.mp3`（同名），无需重启；CDN/客户端缓存可用 `/static/bgm.mp3?v=N` 绕过。

## 7. 文档索引

| 文件 | 性质 | 说明 |
|---|---|---|
| [前端对接指南.md](./前端对接指南.md) | **权威契约** | 全部接口/WS/规则/错误码，随实现更新，给前端用 |
| docs/api.md | 历史需求 | 前端最初整理的接口需求（MVP 清单） |
| docs/api补充.md | 历史需求 | avatarUrl、reason 枚举、离线防抖等补充（已实现） |
| docs/上帝模式实现方案.md | 历史需求 | god 模式设计（已实现） |
| docs/新增模式.md | 历史需求 | random 模式 v1 设计（归属规则以 v2 为准） |
| docs/全随机后端对接文档.md | 历史需求 | random 模式 v2（含翻棋送将，最终实现版） |

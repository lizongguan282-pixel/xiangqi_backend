# Agent 移交工作日志

> 用途：每个 agent 完成一项用户指定任务后追加一条记录，方便后续 agent 接手。
> 格式：任务目标 / 改动文件 / 关键决策 / 验证结果 / 遗留问题
> 维护规则：**只追加，不修改历史条目**；新条目置于末尾。

---

## 2026-09-07 · 任务 #1：新增局内快捷语音 phrase WS 协议

### 任务目标
后端新增局内快捷语音消息类型 `phrase`，协议与 `emoji` 完全同构，零新逻辑。

- 上行：`{ type: "phrase", roomId: "xxx", code: "v3" }`
- 下行：`{ type: "phrase", data: { from: "red", code: "v3" } }`
- 白名单 v1~v8；500ms/条/房间限频；不落库；from 服务端注入。

### 改动文件
- [server/ws.js](./server/ws.js)
  - 新增常量 `PHRASE_CODE_RE`（`^v([1-8])$`）、`PHRASE_MIN_INTERVAL_MS`（500）、`phraseLastAt` Map
  - 在 `ws.on('message')` 派发表中新增 `if (msg.type === 'phrase') handlePhrase(userId, msg)`
  - 新增 `handlePhrase(userId, msg)` 函数，逐行复制自 `handleEmoji`，仅改三处：
    1. 白名单 `EMOJI_CODE_RE` → `PHRASE_CODE_RE`
    2. 限频计数器 `emojiLastAt` → `phraseLastAt`（独立计数，不与 emoji 共享）
    3. 推送 type 字符串 `"emoji"` → `"phrase"`

### 关键决策
1. **限频独立计数**：用户原话"限频保持 ≥500ms/条/房间（和 emoji 同）"语义略含糊。为忠实"复制一份"指令并避免 emoji 与 phrase 互相阻塞，采用**独立 `phraseLastAt` Map**——两者各按 500ms 独立限频。如需共享计数器后续可改一处。
2. **白名单 v1~v8**：用户表述"白名单从 {e1~e8} 改为 {v1~v8}"——其中"e1~e8"与现网 emoji 实际白名单（e1~e30）不符，疑为笔误。phrase 严格按 v1~v8 实现（regex `^v([1-8])$`）。
3. **不修改 `前端对接指南.md`**：用户明确范围"后端需要做的"，前端契约文档不在本任务范围；如需同步前端文档，由下个 agent 接手时单独处理。
4. **不修改 routes / store**：phrase 纯 WS 转发，无 REST 入口、不落库，与 emoji 一致。

### 验证结果
- `node --check server/ws.js` 通过（无语法错误）。
- 未做端到端 WS 测试（无自动化框架）。手动回归建议：
  - 双端登录 → 建房 → join → 开局 → 红方发 `{type:"phrase",roomId,code:"v1"}` → 双方应各收一条 `{type:"phrase",data:{from:"red",code:"v1"}}`
  - 500ms 内连发第二条应被丢弃
  - `code:"v9"` / `code:"e1"` / 空 code 应被丢弃
  - 旁观者连接发 phrase 应被丢弃
  - emoji 通道仍正常工作（不受 phrase 影响）

### 遗留问题
- **前端契约文档未同步**：[前端对接指南.md](./前端对接指南.md) 暂未补 phrase 协议说明。如需给前端用，需在 emoji 章节附近加一段 phrase 描述（参考 emoji 写法）。
- **emoji 白名单差异说明**：README/前端指南若提到 emoji 白名单为 e1~e8，与现网代码 e1~e30 不一致；本任务未触碰 emoji，留待后续核对。
- **限频语义待用户确认**：当前为"独立计数"。若用户实际想要"emoji+phrase 合并限频"（即一条 phrase 也算占用 emoji 的 500ms 配额），需将 `phraseLastAt` 改为复用 `emojiLastAt`（一处改动）。

---

## 2026-09-07 · 任务 #2：phrase 协议前端契约文档归档

### 任务目标
补齐任务 #1 遗留问题"前端契约文档未同步"——在 [前端对接指南.md](./前端对接指南.md) §4.2 emoji 章节后追加 `phrase` 协议章节，供前端直接对接。

### 改动文件
- [前端对接指南.md](./前端对接指南.md)
  - 在 §4.2 emoji 章节末尾、§4.3 轮询降级前，插入 `#### phrase — 局内快捷语音（双向）` 子章节
  - 章节结构完全对齐 emoji：上行示例 / 下行示例 / `data` 字段警示框 / 字段表 / 规则列表
  - 与 [server/ws.js](./server/ws.js) `handlePhrase` 实现一一对应：白名单 v1~v8、500ms 限频独立计数、from 服务端注入、不落库、双方推送

### 关键决策
1. **`data` 字段警示框**：前端任务描述里强调"下行必须套 data 字段，否则前端 ws.on('phrase', h) 拿到 undefined"。此为前端对接高发坑点，单独以 ⚠️ 引用框列出，避免前端踩坑。
2. **不修改 README.md**：README §3 功能表里的 WS 推送清单（`room_update / game_start / ... / emoji`）未列 phrase，属历史遗漏。本任务范围仅为"前端契约归档"，README 高层概览的同步留给后续 agent 或用户单独提需求时处理。
3. **不修改历史条目**：任务 #1 的"遗留问题"段保持原样（"前端契约文档未同步"仍写在任务 #1 下），仅在本条目（任务 #2）说明该遗留已被处理。

### 验证结果
- `grep -n "phrase" 前端对接指南.md` 命中 11 行，章节、字段表、规则均落位
- emoji 章节原文未动（仅在其后追加），不影响既有契约
- 与 ws.js `handlePhrase` 字段口径逐一核对：白名单 `^v([1-8])$` ✓、限频 500ms ✓、`from` 服务端注入 ✓、双方推送 ✓、不落库 ✓

### 遗留问题
- **README §3 功能表未补 phrase 行**：见关键决策 #2，留待后续单独处理。
- **emoji 白名单差异**（任务 #1 遗留 #2）仍开放，未触碰 emoji。

---


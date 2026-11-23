# 生活记录

一个单用户的个人生活面板：每日打卡、阅读与划线、学习计划、COROS 身体数据，以及趋势与相关性分析。
可以装到手机主屏（PWA）、断网也能打卡，数据存在自己的云端库里，按账号做行级隔离。

线上地址：`https://life-board-97391.app.workbuddy.host`（访问必须带 `?sharecode=`）

---

## 为什么是"单文件"

发布站点要求每个静态资源都带 sharecode，不带码的外链 `<script src>` 直接 403。所以所有 JS
必须有构建期**内联进 `index.html`**，图标与 manifest 也在运行时按带码的 URL 生成。
这不是偷懒，是这个部署环境的硬约束 —— 想改成多文件加载，先解决 sharecode 的传递问题。

代价是每次导航都要传约 250 KB（服务端不压缩）。为此 service worker 采用**缓存优先 + 后台更新**：
首屏用缓存秒开，新版本由 SW 在 activate 时通知一次，页面提示"下拉刷新即可应用"。

## 目录

```
index.src.html      源壳：内联 CSS + 5 个 <script src> 占位（改样式/结构从这里改）
app.js              全部业务：状态机、数据层、五个视图、弹层、动作分发、启动鉴权
coros.js            COROS 接入：OAuth2 + PKCE、MCP JSON-RPC 客户端、官方文本报告解析
weread.js           微信读书：划线文本解析、书架 API 宽松解析
config.js           公开配置（endpoint / publishableKey / COROS 应用信息）
wbcloud.js          WorkBuddy Cloud SDK（第三方压缩产物，不参与二次压缩）
build.py            构建 + 发布前检查
db/schema.sql       建表与唯一约束
db/policies.sql     RLS 策略（只授予 authenticated）
tests/              四个校验/探测脚本 + 一键脚本 ci.sh
archive/            早期 demo，不参与构建
index.html          ← 构建产物，入库，由 build.py 生成
sw.js               ← 构建产物（版本戳注入）
manifest.webmanifest← 构建产物
```

## 快速开始

依赖（只需构建期）：**Node 18+**（跑 terser）、**Python 3.10+**、**Chrome / Edge / Chromium**（跑回归）。

```bash
npm install               # 装上锁定的 terser 5.51.2，之后可离线构建
python3 build.py          # 生成 index.html / sw.js / manifest.webmanifest
python3 build.py --check  # 只检查不写文件
```

> Windows 上如果只有 `python` 没有 `python3`，把命令里的 `python3` 换成 `python` 即可；
> `tests/ci.sh` 会自己按 `PYTHON` → `python3` → `python` 的顺序探测。

`build.py` 会做这些事：把 5 个 JS 按 `wbcloud → config → coros → weread → app` 顺序内联、
自有代码用 terser 压缩（第三方 SDK 保持原样）、把 192/512 图标改成运行时带码 URL、
算出内容 SHA256 前 10 位作为版本戳（同时写进 `sw.js` 的缓存名）。

**压缩失败会直接让构建失败**，不会静默回退未压缩产物 —— 否则体积和缓存版本号都会漂移。

### 本地预览

```bash
python3 -m http.server 8000
```

- 调试请打开 `http://localhost:8000/index.src.html`：源壳不压缩、不断行，断点友好。
- 想看发布形态再开 `http://localhost:8000/index.html`。
- SW 只在 https 下注册，本地 http 打开时没有 PWA 缓存，属预期行为。

### 换环境时要改的三处

1. `config.js` → `cloud.endpoint` / `cloud.publishableKey`
2. `config.js` → `coros.redirectUri`（必须是发布后的真实地址，OAuth 回调要回到它）
3. 数据库：按顺序执行 `db/schema.sql`、`db/policies.sql`

### 发布

产物已经在仓库里，所以发布不需要构建步骤，但**发布前要先确认产物与源码一致**：

```bash
python3 build.py --check     # 报"与源码不一致"就先 python3 build.py，再连同产物一起提交
```

把仓库根目录作为静态站点发布即可（WorkBuddy 的「发布为应用」）。发布后地址形如
`https://<app-id>.app.workbuddy.host`，首次打开必须带分享码，页面会把它存进本机并在后续导航里一直带上。

三条硬约束，都是踩过的：

1. **只能在首次发布的那台机器 / 那个会话里发布。** 发布目标由"本地目录 → app"的绑定记录决定，
   这份记录跟着机器走（`.<appId>.genie`、`.workbuddy/applications.yaml`）。换一台机器发布会
   **新建一个 app**，域名从 `life-board-97391` 变成别的，而云端按 Origin 精确校验：

   ```
   Origin: <新域名> → 403 access_denied / the request origin is not allowed for this client
   Origin: <旧域名> → 200
   ```

   新域名既读不到旧库、也登录不了（`redirectUri` 还写死指向旧域名），COROS 授权同样会断。
   换句话说，**换机器发布 = 换一套空数据和一套新链接**，不是"更新线上"。
2. **发布前把 `tests/.probe_state.json` 移出目录。** 发布是把整个目录上传，这个文件里是
   access/refresh token，会随静态站点变成公网可读。
3. **发布后自检**：拉一次首页确认构建号是本次的，再用旧 Origin 探一次数据接口确认返回 200。

## 数据库

9 张表，每张都有 `owner_id text not null default auth.uid()`，RLS 一律
`for all to authenticated using (owner_id = auth.uid())`。**未登录请求必须被拒绝** —— 这条
断言由 `tests/anon_probe.py` 对线上逐表发一次注定失败的 INSERT 来固化。

| 表 | 用途 | 关键约束 |
|---|---|---|
| `habits` | 打卡项（软归档 `archived` + `archived_at`） | — |
| `checkins` | 每日打卡 | unique(owner, habit, day) |
| `health_daily` | 睡眠总量/深睡/REM/浅睡、HRV、静息心率、压力、训练负荷、步数 | unique(owner, day) |
| `activities` | 运动记录 | unique(owner, external_id) |
| `books` | 书架 | unique(owner, external_id)、unique(owner, lower(title))、status/progress CHECK |
| `notes` | 书籍划线 | unique(owner, book, md5(content)) |
| `study_plans` | 学习计划 | — |
| `study_logs` | 学习打卡 | unique(owner, plan, day) |
| `app_kv` | 令牌与配置（COROS 令牌、微信读书 Key、同步诊断） | unique(owner, k) |

约定：`id` 是 `generated always as identity`，导入备份时不要带 id；删除一律软删
（`deleted_at` / `archived`），历史完成率才不会被删项改写。

改完 DDL 跑一次 `python3 tests/schema_check.py`：它会校验 schema 是否覆盖 `app.js` 实际访问的
每张表、每张表是否只有 authenticated 策略、关键唯一索引是否齐全。

## 测试

```bash
sh tests/ci.sh          # 五步串行，任一步跳过都算失败
```

1. `build.py` — 构建
2. `build.py --check` — 产物是否最新、有无外链、JS 语法、340 KB 体积预算、SW 是否注册
3. `tests/schema_check.py` — schema 与代码一致性、RLS 策略、唯一索引
4. `tests/regression.py` — 169 条断言，走真实 DOM 点击
5. `tests/anon_probe.py` — 线上匿名写入探测（退出码 2 = 网络不可达 = 本次没校验，按失败处理）

回归测试的原理：把 `index.html` 复制一份，在 `app.js` 之前注入一个内存版云 SDK mock，
用 headless Chrome 打开，跑完把结果写进 `<pre id="test-out">`，再从 `--dump-dom` 里读回来。
覆盖打卡/删除/撤销、软删除恢复、离线只读拦截、账号隔离、备份导入导出、图表与 CSS 变量、
无障碍（焦点管理、aria、`prefers-reduced-motion`）、COROS 文本解析与自动同步节流等。

**跨平台**：浏览器自动探测（`LB_BROWSER` / `CHROME_PATH` → 平台常见路径 → PATH 里的
`google-chrome` / `chromium` / `microsoft-edge`），Chrome、Chromium、Edge 都能跑。

```bash
LB_BROWSER="/path/to/chrome" python3 tests/regression.py
```

### 写入探测（需要登录，不在 ci.sh 里）

`tests/anon_probe.py` 证明"未登录写不进去"，`tests/write_probe.py` 证明"登录后写得进去"。
后者需要真会话，所以不串进 CI，改完数据层或 RLS 后手动跑一次：

```bash
python3 tests/write_probe.py --email you@example.com   # 发验证码到邮箱
python3 tests/write_probe.py --code 123456             # 换会话，然后跑 9 张表
python3 tests/write_probe.py                           # 复用会话（约 2 小时有效）
python3 tests/write_probe.py --keep                    # 保留探针数据，到界面上肉眼确认
```

每张表走一遍 INSERT → SELECT 回读 → PATCH → DELETE，共 37 项检查，并校验 `owner_id`
不是 `anon`、9 张表是同一个 owner、且等于 JWT 的 `sub`。数据用 `__WRITE_PROBE__` 前缀和
`2001-01-01` 这种不可能撞车的值，跑完自动清理。会话只落在 `tests/.probe_state.json`（已 gitignore）。

两个会让脚本"看起来在跑、其实没验证"的网关行为，改脚本时别踩：

1. **必须带 `Origin` 头。** 同一个 Bearer 令牌，不带 `Origin` 是 401
   `the session is invalid, expired or issued for another client`，带上就是 200。
   浏览器里天然有这一头，脚本里要自己补，否则会把"令牌有效"误判成"登录失效"。
2. **过滤条件要用 `column=op.value`，不能用 PostgREST 标准的 `column.op.value`。**
   写成 `name.eq.__WRITE_PROBE__` 会被**静默忽略并返回全表**——不报错，只是过滤没生效，
   于是"残留为 0"之类的结论会全部失真。

## 设计约定（都是踩过坑之后的结论）

1. **每次写入都要能验证。** 请求没带用户 JWT 时，云端会以 `owner_id='anon'` 把 INSERT
   "成功"写进去，前端拿到 data 就以为保存成功，随后 SELECT 却被 RLS 过滤 —— 用户看到的就是
   "已添加，刷新就没了"。现在每条 insert 都校验返回行的 owner，新建打卡项还会写后回读一次。
2. **会话要能挺过 iOS 的存储回收。** SDK 会话在 localStorage，长期不用会被清掉，代价是重收
   验证码。所以镜像一份到 400 天第一方 cookie，本地被清时用它复原再交给 SDK 续期；凭证被
   服务端明确拒绝（`invalid_grant`）时主动清 cookie，避免每次启动都白试一次。
3. **离线只放行打卡。** 打卡是户外/地铁里最常做的动作，用「目标状态」入队（true/false 幂等），
   联网后按序回放，失败即停。其余写操作一律明确提示只读，不静默拦掉。
4. **重复同步不能炸。** `day` 是 date 列，经 SDK 返回 ISO 串（`2026-11-08T00:00:00Z`），
   `.eq('day','2026-11-08')` 查不到已有行，重复同步就会撞唯一键。改为先查内存 id、再按范围查、
   撞 23505 再转 UPDATE，单日失败也不阻断整轮。
5. **历史不能被改写的动作污染。** 习惯删除是归档，用 `created_at` / `archived_at` 还原"当天
   实际存在的习惯"，所以删打卡项不会改写历史完成率、热力图和相关性的分母。
6. **版本戳覆盖构建逻辑本身。** 缓存名取自源码 + SW 模板 + `build.py` 的哈希，改了构建脚本
   也必然换缓存；否则线上会继续用旧壳。
7. **UI 只分两层材质。** 液态玻璃只给导航/控制层，内容层用系统材料（按 iOS HIG 的分层），
   圆角只留 14 / 10 两级。玻璃可整体关掉（`data-glass="off"`）。

## 数据接入

**COROS**（身体数据）：OAuth2 + PKCE 直连官方 MCP（`/connect/register` → `/oauth2/authorize` →
`/mcp` JSON-RPC）。只读工具白名单在 `coros.js` 的 `READ_TOOLS`；官方目前返回的是**可读文本
报告**而不是 JSON，所以每种指标都有对应的宽松解析器，字段与单位错配会被区间校验拦下并记进
同步诊断（`app_kv.coros_last_run`），不会把 `45 分钟` 塞进睡眠时长。

**微信读书**：网关对浏览器有 CORS 限制（只放行 `weread.qq.com`），所以前端直连那条路实际用
不了，主力是**粘贴划线文本**解析成 书名/作者/章节/划线。`fetchShelf` 保留给将来放开直连时用。

## 已知边界

- **单用户**：没有共享、协作、多角色概念，所有表都按 `owner_id` 隔离。
- **加载上限**：`books` 1000、`notes` 3000、`activities` 200（近 400 天）、`checkins` 6000
  （分页取全）。触顶会在界面上明确提示，不做静默截断；完整数据仍可全量导出 JSON。
- **`index.html` 是产物**：改完源码必须重跑 `python3 build.py`，否则 `--check` 会报"与源码不一致"。
- **构建依赖 pin 死**：terser 版本锁定在 `package.json`，升级需同步复查产物体积（340 KB 预算）。

## 提交约定

中文单行标题，说清"改了什么 + 为什么"，例如：
`修复每日 COROS 同步静默跳过：等令牌加载完再判连接、0 天不锁当天、加看门狗`。
一次提交只做一件事，构建产物与源码同批提交，保证 `--check` 永远是绿的。

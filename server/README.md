# 本机数据服务

1.17.0 通过 `server/next-item.mjs` 提供独立的 `nextItem` 模型，原 `plan` 和主窗口构筑保持原算法。模型携带局次、epoch、修订、英雄、已选顺序、路线和生成时间，原生端再次核对上下文与新鲜度。OCR 候选不参与已选条件。实时队伍成员新增可选 `performance`，仅保留经过范围校验的 kills/deaths/assists/creepScore；加载阵容不提供该字段。

1.17.3 在共享 session 中保存可选 `purchaseTarget:{championId,itemId}`。只在有效实时 `ready` 模型上提交目标；加载预览不提交，新局边界清理，同局重启恢复。纯策略使用最新背包中的完整目标 ID 或实际持有升级的配方祖先作为完成证明；组件和金币不作为完成证明。目标的统计和机制理由仍随最新资料重新计算，不缓存旧推荐。失联、资料过期保留意图但不发布陈旧推荐；硬不兼容或没有可合成槽位时等待，不默默改为下一件。完成证明可在参考来源暂缺时释放旧目标，恢复来源后重新选择。

1.17.4 使用 `dist/item-acquisition.js` 共享任务奖励、前置成装和有效背包观察规则。`questPlans` 仅来自已确认任务；状态区分未观察、缺少前置、等待奖励和实际已获得。任务需求可以在普通 ARAM/Rift 顺序缺失时提供明确配方建议，标注为任务条件而非实测顺序；存在顺序时仍参与前置选择。此前已提交的普通购买目标完成后才开始新任务路线。奖励 ID、包括金铲铲的目录别名，不作为购买目标；同一规则用于主窗口及侧栏，旧保存中错误的奖励目标会被拒绝恢复。

`reference-build-orders.mjs` 校验 OP.GG 核心三件套顺序，`orderKind` 固定为 `core-item-sequence`，样本至少 200。ARAM 无足够顺序时获取独立的 Rift `orderFallback`，完整校验后由 repository 作为 `summonersRift` 暴露，保留原 ARAM 单件统计。旧缓存通过 `ordersContractVersion` 补取一次并沿用错误退避。合法缺失顺序不循环重取；无可核验顺序时下一件模型明确等待。不是鞋子、小件或完整购买时间线。

1.16.1 支持死亡期间的候选 OCR：死亡与对应复活共享运行时 `offerCycle`，各自使用新采集生命周期。候选元数据校验使用独立的硬边界，不受死亡期间点击观察器的等待轮询影响；死亡候选可以显示/保留锚点；点击需恢复后的资格，已选面板则独立核对新鲜当前对局与新的三帧结果证据，死亡或生命未知本身不阻止核对。`ocr-schedule.json` 的固定 trigger 允许 `death`，不保存新增身份或图像。

1.15.0 将候选目录与短时确认凭据分开。`pendingOffers` 返回最多六轮未确认候选，`offers` 是最新一轮；死亡、暂停和临时失联保留候选。`POST /api/session/confirm` 可携带 `pendingId` 精确确认旧轮；`POST /api/session/reset` 以 `{gameId,revision}` 明确清空本局，即使已选列表本来为空。待确认面板恢复时使用新凭据和新帧，旧采集时间不伪装为新点击证据。更多见[待确认保留记录](../docs/reviews/2026-10-26-pending-offers.md)。

`node server/main.mjs --port 0 --data-dir <可选本地目录>` 仅监听 `127.0.0.1`，stdout 第一行是 `{port,token}`。父进程通过 URL fragment 将 token 交给页面。token 仅驻留内存，不能放到查询参数、日志或仓库。关闭桌面窗口时由父进程结束服务。

`GET /api/health` 和 `GET /api/live` 需要 `X-Hexguide-Session` 请求头。仅接受精确的本机 Host 和同源 Origin；不提供跨域访问或公开监听。静态文件仅来自 `dist/`，不能越界读取或读取隐藏文件。

`GET /api/recognition` 使用相同认证，仅返回识别上下文、候选证据与生命周期守卫，不计算完整推荐。原生端在有效观察期间目标每 150 毫秒读取，其他阶段 400 毫秒；完整 `/api/sidebar` 仍按原节奏更新。轻量响应保留原接口 `updatedAt` 给生命状态备用采集使用，以 `recognitionAt` 限制传输时效；过期响应不能续期原生内存证据。临时 OCR 空白与硬失效使用不同水位，允许同轮已松开的点击完成证明。完整推荐失败返回有限错误，不终止健康的识别来源。

`POST /api/ocr` 同样需要会话 token，且只接受空 body 或 `{}`，最多 4096 字节。1.13.0 通过按需启动的本地工作进程复用 `native/scan-augments.ps1` 的 Windows OCR 初始化，每个任务 15 秒超时、标准输出和错误流分别上限 1 MiB，一次只运行一个扫描。先执行三列彩色标题识别，完整标题和图像锚点通过既有匹配器后可提前结束；否则继续对比增强和全画面回退。阶段结果不直接发布，最终前台校验与局次、轮次及采集资格守卫仍适用。进程故障后清理自有子进程，只在下一次请求重建，不自动重扫旧帧。详见[识别工作进程](../docs/ocr-performance.md)。

后台自动识别默认开启，仅对局期间尝试读取前台游戏窗口；开局、可信死亡或未完成轮次的可信复活启动扫描窗口，前一分钟目标 500 毫秒，未确认选择则继续每 5 秒，具体参数见[扫描调度](../docs/ocr-scheduling.md)；手动与后台扫描共用同一次在途请求。`POST /api/sidebar/ocr` 仅接受 `{enabled:boolean}`，暂停偏好独立保存在 `recognition.json` 并在重启时恢复。完整三个候选只进入本轮比较；实际选择必须经过手动确认或六格面板证明的统一确认边界才能更新已选列表。截图不会保留或上传。识别错误、过期或跨局结果不能写入已选海克斯。

本程序只读 Riot 的本机接口：Live Client API (`https://127.0.0.1:2999/liveclientdata/allgamedata`) 和 League Client 的游戏阶段、游戏会话及选人会话。Live Client API 用随附的 Riot 官方根证书验证 TLS。LCU 的自签证书例外仅限从本机 lockfile 取得端口的 `127.0.0.1` HTTPS 连接，使用其临时 Basic 凭据；它不影响系统、外网或 Live Client API 的证书校验。lockfile 内容及玩家身份信息不返回给页面，不写入文件。

LCU 默认查找常见安装目录和正在运行的 `LeagueClient` / `LeagueClientUx` 路径；也可用 `HEXGUIDE_LEAGUE_DIR` 指定安装目录。当前版本面向 Windows。

通过 activePlayer 的 Riot ID 或唯一的精确 summonerName 匹配本人，提取自身英雄、等级、属性、装备、金币和游戏时间。`teams` 仅在本人队伍有效、全体成员分组可确认且存在敌方时标为 detected；`allies` 包含本人在内的己方阵容，`enemies` 为对方。成员仅输出本地映射的英雄 ID/名称、接口提供的等级和装备，不输出召唤师姓名、Riot ID、位置、隐藏属性或技能冷却。缺失队伍不猜测，未知英雄明确标记。队列信息来自 LCU：仅队列 2400 被识别为海克斯大乱斗。缺少队列信息时显示模式未知，不以地图或普通 ARAM 推断。对局 ID 只用于区分新一局。

侧栏模型完整透传构筑计划，包括 `buildItems`、`nextAugments` 和 `enemyContext`。敌方观察须属于当前已连接英雄并在有效时间内才参与针对性建议；后续海克斯是机制关注列表，不是对下一轮候选的预测或出现保证。本版真实三选一卡片 OCR 仍待实战验收。

接口没有稳定承诺提供海克斯选择。缺少明确且可核对的 `augments` 字段时返回 `augments.status = unavailable`，不会将普通符文作为海克斯，也不会把“未读到”当成“已选为空”。页面应保留人工确认。

来源与资源：

- Riot 官方接口说明：https://developer.riotgames.com/docs/lol
- Riot 官方根证书：https://static.developer.riotgames.com/docs/lol/riotgames.pem
- 固定英雄映射 16.21.1：https://ddragon.leagueoflegends.com/cdn/16.21.1/data/en_US/champion.json

当前没有正在运行的完整对局时，只能验证等待状态和模拟接口测试；不能据此宣称实战连接已经验证。

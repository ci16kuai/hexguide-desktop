# 数值更新公告维护

1.18.0 增加装备、KIWI 海克斯数值公告。此模块不更新推荐规则，不进行机制或出装分析。已有三天统计更新独立运行。

## 数据与公告

维护程序从 Riot Data Dragon 的正式资源版本列表发现版本，比较标注适用于嚎哭深渊的装备属性、价格及可准确对应的描述数值。海克斯只读取 KIWI 名单，按稳定标识比较 RootSpell、该强化子法术的 DataValues，以及 mSpellCalculations 中明确的常量、系数和等级起止数值。计算结构、属性枚举或分段位置变化时不把不同计算项直接配对，记录到维护结果中的 warnings。缺省值不猜成零；新增、移除、纯文案变化不伪装成旧值到新值的数值变化。公开静态资料不能保证覆盖服务器未公布的热修。

OpenAI 只将每个数值字段整理成中文属性名称；原始数字、显示比例、来源和稳定 ID 由程序固定。模型输出必须覆盖全部字段，失败或校验不通过时保留上次有效公告。当前云端通过已保存的 OpenAI Agent 运行；每次检查都会创建可查看的会话，无数值变化时生成简短回执，也会有少量 Token 用量。首次运行对比最近两个不同补丁的正式资源；以后比较上次有效快照和最新资源，同版本内容变化也会检查。

资源版本如 16.21.1 单独展示，不冒充游戏官方公告的 26.21 标签。

### 官网日期、图标和英雄技能

公告列表与详情显示官网公布的文章日期，顶部“上次检查”继续显示本机检查时间，两者独立。资源 16.21 优先读取国服官网对应文章的发布元数据（2026-10-21），并链接原文；其他补丁读取 Riot 官网匹配版本页面的结构化 `datePublished`。按来源的日期字符串显示，不随用户时区跨日。来源不可用时显示“官网公告日期待确认”，后续检查补齐，不使用生成时间代替官网日期。

历史文章及索引仍保持不可变。额外的 `announcements/presentation.json` 以文章 ID 和 SHA-256 绑定官网日期、原文链接和逐条图标；客户端合并并缓存这些展示资料，不重置已读状态。装备图标取 Data Dragon 的 image.full，海克斯图标取该 KIWI 定义的 AugmentSmallIconPath。链接限于固定资源域名和 PNG 路径；图片加载失败时保留名称及数值。

兼容索引 `index.json` 继续仅包含装备与海克斯文章，旧版 App 仍能解析并收到这些通知；同次检查的英雄技能变化另生成文章，完整历史写入 `index-v2.json`。新版 App 优先读取完整索引，尚未部署时回退兼容索引，不要求旧版 App 解析新类型条目。数值详情仍放在原目录，按稳定 ID 保存。历史图标资源暂不可用仅记录 warning，不阻塞新数值公告发布。

英雄技能新增 Data Dragon `championFull.json` 对比，绑定英雄 ID、Q/W/E/R 槽和技能 ID，展示对应技能图标及名称。仅比较明确冷却、资源消耗、距离，以及说明直接引用的效果槽；技能替换、等级数量、数组长度或资源类型变化时不直接配对。未解析的被动、伤害与缩放公式不猜值，也不把通用英雄改动描述成大乱斗专属调整。既有检查点首次升级时建立同版本技能基线，以后自动检查变化；不会补造旧公告中的英雄历史。

## 手动运行

```powershell
node tools/version-maintenance/run-agent.mjs `
  --state-dir 'H:\Chatgpt\work\hexguide-announcements\state' `
  --feed-dir 'H:\Chatgpt\work\hexguide-announcements\publisher\announcements' `
  --env-file 'H:\Chatgpt\API key\.env'

node tools/version-maintenance/validate-feed.mjs 'H:\Chatgpt\work\hexguide-announcements\publisher\announcements'
```

Agent 初始模型为 `gpt-6-luna`，可在 OpenAI Platform 的 Agent Setup 中管理后续会话的模型和指令。使用 Agents CLI 前需 Node.js 22+，并在 `tools/version-maintenance` 目录执行 `npm ci --ignore-scripts` 安装固定 SDK。本机手动运行从维护者电脑的外部 env 文件读取 key；云端从 GitHub Actions 加密 Secret 映射为 `OPENAI_API_KEY`。不能将明文 key 放入项目的 dist/server/docs、公告 Git 仓库、日志或安装包。程序仅支持读取环境变量或指定文件中的 OPENAI_API_KEY 字面值，不执行 env 文件内容。旧的 `run.mjs` 保留为传统 Responses API 手动工具，不会创建 Agents 会话。

公开文件为 `announcements/index.json` 和按稳定 ID 命名的不可变详情 JSON。索引记录详情 SHA-256，旧公告保留。发布前验证全部条目、来源协议、数值及摘要一致性；客户端使用固定 HTTPS 来源，哈希用于完整性检查，不替代来源身份。

## 自动发布

公共地址：`https://raw.githubusercontent.com/ci16kuai/hexguide-desktop/codex/announcements-feed/announcements/index.json`。

2026-10-31 已配置 GitHub Actions 云端维护，每 6 小时运行一次，不依赖维护者电脑开机。凭据、checkpoint、草稿恢复及故障处理见 [云端公告维护](announcement-cloud.md)。云端实际运行验证成功后停用本机同名任务；下列 Windows 注册方法仅作本机维护备用，不应与云端同时启用。

使用独立的 publisher Git 仓库工作目录，分支固定为 `codex/announcements-feed`。先初始化该分支并发布首份已校验公告，再运行：

```powershell
./scripts/register-announcement-task.ps1 `
  -EnvFile 'H:\Chatgpt\API key\.env' `
  -WorkPath '<维护状态和日志目录>' `
  -PublisherDirectory '<独立公告仓库目录>' `
  -NodePath '<已安装 Node.js 20+ 的绝对路径>'
```

Windows 任务名为 `HexGuide-AnnouncementMaintenance`，每 6 小时运行一次。当前维护者需要已登录且电脑开机、可访问数据源/OpenAI/GitHub；任务错过后补跑。使用已有 Git Credential Manager 身份发布，禁止后台交互登录。同一任务不重叠，最长运行 20 分钟。未成功推送的本地公告提交在下次运行继续推送，不重新生成同一公告。

`last-publish.log` 记录最新发布过程；`state/last-run.json` 记录比较范围、未知项及实际模型用量，不记录凭据。失败保留有效快照和公告；运行中断留下的锁在一小时后允许恢复。更换维护电脑时需迁移有效快照、拉取公告分支并重新配置凭据与任务。

## 客户端

App 启动及运行期间每小时检查公共索引；桌面版右上角“更多 → 更新公告”中可查看历史、手动检查，普通浏览器顶部保留“更新公告”按钮。主窗口显示未读数量及提示，查看详情后才标为已读；旧回答或失败下载不改变未读状态。已读记录、索引和已查看详情保存到应用数据目录的 announcements-v1，断网仍可查看已缓存详情。安装包附带最近一份已验证公告作为离线初始内容。

客户端仅发送固定公共文件路径，不发送游戏状态、玩家信息或 API key。旧版本 App 需要先升级到 1.18.0，才能出现公告入口。维护程序和 Windows 定时任务不随玩家安装包分发。

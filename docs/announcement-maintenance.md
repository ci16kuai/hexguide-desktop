# 官网更新公告维护

1.18.1 以英雄联盟国服官网公告及其后续不停机更新为准，取代只根据静态资源猜测版本公告的生产流程。此模块不更新推荐规则，不分析强弱、出装或推荐影响；三天统计更新继续独立运行。

## 采集与范围

`run-agent.mjs` 的生产入口为 `runOfficialMaintenance`。通过 Data Dragon 的版本列表确定资源版本，从国服官网公告列表定位版本公告，并检查同补丁发布后的不停机更新。已发现的热修 URL 保存在 checkpoint 中，即使随后离开列表第一页也会继续检查。官网不可用、结构无法识别或已发布内容无解释地消失时令任务失败，不把它记成“没有变化”。

使用 parse5 解析正文，整个经典模式章节在进入 Agent 前排除。收录通用、海克斯大乱斗、斗魂竞技场的英雄、装备、海克斯与相关修复，并在每项中保留模式，不跨模式合并数值。英雄包含基础属性、被动、Q/W/E/R、非数值机制变化和 BUG 修复。装备不再按 Data Dragon 地图标志过滤。复杂公式、近战/远程分支、无限时长以及其他事实保留官网文字，不从占位零值推测。

英雄画像使用按英雄 ID 绑定的 Data Dragon 头像；技能优先用官网该技能段落的图标，无配图时按已确认的英雄与技能槽取资源。海克斯图标按稳定游戏 ID 对应 CommunityDragon。实体标题无法确认时停止，不沿用上一个英雄。未确认的非实体修复保留原文放在“其他修复”，不硬配图标或标成某个英雄。

OpenAI Agent 每批最多核对 64 项，必须逐项返回全部 acceptedKeys，不得遗漏、重复、虚构 key 或改写事实。合法的非数值变化和复杂公式不会被当成无效数据。没有新公告时仍产生简短会话回执，会有模型用量。模型、指令和运行记录可在 Platform 管理；`gpt-6-luna` 为初始模型。

## 发布、修订与客户端

完整官网索引为 `announcements/index-v3.json`，详情为 schemaVersion 2 的不可变 JSON。旧 `index.json`、`index-v2.json` 及旧文章保留原字节与 SHA，不要求旧客户端解析新类型。客户端必须升级到 1.18.1 才能查看完整官网公告与新增英雄栏。

文章按来源 URL 和事实生成有效修订。同一来源真实回滚也产生新修订；普通未变化检查不重复发公告。独立热修不会替代主版本公告。新版通过 supersedes 将被补全或修订的记录收入折叠历史，原 ID、已读与文件仍保留。官网配图、头像和日期的更正使用绑定文章 ID + SHA 的 presentation.json 覆盖层，保持事实文件不变。

公告显示官网发布日，不按用户时区跨日；“上次检查”独立显示检查时间。英雄按人聚合，80px 头像、40px 技能图标，整组默认展开，可收起基础数值、技能和修复内容。同一装备只显示一次名称与图标。分类入口可跳转到英雄、装备、海克斯或其他修复。

App 启动及每小时检查索引；详情打开后标记已读，历史、已读和展示资料保存在数据目录 announcements-v1。图片需要可访问对应资源，图片失败不隐藏事实文本。没有退出 App 后的操作系统离线推送。

## 维护端运行

使用 Node.js 22+，先在 tools/version-maintenance 执行 npm ci --ignore-scripts；固定依赖包含 OpenAI SDK 7.45.1 和 parse5 8.0.0。维护依赖、凭据和 checkpoint 不进入玩家包。

```powershell
node tools/version-maintenance/run-agent.mjs `
  --state-dir '<公告仓库>/.maintenance' `
  --feed-dir '<公告仓库>/announcements' `
  --env-file '<已授权的外部 env 文件>'
node tools/version-maintenance/validate-feed.mjs '<公告仓库>/announcements'
```

云端从 GitHub Actions Secret HEXGUIDE_OPENAI_API_KEY 读取，维护者本机可用已授权的外部 env 文件。禁止将明文 key 放进源码、dist、日志、公告或安装包。会话/turn ID、GitHub run URL 与可用 Token 保存在 .maintenance/agent-runs。usage 未回填时为 null，不当作零花费。

文章、三个版本索引、presentation 和 .maintenance 必须同一提交推送。完整草稿可在推送失败后复用；checkpoint 必须和完整公告一起恢复。详情见 [云端公告维护](announcement-cloud.md)。

旧 run.mjs、静态资源对比测试和 Windows 本机注册脚本保留作历史诊断，不是当前生产入口。本机 HexGuide-AnnouncementMaintenance 任务保持禁用；不能同时启用旧数值任务和云端官网发布器。

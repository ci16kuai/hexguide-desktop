# 云端官网公告维护

仓库 ci16kuai/hexguide-desktop 的 .github/workflows/announcements.yml 使用 GitHub 托管 runner，每六小时运行一次（UTC 00:37、06:37、12:37、18:37），可手动运行。不依赖维护者电脑，GitHub 调度可能延迟。

## 生产流程

默认分支 codex/desktop-app 保存维护与 App 代码，codex/announcements-feed 保存公开文章、各版本索引、presentation 和 .maintenance checkpoint。生产入口 run-agent.mjs 现在整理国服官网正文及后续不停机热修，完整排除经典模式；静态资源只辅助版本和图标，不用于伪造完整官网公告。

程序按明确章节、实体和技能提取事实。OpenAI 已保存 Agent“海克斯指南 · 英雄、装备与海克斯公告”分批核对范围和条目覆盖，不能改写数字、公式或 GitHub 发布凭据。不存在自动回退到旧静态比较流程。当前官网格式、实体或覆盖不明确时失败并保留已发布内容。

玩家需升级 1.18.1，客户端优先读取 index-v3.json；旧索引与不可变详情文件保留。旧客户端不能显示 schema2 完整官网事实或英雄栏。新客户端按 supersedes 将旧资源记录和已替代修订放进折叠历史，不重置已读。主补丁与后续热修分别存在。

## Platform 和用量

保存的 Agent ID 在 tools/version-maintenance/agent-config.json，不含凭据。通过顶层 agent_id 引用，不覆盖 Platform 模型设置；name/instructions 及模型供后续会话管理。使用环境 none，不另建 sandbox。每批至多 64 项，单会话等待上限 180 秒；没有变化时也会产生会话回执和模型用量。

会话/turn ID、GitHub 任务链接和已知用量保存到 .maintenance/agent-runs 及 last-run.json。usage 未返回时为 null，最终账单以 Platform Usage 为准。Git 推送后对精确 Agent/run 的会话写入 publication_status，失败时取消仍在执行的会话。runner 被强制终止可能阻止收尾，可按记录在 Platform 检查。

## 凭据和恢复

OpenAI key 仅从加密 Secret HEXGUIDE_OPENAI_API_KEY 映射到维护/验证/收尾步骤。Git 使用临时 GITHUB_TOKEN，未另存个人 GitHub token。工作流仅 schedule/workflow_dispatch，不向 PR/fork 提供 key；Actions 固定完整 SHA，维护代码 checkout 不保留 Git 凭据。

每次先执行回归，再采集、审计、验证不可变历史，最后将 announcements 与 .maintenance 在同一提交推送。草稿 draft-*.json 可由 Actions cache 恢复，避免完整生成后推送失败导致重复审计；缓存过期仍可能重新调用。每次保存七天完整 checkpoint artifact。恢复必须同时恢复公告与状态，不能单独恢复已推进的 checkpoint。

同来源 A→B→A 的真实回滚会产生新有效修订；图片或头像纠正只更新绑定文章 SHA 的展示层。已发布来源突然变成零有效内容时失败，不把撤回误记成无变化。新发现的纯经典热修可以跳过，不产生空公告。

勾选 verify_api 时用已验证的真实历史条目测试；schema2 调用 official_audit，旧格式才调用字段翻译，不发布测试公告。首次部署后手动运行并核对官网来源、v3文章、经典排除、会话与推送结果。

本机旧任务 HexGuide-AnnouncementMaintenance 保持禁用。GitHub 公共仓库连续六十天无活动可能暂停调度；正常任务保留检查回执，但仍应以 Actions 状态判断运行情况。API、官网或推送失败会保留现有公告，修复后可重跑。

# 云端公告维护

维护任务位于 `.github/workflows/announcements.yml`，运行于 GitHub 托管的 Ubuntu runner，与维护者电脑及 App 是否开启无关。每 6 小时运行一次（UTC 00:37、06:37、12:37、18:37），也支持在 Actions 中手动运行。GitHub 调度可能延迟，不承诺实时发布。

正式调度使用仓库默认分支 `codex/desktop-app`。只比较公开装备和 KIWI 海克斯的可确认数值；中文整理通过 OpenAI Agents API 的已保存 Agent 完成，数值、来源、差异比较、公告 ID 和发布校验仍由程序固定。

## Platform 管理和用量

打开 [OpenAI Agents](https://platform.openai.com/agents)，选择保存维护 key 的项目，进入“海克斯指南 · 装备与海克斯更新公告”。Setup 中的模型、名称和指令可管理后续会话；已有会话保留创建时的配置。Sessions 可查看每次检查、字段整理的消息、状态和 Token。也可在 [Agents 日志](https://platform.openai.com/logs?api=agents) 中按 session ID 查找，实际费用以 [Usage](https://platform.openai.com/usage) 为准。

身份配置保存在 `tools/version-maintenance/agent-config.json`，其中只有已保存 Agent ID、名称和初始模型，不含 key。云端通过 `agent_id` 引用此定义，不覆盖 Platform 保存的模型和指令。数值公告的结构化输出和工具限制由代码固定；每个请求不超过 64 项，单个会话等待上限 180 秒。依赖为固定的 OpenAI Node SDK 7.45.1，需要 Node.js 22+（云端使用 24），单独安装在维护工具目录，不进入玩家安装包。

每次定时检查都会产生 Agents 会话，包括没有数值变化时的简短检查回执，因此无变化时也有少量模型用量。会话的环境为 `none`，保留 GitHub 的采集、比较及发布程序，不另建付费 sandbox。Agent 不能改写公告的数字，也不能直接操作 GitHub 发布凭据。

会话和 turn ID、GitHub run URL、已知 Token 用量保存在 `.maintenance/agent-runs/` 及最近检查回执。API 的 usage 有时尚未回填，此时保留 null，不当作零用量；最终以 Platform 为准。Git 推送后会更新对应会话的 publication_status；失败或取消时，收尾步骤核验 Agent/run 身份并取消仍在执行的会话。创建响应丢失时可按保存的 Agent ID 和精确 run_id 查找最近会话。硬性终止整个云端 runner 仍可能阻止收尾，届时按 run 记录在 Platform 检查会话。

## 凭据

仓库 Actions Secret 为 `HEXGUIDE_OPENAI_API_KEY`，仅在执行数值维护及手动 API 验证的步骤中映射为 `OPENAI_API_KEY`。不得将 key 放进仓库文件、公告、checkpoint、安装包或日志。发布使用 GitHub 自动生成的 `GITHUB_TOKEN`，无需另存个人 GitHub token。

工作流只接受 schedule 和 workflow_dispatch，不向拉取请求或 fork 提供 API key。Actions 固定到完整 commit SHA，维护代码检出不保留 Git 凭据；公告分支检出使用临时工作流凭据发布。

## 公告、状态与交接

客户端继续读取 `codex/announcements-feed` 分支的 `announcements/index.json` 及不可变详情文件，无需客户端改版。App 1.18.0+ 启动及每小时检查，显示 App 内未读提醒并保留历史；没有操作系统离线推送。

同一公告分支下的 `.maintenance/` 保存公开资源的规范化快照、最近检查回执及已生成草稿。这些数据不包含凭据或玩家信息。每次将公告和状态在同一个提交中发布，保留无变化检查回执；比较、AI 生成或校验失败时不推进公开基线。完整生成的 AI 草稿另存入 Actions cache，下一次运行只恢复草稿并继续使用已发布基线，以便推送失败后重试时复用中文标签。缓存是临时恢复手段，过期或服务故障时仍可能重新调用模型。

每次运行还保留 7 天完整 checkpoint artifact（`.maintenance/` 和 `announcements/`）。人工恢复时必须同时恢复并验证公告和状态，不能单独恢复已推进的 `snapshot.json`，否则可能跳过尚未发布的公告。

首次迁移应从本机有效 `snapshot.json` 初始化云端 `.maintenance/snapshot.json`，同时保留全部已有公告。接入 Agents 时保留同一个有效 checkpoint，运行 `setup-agent.mjs --env-file <外部文件> --config tools/version-maintenance/agent-config.json` 创建或复用已保存 Agent，再手动触发并勾选 `verify_api`，用一项真实历史字段验证云端 Agents 调用（会有少量 API 用量，不生成或发布测试公告）。确认云端比较、校验、推送及真实 API 调用成功后，禁用本机 `HexGuide-AnnouncementMaintenance` 任务，避免两个维护端同时发布。本项目的本机任务已在云端迁移后停用。

## 运行异常

运行详情及失败步骤见仓库 Actions 的此工作流。API 余额、源数据下载或 GitHub 推送失败会令任务失败并保留已发布公告；修复后可手动重跑。GitHub 公共仓库连续 60 天无活动会暂停定时任务；此任务正常执行时会发布检查回执，但仍应查看 Actions 状态，不能把第三方定时服务视为永久运行保证。

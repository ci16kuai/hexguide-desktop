# 云端公告维护

维护任务位于 `.github/workflows/announcements.yml`，运行于 GitHub 托管的 Ubuntu runner，与维护者电脑及 App 是否开启无关。每 6 小时运行一次（UTC 00:37、06:37、12:37、18:37），也支持在 Actions 中手动运行。GitHub 调度可能延迟，不承诺实时发布。

正式调度使用仓库默认分支 `codex/desktop-app`。只比较公开装备和 KIWI 海克斯的可确认数值；OpenAI 仅生成中文属性标签，未发现数值变化时不调用模型。

## 凭据

仓库 Actions Secret 为 `HEXGUIDE_OPENAI_API_KEY`，仅在执行数值维护及手动 API 验证的步骤中映射为 `OPENAI_API_KEY`。不得将 key 放进仓库文件、公告、checkpoint、安装包或日志。发布使用 GitHub 自动生成的 `GITHUB_TOKEN`，无需另存个人 GitHub token。

工作流只接受 schedule 和 workflow_dispatch，不向拉取请求或 fork 提供 API key。Actions 固定到完整 commit SHA，维护代码检出不保留 Git 凭据；公告分支检出使用临时工作流凭据发布。

## 公告、状态与交接

客户端继续读取 `codex/announcements-feed` 分支的 `announcements/index.json` 及不可变详情文件，无需客户端改版。App 1.18.0+ 启动及每小时检查，显示 App 内未读提醒并保留历史；没有操作系统离线推送。

同一公告分支下的 `.maintenance/` 保存公开资源的规范化快照、最近检查回执及已生成草稿。这些数据不包含凭据或玩家信息。每次将公告和状态在同一个提交中发布，保留无变化检查回执；比较、AI 生成或校验失败时不推进公开基线。完整生成的 AI 草稿另存入 Actions cache，下一次运行只恢复草稿并继续使用已发布基线，以便推送失败后重试时复用中文标签。缓存是临时恢复手段，过期或服务故障时仍可能重新调用模型。

每次运行还保留 7 天完整 checkpoint artifact（`.maintenance/` 和 `announcements/`）。人工恢复时必须同时恢复并验证公告和状态，不能单独恢复已推进的 `snapshot.json`，否则可能跳过尚未发布的公告。

首次迁移应从本机有效 `snapshot.json` 初始化云端 `.maintenance/snapshot.json`，同时保留全部已有公告。随后手动触发并勾选 `verify_api`，用一项真实历史字段验证云端 OpenAI 调用（会有少量 API 用量，不生成或发布测试公告）。确认云端比较、校验、推送及真实 API 调用成功后，禁用本机 `HexGuide-AnnouncementMaintenance` 任务，避免两个维护端同时发布。

## 运行异常

运行详情及失败步骤见仓库 Actions 的此工作流。API 余额、源数据下载或 GitHub 推送失败会令任务失败并保留已发布公告；修复后可手动重跑。GitHub 公共仓库连续 60 天无活动会暂停定时任务；此任务正常执行时会发布检查回执，但仍应查看 Actions 状态，不能把第三方定时服务视为永久运行保证。

# 本机数据服务

`node server/main.mjs --port 0 --data-dir <可选本地目录>` 仅监听 `127.0.0.1`，stdout 第一行是 `{port,token}`。父进程通过 URL fragment 将 token 交给页面。token 仅驻留内存，不能放到查询参数、日志或仓库。关闭桌面窗口时由父进程结束服务。

`GET /api/health` 和 `GET /api/live` 需要 `X-Hexguide-Session` 请求头。仅接受精确的本机 Host 和同源 Origin；不提供跨域访问或公开监听。静态文件仅来自 `dist/`，不能越界读取或读取隐藏文件。

`POST /api/ocr` 同样需要会话 token，且只接受空 body 或 `{}`，最多 4096 字节。它启动本机 `native/scan-augments.ps1`，15 秒超时、输出上限 1 MB，一次只运行一个扫描。只有前端用户自愿触发时调用，不默认截图；返回最多三个可唯一匹配到当前资料库的名称提议。页面必须让玩家确认，不自动写入已选海克斯。截图不会保留或上传。其他写操作和请求体均拒绝。

本程序只读 Riot 的本机接口：Live Client API (`https://127.0.0.1:2999/liveclientdata/allgamedata`) 和 League Client 的游戏阶段、游戏会话及选人会话。Live Client API 用随附的 Riot 官方根证书验证 TLS。LCU 的自签证书例外仅限从本机 lockfile 取得端口的 `127.0.0.1` HTTPS 连接，使用其临时 Basic 凭据；它不影响系统、外网或 Live Client API 的证书校验。lockfile 内容、玩家名称和其他玩家信息不返回给页面，不写入文件。

LCU 默认查找常见安装目录和正在运行的 `LeagueClient` / `LeagueClientUx` 路径；也可用 `HEXGUIDE_LEAGUE_DIR` 指定安装目录。当前版本面向 Windows。

通过 activePlayer 的 Riot ID 或唯一的精确 summonerName 匹配本人，然后只提取英雄、等级、属性、装备和游戏时间。队列信息来自 LCU：仅队列 2400 被识别为海克斯大乱斗。缺少队列信息时显示模式未知，不以地图或普通 ARAM 推断。对局 ID 只用于区分新一局。

接口没有稳定承诺提供海克斯选择。缺少明确且可核对的 `augments` 字段时返回 `augments.status = unavailable`，不会将普通符文作为海克斯，也不会把“未读到”当成“已选为空”。页面应保留人工确认。

来源与资源：

- Riot 官方接口说明：https://developer.riotgames.com/docs/lol
- Riot 官方根证书：https://static.developer.riotgames.com/docs/lol/riotgames.pem
- 固定英雄映射 16.21.1：https://ddragon.leagueoflegends.com/cdn/16.21.1/data/en_US/champion.json

当前没有正在运行的完整对局时，只能验证等待状态和模拟接口测试；不能据此宣称实战连接已经验证。

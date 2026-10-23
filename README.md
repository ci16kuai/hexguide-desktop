# 海克斯指南 · Windows 桌面版

面向英雄联盟海克斯大乱斗玩家的中文选择助手。版本 **1.1.0**，资料对应 **海克斯大乱斗 4.0 / 26.21**，英雄与装备资料为 **Data Dragon 16.21.1**。资料更新时间始终显示在页面顶部。

## 使用

1. 将「海克斯指南桌面版-1.1.0.zip」完整解压到可写的文件夹。
2. 双击 `HexGuide.exe`。不需要登录 ChatGPT，也不需要另装 Node.js。
3. 正常打开英雄联盟。选人阶段尝试同步英雄，进入游戏后读取自身英雄、等级、装备、金币和面板。
4. 在「我的这一局」确认实际已选海克斯，玩法建议随英雄、装备、阶段和已确认海克斯更新。
5. 在主窗口或托盘菜单开启后台识别。主窗口最小化或点右上角 × 会收进托盘，英雄同步与已开启的识别继续运行。
6. 在游戏中按 **Alt + Shift + H** 显示或收起右侧栏；侧栏显示英雄、已确认海克斯、本轮候选和简短玩法。先在游戏中选择，再在侧栏确认「我选了这项」。
7. 需要复杂查询时打开主窗口。工具栏「返回游戏」可收起主窗口并尝试返回正在运行的游戏；托盘菜单「完全退出」才结束助手与本地服务。

「开启自动扫描」为可选实验功能，默认关闭。开启后由后台服务在对局期间约每 7 秒尝试识别一次前台游戏窗口，主窗口隐藏或页面不在实战页也继续；不会替你切窗口、按键或选择海克斯。需要游戏卡片保持可见。Windows 没有可用 OCR 语言、布局不兼容、全屏截图失败或名称不确定时，仍可手动填入。

系统要求：Windows 10/11 x64、.NET Framework 4.8、[Microsoft Edge WebView2 Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。当前电脑已有所需运行环境。主程序未作代码签名，不会自行安装服务、修改防火墙或设置开机启动。

软件旁的 `appdata` 保存本地界面缓存。可用 `HexGuide.exe --data-dir "H:\Chatgpt\hexguide-appdata"` 指定位置。关闭主窗口默认收进托盘；需要停止同步时，在托盘菜单选择「完全退出」。

## 游戏侧栏

侧栏是独立的 Windows 原生信息窗，不进入 Alt+Tab 列表，显示和刷新不主动激活窗口。侧栏不提供文字输入，复杂编辑在主窗口完成。热键若被其他应用占用，会提示改用工具栏或托盘入口。

请使用游戏的**无边框或窗口模式**；普通桌面侧栏不能保证盖在独占全屏游戏上。助手不会自行修改游戏显示设置，也不拦截 Alt+Tab 或安装键盘钩子。显示侧栏不等于已验证所有电脑上的切屏兼容性；真实游戏里的焦点切换仍需体验检查。

## 已实现与验证边界

| 功能 | 当前状态 |
| --- | --- |
| 海克斯库、英雄适配、联动查询、三选一 | 沿用网站功能，含版本和来源说明 |
| 自动识别自身英雄 | 选人阶段 LCU + 对局 Live Client API；不支持时保留未知 |
| 等级、装备、金币、面板和游戏时间 | 仅本机读取；未连接时显示空值 |
| 自适应玩法 | 英雄、确认的海克斯、当前装备与对局阶段共同影响可选路线 |
| 三选一卡片 OCR | Windows 内置 OCR，本地识别，必须人工核对；尚未用真实游戏画面验收 |
| 已选海克斯 | 以你确认的列表为准，不从卡片消失猜测你的选择 |
| 新对局与断线 | 对局 ID、选人边界和时间回退用于清空旧局；断线清除实时面板 |
| 后台与侧栏 | 主窗口收进托盘继续运行；Alt+Shift+H 收放侧栏，显式确认已选后同步推荐 |
| 手机 | 原公开网站继续支持手机；Windows 本机同步只在桌面软件运行 |

编译、桌面窗口启动/退出、本机接口、中文 OCR 合成图片和自动化检查已验证。2026-10-23 已在真实海克斯大乱斗中确认赵信英雄同步、等级、装备与面板连续更新，queueId 为 2400。1.1.0 修复整屏文字子串误匹配、短名称漏识别及识别结果被后续扫描覆盖的问题。**真实三选一卡片的完整识别仍需进一步实测，不能把合成图片通过当成实战准确率保证。**

建议提供多种可行玩法及触发条件，不展示海克斯胜率，也不替玩家执行选择。LCU 不是稳定受支持的第三方接口，游戏更新可能令部分功能失效。供个人测试；面向其他玩家广泛分发前，需要按 [Riot 开发者政策](https://developer.riotgames.com/docs/lol#game-policy) 登记产品并确认功能许可。本项目未获 Riot Games 认可。

## 开发与构建

无需前端依赖安装。Node.js 20+：

```powershell
node --test tests/*.test.mjs scripts/test-engine.mjs scripts/test-version.mjs scripts/test-data-version.mjs
node server/main.mjs --port 0 --data-dir "H:\Chatgpt\hexguide-appdata"
```

开发启动后，首行给出本次本机端口和临时 token；仅用于本机 `/#session=<token>` 启动界面。不要把这行或客户端 lockfile 上传仓库。

Windows 构建：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-desktop.ps1 -NodePath "C:\path\to\node.exe" -Package
```

脚本从官方 NuGet 下载固定 WebView2 SDK，并校验 SHA-256；使用 Windows .NET Framework 编译器，复制 Node.js 与应用资源，生成便携软件和 ZIP。缓存可用 `-CachePath` 指定；ZIP 可用 `-ArchivePath` 指定。打包排除用户缓存、日志和凭据。运行时二进制不进入 Git，构建脚本与源码保存在私有仓库。

目录：`dist/` 界面和资料；`server/` 本地采集与接口；`native/` Windows 窗口和 OCR；`tests/` 实时状态和安全检查；`scripts/` 更新与打包。海克斯数据更新见 [README-data.md](README-data.md)，装备更新运行 `node scripts/update-items.mjs`。

公开资料网站：[海克斯指南](https://hexguide-aram-20261023.robustacorn1025.chatgpt.site)。桌面源码私有保存于 [ci16kuai/hexguide-desktop](https://github.com/ci16kuai/hexguide-desktop)。

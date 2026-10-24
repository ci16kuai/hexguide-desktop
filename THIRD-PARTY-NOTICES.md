# 资料与运行环境

- 英雄联盟、英雄、海克斯、装备的名称、描述及游戏图像属于 Riot Games 或各自权利人。本项目为独立玩家工具，未获 Riot Games 认可。
- 英雄与装备目录：Riot Data Dragon 16.21.1，https://developer.riotgames.com/docs/lol#data-dragon 。
- 海克斯定义、中文文本与图标：CommunityDragon 16.21 客户端资料，https://raw.communitydragon.org/16.21/ 。详细版本、历史统计与资料出处见 README-data.md 及界面来源面板。
- 本地接口：https://developer.riotgames.com/docs/lol#game-client-api 和 League Client API 说明。Riot 根证书原址：https://static.developer.riotgames.com/docs/lol/riotgames.pem 。
- Node.js：构建时从指定的 Node.js 可执行文件复制，随软件附带对应官方 LICENSE（含其第三方许可）。https://nodejs.org/ 。
- Microsoft WebView2 SDK 1.0.4258.31：从官方 NuGet 获取；便携软件 licenses 目录附 SDK LICENSE 与 NOTICE。系统 WebView2 Runtime 由微软单独提供。
- NSIS 3.13：安装程序使用官方 Nullsoft Scriptable Install System 构建，https://nsis.sourceforge.io/ 。编译器仅用于构建，安装程序所需许可随安装包附带。
- Windows OCR、WinForms、.NET Framework 由 Windows / Microsoft 运行环境提供。

应用原创源码与上述游戏资产、外部资料、第三方运行环境分别适用各自的权利和许可。没有为第三方游戏资产授予新的使用或再分发权限。

- 英雄及英雄×海克斯胜率：AramHex / czgreat/aramhex-data，固定来源提交 `5e6770a1550d2eb40f4da83e31f142e4588524b0`，https://github.com/czgreat/aramhex-data ，按 CC BY-NC 4.0 署名、非商用使用。本项目进行了英雄/海克斯ID映射、概率转百分数、同口径胜率差计算、样本筛选与界面展示；原许可附于 `dist/licenses/aramhex-data-LICENSE.txt`。此许可仅覆盖对应统计数据，不覆盖 Riot 游戏资产或本项目其他代码。
- 展开区的英雄＋单海克斯条件装备、三件套、购买顺序及已发布双海克斯组合统计：ARAMKit，https://aramkit.com/ ，公开 JSON 版本清单 https://data.aramkit.com/data/versions.json ，使用条款 https://aramkit.com/en-US/terms 。仅在用户展开英雄条目时按需直连版本清单及该英雄的两份统计文档，页面内存最多缓存3位英雄；不下载整库、不把远端统计打包分发，也不上传当前对局。共同出现海克斯仅在来源已发布的至多10组组合中筛选并按共同样本数排序，不代表全量最相关组合或本局下一轮选项；各统计范围独立，不与 AramHex 计算增幅。展开卡片只附胜率，样本数用于内部验证和排序；少于200样本的标记只在内部计算，不在卡片显示，也不表示统计显著性。主榜原有样本列不变，展开区数据说明可折叠查看。无数据时不以机制推荐或通用统计补位。装备名称、图标、效果仍来自随包 Riot 目录。ARAMKit 的公开可访问性不等同于开放数据或再分发授权，AramHex 的 CC BY-NC 4.0 许可不适用于该来源；本项目保留来源署名和条款链接，不宣称已取得其数据再分发许可。

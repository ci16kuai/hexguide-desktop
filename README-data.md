# 海克斯大乱斗 4.0 数据

规则资料：**4.0 / Journey to Stardom / 26.21**。英雄资料：**Riot Data Dragon 16.21.1**。

统计资料仍为 **26.20，统计日 2026-10-20**。旧选择率没有改标为新版本统计。页面最后更新时间使用每次成功构建保存的 `meta.updatedAt`，不是浏览器当前时间。

## 本次实际覆盖

| 项目 | 数量与范围 |
| --- | --- |
| 英雄 | 173；官方中文、英文、职业、资源类型和头像 |
| 资料定义 | 307；含当前、历史和未确认条目 |
| 当前 KIWI 客户端源条目 | 249，逐项保留原始客户端 ID 与路径 |
| 常规强化 | 244，可进入普通候选 |
| Pentakill 事件专属 | 4，供查阅，排除普通推荐 |
| 事件内部模板 | 1；源名称为空，标记 `isInternalTemplate:true`，界面隐藏 |
| 非当前参考目录 | 45；不能据此认为本版本可抽取 |
| 已退休参考项 | 13；排除普通推荐 |
| 有旧选择率的条目 | 201；全部保留 26.20 原值 |
| 旧来源组合关联 | 666；保留来源及旧版本说明 |
| 仍含未解析内容的资料 | 94；明确显示待核实，不猜填动态数值 |

249 个源条目来自 16.21 正式客户端的 **KIWI** 名单；**KIWI_JADE** 和 **CHERRY** 是其他独立名单，没有合并。静态客户端名单可证明定义包含关系，不能证明服务器热修后的实时抽取状态。

官方 26.21 公告列出 35 项新增、13 项移除。本项目逐项核对：35 新增都出现在现行客户端名单，并且没有伪造新版本选择率。16.20→16.21 的静态名单差集是增加 40（35 普通新增及 5 个事件条目）、移除 14，与公告存在一项移除口径差异；当前目录采用实际 16.21 KIWI 名单，不拿 PBE 预告数量替代正式客户端。

## 数据源

- [Riot Games 26.21 正式公告](https://www.leagueoflegends.com/en-us/news/game-updates/league-of-legends-patch-26-21-notes/)：核验新增、移除和 Journey to Stardom 规则。
- [CommunityDragon 16.21 模式名单](https://raw.communitydragon.org/16.21/plugins/rcp-be-lol-game-data/global/default/v1/augment-lists.json)：只读取 `modeName === 'KIWI'`。
- [CommunityDragon 16.21 KIWI 定义](https://raw.communitydragon.org/16.21/game/maps/modespecificdata/kiwi.bin.json)：强化名称键、描述键、图标、品质、平台 ID、RootSpell 与原始数值。
- [CommunityDragon 16.21 官方简体中文字符串表](https://raw.communitydragon.org/16.21/game/zh_cn/data/menu/en_us/lol.stringtable.json)：当前强化中文文本。
- [CommunityDragon 16.21 英文元数据](https://raw.communitydragon.org/16.21/plugins/rcp-be-lol-game-data/global/default/v1/cherry-augments.json)与[中文元数据](https://raw.communitydragon.org/16.21/plugins/rcp-be-lol-game-data/global/zh_cn/v1/cherry-augments.json)：按平台 ID 取名称；文件名虽有 cherry，绝不据此把全部 594 个定义当作 Mayhem 目录。
- [Riot Data Dragon 文档](https://developer.riotgames.com/docs/lol#data-dragon)：使用对应 16.21.1 的 `zh_CN/champion.json` 与 `en_US/champion.json`。`resource` 直接取官方 `partype`，没有将所有法师推断为使用法力。
- [arammayhem.com 公开下载](https://arammayhem.com/data/)：使用其 `index.json`、`latest/augments.json`、`latest/combos.json`；当前来源仍标 26.20。只保留可复用的选择率和目录关联，未读取或复制胜率及强度等级。
- [arammayhem.com 搜索目录](https://arammayhem.com/search-index.json)：保留不在现行客户端名单的历史/参考中文描述，并留 `descriptionPatch:26.20`；现行条目由正式客户端文本替换。

## 版本与可用状态字段

- `meta.gameVersion:'4.0'`、`meta.patch / augmentPatch:'26.21'`：规则与当前目录版本。
- `meta.statsPatch:'26.20'`、`meta.statsDate:'2026-10-20'`：选择率统计版本与日期。
- `meta.championDataVersion / dataDragonVersion:'16.21.1'`：英雄资源版本。
- `meta.updatedAt / fetchedAt`：本次全部下载与检查成功后的真实 UTC 时间，页面可按悉尼时区显示。
- 每项 `patch`：该项当前资料版本。`descriptionPatch`、`statsPatch` 和 `statsDate` 单独记录文本与统计，不能相互代替。
- `availability:'current'`：该定义在 16.21 KIWI 源名单中。
- `availability:'retired-in-source'`：官方或旧来源标记移除的参考项；`retiredPatch` 保留版本。
- `availability:'catalog-only'`：未进入当前 KIWI 名单的参考资料，不应默认推荐。
- `acquisition:'headliner-only'`、`recommendable:false`：Pentakill 事件项。仅 4 项有可展示名称；第 5 项是 `isInternalTemplate:true` 的内部模板，`name` 保留源空值，必须隐藏。
- 推荐候选应满足：`availability==='current' && !retiredPatch && recommendable!==false && !isInternalTemplate`。
- 旧站标记退休、现行 KIWI 却包含的返场项，清除当前 `retiredPatch`；旧记录放 `sourceRetiredPatch / previousSourceSnapshot`，不拿旧退休状态覆盖新名单。
- `sourceGameId / sourcePath / gameDataId / definitionKey`：保留 `AugmentNameId`、模式路径、平台数值 ID 与定义原键，支持独立核对集合。部分定义原键是哈希，`sourcePath` 是对应完整路径，二者可用小写 FNV-1a 32 位交叉核验。
- `meta.officialChanges`：保存 35 项正式新增与 13 项正式移除的英文名、映射 ID、来源。旧目录没有的移除项仍留官方记录，不伪造一个游戏定义。

## 中文文本与数值

客户端字符串表键先按小写查找；未解码键按 [CDTB 实现](https://raw.githubusercontent.com/CommunityDragon/CDTB/master/cdtb/rstfile.py)取 `XXH3_64(lowercase UTF-8) & ((1<<38)-1)`。递归展开 `{{引用键}}`，最多 8 层。

`descriptionTemplate` 留原始字符串，`descriptionOriginal` 留展开并去排版后的原文，`tooltipOriginal` 留完整提示文本。供页面展示的 `description / summary` 只代入 RootSpell 中各等级都相同的直接常数（及显式乘数），按 4 位小数消除游戏 float32 噪声；复杂动态公式、角色等级/属性缩放和运行中统计不按猜测求值。未解析变量保存在 `unresolvedValues` 并显示 `〔数值待核实〕` 或 `〔运行时内容待核实〕`。

例如循环往复在此正式客户端源中可直接解析为 60 技能急速；珠光护手的暴击几率来自动态计算，因此保留待核实标记。没有拿旧版数值冒充新版本数值。

`pickRate` 的单位是百分数，是选择率而不是胜率；无来源统计用 `null`，不能写成 0。`combos` 只是 26.20 来源目录的英雄与强化符文关联，不是经 26.21 实测验证的联动或强度。原始 `types` 可能包含 trap / bug 等分类，不能无条件作为正向推荐。

## 可重跑更新

需要 Node.js 20+ 和 Python 3。运行：

```powershell
node .\scripts\update-data.mjs
```

本更新器明确固定 **4.0 / 26.21 / CommunityDragon 16.21**；不是不经核验便追随任意新版本的程序。每次重新下载公开源，不复用旧详情页。第一次为 Riot 字符串表解析安装固定版本 `xxhash==3.6.0` 到 H: 任务缓存，随后复用依赖；不改全局 Python 安装，不需要登录、账号或 API key。

默认下载与依赖缓存：`H:\Chatgpt\work\2026-10-23\hexguide\update-4\source-cache`。可用 `--cache <H:路径>`、`--out <路径>` 调整。Python 不在可用路径时，使用 `--python <python.exe完整路径>` 或环境变量 `HEXGUIDE_PYTHON` 指定既有解释器；更新器也尝试当前 bundled Node 旁的 Python。

HTTP 使用 25 秒超时、最多 3 次尝试；检查模式池、唯一 ID、合法品质、版本、249 源集合、244/4/1 区分、35 新增/13 公告移除、关联引用和中文无乱码后，一次替换 `dist/data.json`。基础源、结构或关键覆盖校验失败时保留旧输出。若公开统计已经超过 26.21，会停止而不将未来统计混入此固定规则快照。

图标与头像使用固定版本远程 URL；尚未离线打包，界面应在远程图片不可用时提供占位图。

## 署名与内容范围

arammayhem.com 公开下载声明为 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)，其可复用统计范围明确是选择率。页面保留：**数据来源：[arammayhem.com](https://arammayhem.com/data/)，按 CC BY 4.0 整理并转换字段。**

这一声明不能推定为 Riot 游戏文本、图标或第三方其他内容的 CC 授权。当前客户端资料与素材标注 Riot Games / CommunityDragon 来源，没有重新声明为 CC，也未声称获得 Riot 官方认可。

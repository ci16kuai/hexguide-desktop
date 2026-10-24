# 海克斯已选数据验证包

这是用于开发者白名单账号的隔离测试窗口，尚未接入正式海克斯助手。
Overwolf 官方接口状态正常、离线测试通过，都不能代替国服自定义对局实测。

## 加载与测试

1. 安装官方 Overwolf 客户端，在客户端内自行登录获白名单的 Overwolf 账号。账号白名单与控制台访问资格不同。
2. 打开 Overwolf 设置 → Support（支持）→ Development options（开发选项）→ Load unpacked（加载未打包应用），选择本包中含 `manifest.json` 的文件夹。
3. 开发者列表内可能显示 **Sample App**。这是依照官方示例要求保留的技术名称与作者；窗口内明确标记为本地修改的海克斯诊断程序，不代表 Overwolf 官方产品。
4. 启动诊断窗口，进入英雄联盟海克斯大乱斗对局后点击“开始观察”。普通浏览器和只打开游戏大厅都不能验证此数据。
5. 对照游戏：三张候选出现后，检查候选顺序；在游戏里选一个，检查“接口返回的已选海克斯”是否自行更新。再验证第二轮、刷新候选和重新开局的结果。
6. 测试结束点击“停止观察”或关闭窗口。本工具不自动启动游戏，也不改动正式助手。

如果开发选项缺失或加载被拒绝，先核对登录账号的白名单资格，不绕过平台校验。

## 判定条件

- **接口订阅成功**只是获得所需字段，不能说明真实已选识别成功。
- **未识别项大于零**时，不推测对应中文海克斯，也不把它写成本局选择。
- 必须在真实对局中核对候选、实际选择、后续轮次和新对局清空行为，才决定如何接入正式助手。
- 官方示例里的 TFT 内部名称只是结构示例，不能当作本机真实 LoL 名称。
- 本工具当前只观察最新快照，未将 `picked_augment` 推断为完整历史；替换、刷新和多轮槽位含义仍需核对。

## 数据范围

窗口只订阅 `augments`、`matchState`，只显示本地目录精确匹配的中文名称、槽位、未知项数量和更新时间。
对局标识只用于内存内区分新对局，不显示、落盘或上传。本工具不自行读取进程内存或注入游戏、不自动点击；游戏事件由 Overwolf 平台提供。
本工具不保存玩家身份、完整事件或原始内部名称；本身没有统计分析、广告或遥测代码。Overwolf 客户端自身行为以其平台说明为准。

## 构建

在源码仓库运行 Node.js 20 以上版本：

```text
node tools/overwolf-probe/build-probe.mjs <新的绝对输出目录>
node --test tools/overwolf-probe/decoder.test.mjs
```

目录只包含当前海克斯身份映射和诊断代码，原有助手版本及用户设置不会更改。

## 官方依据

- [官方示例及 Load unpacked 说明](https://github.com/overwolf/sample-app#load-as-unpacked-extension)：示例来源快照 `1503ecca081a88fb4c780edbeaee497ce11f2ebf`；按 README 保留 manifest 的 Sample App / Overwolf 技术身份，未复制其后台控制器、分析或日志逻辑。
- [LoL 海克斯字段](https://dev.overwolf.com/ow-native/live-game-data-gep/supported-games/league-of-legends/#augments)
- [游戏事件接口](https://dev.overwolf.com/ow-native/reference/games/events/)
- [官方接口状态](https://game-events-status.overwolf.com/5426_prod.json)

本包需要实际安装、账号白名单验证以及真实对局测试；不承诺国服或自定义房间支持。

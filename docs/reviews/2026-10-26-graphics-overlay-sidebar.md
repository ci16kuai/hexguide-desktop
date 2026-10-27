# 后台游戏露出仍隐藏侧栏的现场复盘（1.15.2）

## 事实与原因

用户明确报告：在 1.15.1 上，其他应用获得焦点，背景游戏仍实时可见，但侧栏仅保留切屏的短暂防抖，之后消失。用户要求持续显示和切屏防抖同时保留。

2026-10-26 17:47 AEDT，用户保持该布局时，只读采样取得：游戏窗口存在、游戏及助手均不在前台；侧栏 enabled/pinned 均为 true，而 desiredVisible/actualVisible 均为 false。排除了手动收起。当前露出算法最终返回 too-little-exposure。

后续同布局采样：游戏有效区域 3,563,520 像素；正常前台窗口扣除后仍余 2,154,356 像素；一个非前台 layered + input-transparent 辅助层再按矩形扣除后仅余 1,392 像素，未达到有效矩形门限。该层的 GetLayeredWindowAttributes 成功但 alpha=0、flags=0。之后的本机公开组件元数据核对将此窗口归属定位为 NVIDIA 显卡组件，窗口类为 CEF-OSC-WIDGET。

1.15.1 对未知窗口属性失败的矩形回退没有解决这个场景：此处属性查询成功，问题是辅助层矩形不代表游戏被实际挡住的区域。

## 未采用的泛化规则

不将 alpha=0/flags=0 一律解释为透明。Microsoft API 合约仅在 LWA_ALPHA 标记存在时明确使用 alpha；input-transparent 也只保证输入穿透。[GetLayeredWindowAttributes](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getlayeredwindowattributes)、[Layered Windows](https://learn.microsoft.com/en-us/windows/win32/winmsg/window-features#layered-windows)

30 项离屏原生矩阵表明，多种状态都能产生成功/0/0。进一步使用自己创建的 64×64 蓝色不透明底板和红色测试层验证：蓝色底板及红色不透明对照均正确；fresh flags0、ULW_OPAQUE→flags0、color-key→flags0 仍呈红色。故成功/0/0 确实可以是不透明，不可作为全局排除条件。

这些生成画面实验没有保存截图，只在生成底板覆盖范围内将一个中心点分类为 red/blue/other。普通未知上层窗口存在时中止采样；仅现场已识别的零参数 NVIDIA 辅助层允许作为兼容实验背景，且蓝底与红色不透明对照均需通过。未读取微信或其他应用正文，未发送键鼠输入。

## 兼容策略

新增独立的显示兼容适配层；它是对已观察 NVIDIA 辅助表面的版本化显示政策，不声称证明任意 Windows layered surface 的像素透明性。条件同时限定窗口类、layered/input-transparent/tool-window 属性、成功的零参数查询，以及前台进程/root-owner 不在同一显卡界面。程序身份绑定 NVIDIA Overlay.exe、NVIDIA Corporation、NVIDIA App、128.4.13.31 和已核验二进制 SHA-256；现场该文件的 Authenticode 状态为 Valid。

身份核验异步执行，不在界面轮询中读取/散列文件。缓存按 PID、进程创建身份及路径绑定，最多八项、两个核验任务；不以单独 PID 信任重用进程，也不将核验超时变成无限新任务。未知或未完成核验继续使用原遮挡规则。正结果绑定该运行进程，避免固定期限重新核验引起周期性闪烁。缓存不写磁盘、不上传。

普通遮挡、游戏最小化/退出、手动收起以及原 600 毫秒切屏门限保持原策略。显卡程序本身正在前台交互时不使用该兼容排除。

边界：同一版本的显卡辅助窗口理论上可能保持相同元数据而改变所绘内容；此策略针对已观察的非交互辅助状态，不是所有 NVIDIA 界面的通用透明度保证。其他二进制版本或状态无法匹配时，保守回退，并需重新验证兼容配置。

## 验证

完整 Node 回归 724/724、原生选择检查 1,136 项、侧栏离屏检查 669 项和单实例 22 项通过。侧栏检查包含原显示策略/600 毫秒防抖 65 项和显卡兼容策略 61 项；新增负例覆盖 owner 与前台进程交叉、PID 复用、被淘汰任务迟到、真实 worker 数量及超过 signed TickCount 半周期的长暂停。独立审查提出的两项实现问题均修正并复核通过。

最终模块针对仍在运行的真实 NVIDIA 辅助层进行只读调用，两个候选中恰有一个通过完整策略与二进制验证，耗时 144 毫秒。该结果验证真实版本资源格式、进程时间身份、SHA-256 和窗口条件能够匹配；不是重现下一局的侧栏实际显示结论。

现场原始证据和实验仅在 H:\Chatgpt\work\2026-10-26\hexguide-background-sidebar-live 下，输出固定状态、布尔值、面积计数和生成颜色分类，不保存窗口标题、截图、玩家身份或认证信息。

## 安装

安装包 H:\Chatgpt\outputs\2026-10-23\HexGuide-Setup-1.15.2.exe，SHA-256 为 `384123db8c325d2516806dc3fe478c499c86df5c9e9f68036140a2dfe1e99f0c`。

2026-10-26 18:23 AEDT，在游戏已自然退出后，同路径升级至 H:\Chatgpt\apps\HexGuide，仅重启助手。88 个安装文件逐一散列匹配，六项原有设置/会话文件在安装期间保持散列不变，Riot 客户端进程身份保持。程序、卸载注册及四份新生成诊断均为 1.15.2，安装 exe 与已测试构建散列一致。

安装及运行健康检查已通过；因对局已结束，修正后的真实游戏持续显示仍待下一局确认，不将模块匹配成功或离屏检查写为实战已通过。

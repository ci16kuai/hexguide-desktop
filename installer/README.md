# Windows 安装版

运行 `scripts/build-desktop.ps1 -StagePath artifacts/portable-1.4.0` 构建便携目录后，再用 `scripts/build-installer.ps1 -StagePath artifacts/portable-1.4.0` 生成 `HexGuide-Setup-1.4.0.exe` 和 SHA-256 校验文件。源码版本决定安装包版本，也可显式传入 `-AppVersion`。

安装向导使用简体中文，支持选择安装文件夹、可选桌面快捷方式、开始菜单入口和 Windows“已安装的应用”中的卸载入口。只为当前用户安装，无需管理员权限。默认程序目录是 `%LOCALAPPDATA%\Programs\HexGuide`；快捷方式将个人设置与浏览器缓存写入 `%LOCALAPPDATA%\HexGuide\data`。卸载只删除构建时明确列出的程序文件，保留个人数据和额外文件，不使用递归删除。更新或卸载时，如果目标目录的主程序或后台进程文件仍在使用，会停止并提示从托盘完全退出；不会终止游戏或其他便携实例。

系统要求：Windows 10/11 x64、.NET Framework 4.8、Microsoft Edge WebView2 Runtime。安装器不会自动下载依赖或创建开机启动项；完成页的“打开海克斯指南”默认不勾选。

编译器使用官方 [NSIS 3.13](https://sourceforge.net/projects/nsis/files/NSIS%203/3.13/nsis-3.13.zip/download) 的便携 ZIP，构建前验证发布页提供的 SHA-256：`ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8`。编译器只保存在可配置的 H 盘缓存；NSIS 的 COPYING 随安装包保存在 `licenses/NSIS-LICENSE.txt`。压缩采用 NSIS 原生 LZMA。

独立验证可传 `-TestScope -OutputPath <测试安装器路径>`：该版本使用不同的注册表标识、数据目录和快捷方式名称，不覆盖正式安装记录。命令行 `/S /NODESKTOP /D=H:\...\HexGuide` 可执行静默测试，`/D=` 必须是最后一个参数，路径本身不额外加引号。卸载支持标准 `/S`。测试时应在专门的空目录内安装，增加一个无关文件和数据哨兵，验证卸载后仍保留。

此项目尚未配置代码签名证书，安装包不会显示已验证的商业发布者。文件哈希用于核对下载与发布版本一致，不能替代数字签名。

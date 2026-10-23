; UTF-8. Build through scripts/build-installer.ps1; payload file lists are generated.
Unicode true
SetCompressor /SOLID lzma
SetCompressorDictSize 64
RequestExecutionLevel user
ManifestDPIAware true
CRCCheck force
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "Sections.nsh"
!include "${PAYLOAD_MANIFEST}"

!define PRODUCT_REG "Software\${PRODUCT_ID}"
!define UNINSTALL_REG "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_ID}"
Name "${APP_TITLE} ${APP_VERSION}"
OutFile "${SETUP_OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT_ID}"
InstallDirRegKey HKCU "${PRODUCT_REG}" "InstallLocation"
BrandingText "海克斯指南 · Windows 桌面助手"
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "海克斯指南安装程序"
VIAddVersionKey /LANG=2052 "FileDescription" "海克斯指南 Windows 安装程序"
VIAddVersionKey /LANG=2052 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "FileVersion" "${APP_VERSION}.0"
VIAddVersionKey /LANG=2052 "LegalCopyright" "HexGuide contributors"
!define MUI_ICON "${APP_ICON}"
!define MUI_UNICON "${APP_ICON}"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "安装海克斯指南 ${APP_VERSION}"
!define MUI_WELCOMEPAGE_TEXT "选择安装位置，即可在开始菜单或桌面打开助手。$\r$\n$\r$\n本程序仅为当前 Windows 用户安装，无需管理员权限。$\r$\n$\r$\n需要 Windows 10/11 x64、.NET Framework 4.8 与 Microsoft Edge WebView2 Runtime。$\r$\n$\r$\n安装后可在托盘中完全退出，再进行更新或卸载。"
!insertmacro MUI_PAGE_WELCOME
!define MUI_COMPONENTSPAGE_TEXT_TOP "选择是否创建桌面图标。开始菜单入口会自动创建。"
!insertmacro MUI_PAGE_COMPONENTS
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE DirectoryLeave
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "海克斯指南已安装"
!define MUI_FINISHPAGE_TEXT "可通过桌面或开始菜单打开海克斯指南。$\r$\n$\r$\n个人设置保存在本机用户目录，卸载时会保留。$\r$\n$\r$\n海克斯识别结果仍需确认，软件不会代替你操作游戏。"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!define MUI_FINISHPAGE_RUN_TEXT "打开海克斯指南"
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!insertmacro MUI_PAGE_FINISH
!define MUI_UNCONFIRMPAGE_TEXT_TOP "卸载海克斯指南的程序文件和快捷方式。个人设置与缓存会保留。$\r$\n$\r$\n请先从系统托盘菜单选择“完全退出”。"
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"

Var ValidationError
Var MarkerValue
Var ExistingLocation



Function ValidateDestination
  StrCpy $ValidationError ""
  ; NSIS GetFullPathName requires an existing parent; Win32 supports new nested folders.
  System::Call 'kernel32::GetFullPathNameW(w "$INSTDIR", i ${NSIS_MAX_STRLEN}, w .r0, p 0) i .r1'
  ${If} $1 == 0
  ${OrIf} $1 >= ${NSIS_MAX_STRLEN}
    StrCpy $ValidationError "安装路径无效或过长，请选择一个较短的完整路径。"
    Return
  ${EndIf}
  StrCpy $INSTDIR $0
  ${GetRoot} "$INSTDIR" $0
  ${If} $INSTDIR == $0
  ${OrIf} $INSTDIR == "$0\"
  ${OrIf} $INSTDIR == "$WINDIR"
  ${OrIf} $INSTDIR == "$SYSDIR"
  ${OrIf} $INSTDIR == "$PROFILE"
  ${OrIf} $INSTDIR == "$LOCALAPPDATA"
  ${OrIf} $INSTDIR == "$APPDATA"
  ${OrIf} $INSTDIR == "$PROGRAMFILES"
  ${OrIf} $INSTDIR == "$PROGRAMFILES64"
  ${OrIf} $INSTDIR == "$DESKTOP"
  ${OrIf} $INSTDIR == "$DOCUMENTS"
  ${OrIf} $INSTDIR == ""
    StrCpy $ValidationError "请选择专门的海克斯指南子文件夹，不能直接使用磁盘根目录或系统目录。"
    Return
  ${EndIf}
  ; A nonempty folder must already belong to this installer. No unrelated folder is reused.
  IfFileExists "$INSTDIR\*.*" 0 validate_done
  IfFileExists "$INSTDIR\.hexguide-install" 0 unmarked_folder
  FileOpen $0 "$INSTDIR\.hexguide-install" r
  FileRead $0 $MarkerValue
  FileClose $0
  ${If} $MarkerValue != "${PRODUCT_ID}"
    StrCpy $ValidationError "该文件夹不是有效的海克斯指南安装目录，请选择一个新的空文件夹。"
  ${EndIf}
  Goto validate_done
unmarked_folder:
  FindFirst $0 $1 "$INSTDIR\*.*"
nonempty_loop:
  ${If} $1 == ""
    FindClose $0
    Goto validate_done
  ${EndIf}
  ${If} $1 != "."
  ${AndIf} $1 != ".."
    FindClose $0
    StrCpy $ValidationError "所选文件夹已有其他文件，请选择一个新的海克斯指南子文件夹。"
    Goto validate_done
  ${EndIf}
  FindNext $0 $1
  Goto nonempty_loop
validate_done:
FunctionEnd

Function DirectoryLeave
  Call ValidateDestination
  ${If} $ValidationError != ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "$ValidationError" /SD IDOK
    Abort
  ${EndIf}
FunctionEnd

; Loading an executable image denies write access. Check exact target files only;
; never terminate another app or game, and never inspect credentials/process memory.
!macro DefineTargetCheck Prefix
Function ${Prefix}CheckTargetFiles
  StrCpy $ValidationError ""
  IfFileExists "$INSTDIR\HexGuide.exe" 0 check_node
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\HexGuide.exe", i 0x40000000, i 7, p 0, i 3, i 0, p 0) p .r0'
  ${If} $0 == -1
    StrCpy $ValidationError "安装目录中的海克斯指南正在运行或无法写入。请先从该软件的托盘菜单选择“完全退出”，再重试。"
    Return
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r0)'
check_node:
  IfFileExists "$INSTDIR\runtime\node.exe" 0 check_done
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\runtime\node.exe", i 0x40000000, i 7, p 0, i 3, i 0, p 0) p .r0'
  ${If} $0 == -1
    StrCpy $ValidationError "安装目录中的后台服务仍在运行或无法写入。请先从海克斯指南托盘菜单选择“完全退出”，再重试。"
    Return
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r0)'
check_done:
FunctionEnd
!macroend
!insertmacro DefineTargetCheck ""
!insertmacro DefineTargetCheck "un."

Section "海克斯指南（必需）" SecCore
  SectionIn RO
  Call ValidateDestination
  ${If} $ValidationError != ""
    MessageBox MB_OK|MB_ICONSTOP "$ValidationError" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  Call CheckTargetFiles
  ${If} $ValidationError != ""
    MessageBox MB_OK|MB_ICONSTOP "$ValidationError" /SD IDOK
    SetErrorLevel 3
    Abort
  ${EndIf}
  SetOverwrite on
  !insertmacro InstallPayload
  SetOutPath "$INSTDIR"
  FileOpen $0 "$INSTDIR\.hexguide-install" w
  FileWrite $0 "${PRODUCT_ID}"
  FileClose $0
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\${SHORTCUT_NAME}"
  CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME}\${SHORTCUT_NAME}.lnk" "$INSTDIR\HexGuide.exe" '--data-dir "$LOCALAPPDATA\${PRODUCT_ID}\data"' "$INSTDIR\HexGuide.exe" 0
  CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME}\卸载.lnk" "$INSTDIR\Uninstall.exe" "" "$INSTDIR\Uninstall.exe" 0
  WriteRegStr HKCU "${PRODUCT_REG}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_REG}" "DisplayName" "${APP_TITLE}"
  WriteRegStr HKCU "${UNINSTALL_REG}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_REG}" "Publisher" "HexGuide contributors"
  WriteRegStr HKCU "${UNINSTALL_REG}" "DisplayIcon" "$INSTDIR\HexGuide.exe,0"
  WriteRegStr HKCU "${UNINSTALL_REG}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_REG}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "${UNINSTALL_REG}" "QuietUninstallString" '$\"$INSTDIR\Uninstall.exe$\" /S'
  WriteRegStr HKCU "${UNINSTALL_REG}" "URLInfoAbout" "https://hexguide-aram-20261023.robustacorn1025.chatgpt.site/download.html"
  WriteRegDWORD HKCU "${UNINSTALL_REG}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_REG}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINSTALL_REG}" "EstimatedSize" ${ESTIMATED_SIZE_KB}
SectionEnd

Section "创建桌面快捷方式" SecDesktop
  CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\HexGuide.exe" '--data-dir "$LOCALAPPDATA\${PRODUCT_ID}\data"' "$INSTDIR\HexGuide.exe" 0
SectionEnd

Function .onInit
  SetShellVarContext current
  SetRegView 64
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "此安装包需要 64 位 Windows 10 或 Windows 11。" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "此安装包需要 Windows 10 或 Windows 11。" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ; NSIS may silently ignore an unsafe /D= root and fall back to InstallDir.
  ; /D= is removed from $CMDLINE; read the native command line to retain the request.
  System::Call 'kernel32::GetCommandLineW() w .r0'
  ClearErrors
  ${GetOptions} $0 "/D=" $1
  ${IfNot} ${Errors}
    StrCpy $INSTDIR $1
  ${EndIf}
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/NODESKTOP" $1
  ${IfNot} ${Errors}
    !insertmacro UnselectSection ${SecDesktop}
  ${EndIf}
FunctionEnd

Function LaunchApp
  Exec '$\"$INSTDIR\HexGuide.exe$\" --data-dir $\"$LOCALAPPDATA\${PRODUCT_ID}\data$\"'
FunctionEnd

Function un.onInit
  SetShellVarContext current
  SetRegView 64
  IfFileExists "$INSTDIR\.hexguide-install" 0 invalid_uninstall
  FileOpen $0 "$INSTDIR\.hexguide-install" r
  FileRead $0 $MarkerValue
  FileClose $0
  ${If} $MarkerValue == "${PRODUCT_ID}"
    Return
  ${EndIf}
invalid_uninstall:
  MessageBox MB_OK|MB_ICONSTOP "找不到有效安装标记，已停止卸载。请从原安装目录运行卸载程序。" /SD IDOK
  SetErrorLevel 2
  Quit
FunctionEnd

Section "Uninstall"
  Call un.CheckTargetFiles
  ${If} $ValidationError != ""
    MessageBox MB_OK|MB_ICONSTOP "$ValidationError" /SD IDOK
    SetErrorLevel 3
    Abort
  ${EndIf}
  ; Remove only exact files shipped in this version. No recursive deletion.
  !insertmacro RemovePayload
  ReadRegStr $ExistingLocation HKCU "${PRODUCT_REG}" "InstallLocation"
  ${If} $ExistingLocation == $INSTDIR
    Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
    Delete "$SMPROGRAMS\${SHORTCUT_NAME}\${SHORTCUT_NAME}.lnk"
    Delete "$SMPROGRAMS\${SHORTCUT_NAME}\卸载.lnk"
    RMDir "$SMPROGRAMS\${SHORTCUT_NAME}"
    DeleteRegKey HKCU "${UNINSTALL_REG}"
    DeleteRegKey HKCU "${PRODUCT_REG}"
  ${EndIf}
  Delete "$INSTDIR\.hexguide-install"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  ; $LOCALAPPDATA\${PRODUCT_ID}\data and any unrelated files are retained.
SectionEnd

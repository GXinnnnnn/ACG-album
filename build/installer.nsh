; ACG-album / electron-builder 26.8.1 assisted installer theme.
; Keep all install, upgrade, elevation, registry and data operations in builder.
!ifndef ACG_INSTALLER_THEME
!define ACG_INSTALLER_THEME
!include "MUI2.nsh"
!include "WinMessages.nsh"

; Mirror src/ui/styles.css's light palette; all fonts come from Windows.
SetFont "Segoe UI" 9
!define ACG_SURFACE "F7F7FC"
!define ACG_BACKGROUND "E9EBF4"
!define ACG_TEXT "252738"
!define ACG_SOFT "575C73"
!define ACG_ACCENT "C64683"
!define MUI_BGCOLOR "${ACG_SURFACE}"
!define MUI_TEXTCOLOR "${ACG_TEXT}"
!define MUI_INSTFILESPAGE_COLORS "${ACG_TEXT} ${ACG_SURFACE}"
!define MUI_DIRECTORYPAGE_BGCOLOR "FFFFFF"
!define MUI_DIRECTORYPAGE_TEXTCOLOR "${ACG_TEXT}"
!define MUI_CUSTOMFUNCTION_GUIINIT AcgThemeGUIInit
!ifdef BUILD_UNINSTALLER
  !define MUI_CUSTOMFUNCTION_UNGUIINIT un.AcgThemeGUIInit
!endif

; The installer is x86 even when it carries an x64 application. All HWNDs and
; allocated addresses use pointer-sized System parameters, not truncated ints.
!macro ACG_COMMON_FUNCTIONS PREFIX
Function ${PREFIX}AcgThemeGUIInit
  SetCtlColors $HWNDPARENT "${ACG_TEXT}" "${ACG_BACKGROUND}"
  Call ${PREFIX}AcgThemeButtons
FunctionEnd

Function ${PREFIX}AcgThemeButtons
  ; Preserve button types, default-button status, focus, enabled state and the
  ; shield supplied by multiUserUi.nsh's BCM_SETSHIELD. Never draw a fake shield.
  System::Store S
  GetDlgItem $0 $HWNDPARENT 2
  System::Call '*(i, i, i, i)p.r4'
  System::Call 'user32::GetWindowRect(p r0, p r4)i.r1'
  ${If} $1 != 0
    System::Call 'user32::MapWindowPoints(p 0, p $HWNDPARENT, p r4, i 2)i'
    System::Call '*$4(i, i, i.r5, i.r6)'
    ; Convert the width, height and gap from this dialog's font/DPI to pixels.
    System::Call '*$4(i 0, i 0, i 70, i 18)'
    System::Call 'user32::MapDialogRect(p $HWNDPARENT, p r4)i.r1'
    ${If} $1 != 0
      System::Call '*$4(i, i, i.r7, i.r8)'
      IntOp $9 $7 / 12
      IntOp $6 $6 - $8
      ; Keep Cancel's right edge and the original bottom edge fixed.
      !insertmacro ACG_LAYOUT_BUTTON 2
      IntOp $5 $5 - $9
      !insertmacro ACG_LAYOUT_BUTTON 1
      IntOp $5 $5 - $9
      !insertmacro ACG_LAYOUT_BUTTON 3
    ${EndIf}
  ${EndIf}
  System::Free $4
  System::Store L
FunctionEnd

!macroend

!ifndef BUILD_UNINSTALLER
Var AcgContentFramed
; Move a MUI full-window page into the existing standard page placeholder.
; If the placeholder is unavailable, retain MUI's original layout safely.
Function AcgThemeContentFrame
  Exch $0
  System::Store S
  StrCpy $AcgContentFramed 0
  GetDlgItem $1 $HWNDPARENT 1018
  ${If} $1 != 0
    System::Call '*(i, i, i, i)p.r2'
    System::Call 'user32::GetWindowRect(p r1, p r2)i.r3'
    ${If} $3 != 0
      System::Call 'user32::MapWindowPoints(p 0, p $HWNDPARENT, p r2, i 2)i'
      System::Call '*$2(i.r5, i.r6, i.r7, i.r8)'
      IntOp $7 $7 - $5
      IntOp $8 $8 - $6
      ${If} $7 > 0
      ${AndIf} $8 > 0
        System::Call 'user32::SetWindowPos(p r0, p 0, i r5, i r6, i r7, i r8, i 0x0014)i.r3'
        StrCpy $AcgContentFramed $3
      ${EndIf}
    ${EndIf}
    System::Free $2
  ${EndIf}
  System::Store L
  Pop $0
FunctionEnd
!endif

; Coordinates are dialog units, converted using the existing page's font/DPI.
!macro ACG_MOVE_CONTROL PAGE HANDLE X Y WIDTH HEIGHT
  System::Call '*(i ${X}, i ${Y}, i ${WIDTH}, i ${HEIGHT})p.r0'
  System::Call 'user32::MapDialogRect(p ${PAGE}, p r0)i.r1'
  ${If} $1 != 0
    System::Call '*$0(i.r1, i.r2, i.r3, i.r4)'
    System::Call 'user32::SetWindowPos(p ${HANDLE}, p 0, i r1, i r2, i r3, i r4, i 0x0014)i'
  ${EndIf}
  System::Free $0
!macroend

!macro ACG_LAYOUT_BUTTON ID
  IntOp $5 $5 - $7
  GetDlgItem $0 $HWNDPARENT ${ID}
  System::Call 'user32::GetWindowLongW(p r0, i -16)i.r1'
  ; Clear only alignment bits; preserve BS_DEFPUSHBUTTON and all other styles.
  IntOp $1 $1 & 0xFFFFF0FF
  IntOp $1 $1 | 0x00000F00
  System::Call 'user32::SetWindowLongW(p r0, i -16, i r1)i'
  System::Call 'user32::SetWindowPos(p r0, p 0, i r5, i r6, i r7, i r8, i 0x0034)i'
!macroend

!insertmacro ACG_COMMON_FUNCTIONS ""
!ifdef BUILD_UNINSTALLER
  !insertmacro ACG_COMMON_FUNCTIONS "un."
!endif

!macro customWelcomePage
  !define MUI_PAGE_CUSTOMFUNCTION_PRE AcgWelcomePre
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW AcgWelcomeShow
  !define MUI_WELCOMEPAGE_TITLE "欢迎安装 ACG-album"
  !define MUI_WELCOMEPAGE_TEXT "让文件夹里的收藏，更值得翻看。$\r$\n$\r$\n接下来选择安装范围和位置，再将相册安装到电脑。$\r$\n$\r$\n选择为所有用户安装时，Windows 可能请求管理员授权；授权后会继续安装。"
  !insertmacro MUI_PAGE_WELCOME

  Function AcgWelcomePre
    ${If} ${UAC_IsInnerInstance}
      Abort
    ${EndIf}
    ${If} ${isUpdated}
      Abort
    ${EndIf}
  FunctionEnd

  Function AcgWelcomeShow
    System::Store S
    Push $mui.WelcomePage
    Call AcgThemeContentFrame
    ${If} $AcgContentFramed != 0
      Call muiPageUnloadFullWindow
      !insertmacro MUI_HEADER_TEXT "欢迎安装 ACG-album" "为你的收藏安放一个家"
      ShowWindow $mui.WelcomePage.Title ${SW_HIDE}
      !insertmacro ACG_MOVE_CONTROL $mui.WelcomePage $mui.WelcomePage.Image 0 0 90 140
      ${NSD_FreeImage} $mui.WelcomePage.Image.Bitmap
      ${NSD_SetStretchedImage} $mui.WelcomePage.Image "$PLUGINSDIR\modern-wizard.bmp" $mui.WelcomePage.Image.Bitmap
      !insertmacro ACG_MOVE_CONTROL $mui.WelcomePage $mui.WelcomePage.Text 104 8 196 126
    ${EndIf}
    SetCtlColors $mui.WelcomePage.Text "${ACG_SOFT}" "${ACG_SURFACE}"
    Call AcgThemeButtons
    System::Store L
  FunctionEnd
!macroend

!macro customPageAfterChangeDir
  ; This hook intentionally declares no page. The default directory result and
  ; builder's instFilesPre path sanitization remain untouched.
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW AcgProgressShow
!macroend

!macro customFinishPage
  ; Match assistedInstaller.nsh's launch semantics exactly: run only according
  ; to MUI's checkbox, as the interactive user, with --updated when appropriate.
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW AcgFinishShow
  !define MUI_FINISHPAGE_TITLE "ACG-album 已安装"
  !define MUI_FINISHPAGE_TEXT "相册已准备就绪。$\r$\n$\r$\n点击完成结束安装，可按下方选项打开相册。"
  !insertmacro MUI_PAGE_FINISH

  Function AcgProgressShow
    SetCtlColors $mui.InstFilesPage "${ACG_TEXT}" "${ACG_SURFACE}"
    SetCtlColors $mui.InstFilesPage.Text "${ACG_SOFT}" "${ACG_SURFACE}"
    SetCtlColors $mui.InstFilesPage.Log "${ACG_TEXT}" "${ACG_SURFACE}"
    ; COLORREF uses BGR order. Keep high-contrast rendering under Windows.
    ${IfNot} ${IsHighContrastModeActive}
      System::Call 'uxtheme::SetWindowTheme(p $mui.InstFilesPage.ProgressBar, w "", w "")i'
      SendMessage $mui.InstFilesPage.ProgressBar 0x0409 0 0x008346C6
      SendMessage $mui.InstFilesPage.ProgressBar 0x2001 0 0x00FCF7F7
    ${EndIf}
    ; The real NSIS progress bar remains responsible for progress and errors.
    Call AcgThemeButtons
  FunctionEnd

  Function AcgFinishShow
    System::Store S
    Push $mui.FinishPage
    Call AcgThemeContentFrame
    ${If} $AcgContentFramed != 0
      Call muiPageUnloadFullWindow
      !insertmacro MUI_HEADER_TEXT "ACG-album 已安装" "收藏，在这里相遇"
      ShowWindow $mui.FinishPage.Title ${SW_HIDE}
      !insertmacro ACG_MOVE_CONTROL $mui.FinishPage $mui.FinishPage.Image 0 0 90 140
      ${NSD_FreeImage} $mui.FinishPage.Image.Bitmap
      ${NSD_SetStretchedImage} $mui.FinishPage.Image "$PLUGINSDIR\modern-wizard.bmp" $mui.FinishPage.Image.Bitmap
      !insertmacro ACG_MOVE_CONTROL $mui.FinishPage $mui.FinishPage.Text 104 8 196 64
      ; Preserve MUI's reboot/checkbox semantics; only move existing controls.
      ${If} ${RebootFlag}
        !insertmacro ACG_MOVE_CONTROL $mui.FinishPage $mui.FinishPage.RebootNow 104 80 196 16
        !insertmacro ACG_MOVE_CONTROL $mui.FinishPage $mui.FinishPage.RebootLater 104 102 196 16
      ${Else}
        !ifndef HIDE_RUN_AFTER_FINISH
          !insertmacro ACG_MOVE_CONTROL $mui.FinishPage $mui.FinishPage.Run 104 80 196 18
        !endif
      ${EndIf}
    ${EndIf}
    SetCtlColors $mui.FinishPage.Text "${ACG_SOFT}" "${ACG_SURFACE}"
    Call AcgThemeButtons
    System::Store L
  FunctionEnd
!macroend
!endif

; Native control colors for electron-builder 26.8.1 / cached NSIS MUI2 2.1.
; Included after MUI2 and the ACG palette, before builder declares its pages.
!ifndef ACG_NATIVE_INSTALLER_THEME
!define ACG_NATIVE_INSTALLER_THEME

Var AcgThemeHighContrast
Var AcgThemeFace
Var AcgThemeFaceText
Var AcgThemeInput
Var AcgThemeInputText
Var AcgThemeDisabledText

; MUI's stock dispatcher consumes each callback after inserting it. Keep that
; behavior for PRE/SHOW/LEAVE/DESTROYED, adding colors only at the SHOW boundary.
; In particular, do not replace builder's instFilesPre or install-mode LEAVE.
!macroundef MUI_PAGE_FUNCTION_CUSTOM
!macro MUI_PAGE_FUNCTION_CUSTOM TYPE
  !if "${TYPE}" == "SHOW"
    ; multiUserUi.nsh uses MUI_PAGE_INIT even in its uninstaller pass, so select
    ; the function namespace from the pass rather than the current MUI prefix.
    !ifdef BUILD_UNINSTALLER
      Call un.AcgThemePage
    !else
      Call AcgThemePage
    !endif
  !endif
  !ifdef MUI_PAGE_CUSTOMFUNCTION_${TYPE}
    Call "${MUI_PAGE_CUSTOMFUNCTION_${TYPE}}"
    !undef MUI_PAGE_CUSTOMFUNCTION_${TYPE}
  !endif
!macroend

; GetSysColor returns COLORREF (00BBGGRR), SetCtlColors takes an RRGGBB string.
; The enclosing theme function saves these scratch registers for its caller.
!macro ACG_THEME_SYSTEM_COLOR INDEX OUT
  System::Call 'user32::GetSysColor(i ${INDEX})i.r0'
  IntOp $1 $0 & 0x0000FF
  IntOp $1 $1 << 16
  IntOp $2 $0 & 0x00FF00
  IntOp $1 $1 | $2
  IntOp $0 $0 >> 16
  IntOp $0 $0 & 0x0000FF
  IntOp $0 $0 | $1
  IntFmt ${OUT} "%06X" $0
!macroend

; Instantiate the ordinary functions in both builder passes (.onGUIInit exists
; in both), and the un. functions only when BUILD_UNINSTALLER is defined.
!macro ACG_THEME_FUNCTIONS PREFIX
Function ${PREFIX}AcgThemePage
  System::Store S
  StrCpy $AcgThemeHighContrast 0
  StrCpy $AcgThemeFace "${ACG_SURFACE}"
  StrCpy $AcgThemeFaceText "${ACG_TEXT}"
  StrCpy $AcgThemeInput "${ACG_SURFACE}"
  StrCpy $AcgThemeInputText "${ACG_TEXT}"
  !insertmacro ACG_THEME_SYSTEM_COLOR 17 $AcgThemeDisabledText ; COLOR_GRAYTEXT
  ${If} ${IsHighContrastModeActive}
    StrCpy $AcgThemeHighContrast 1
    !insertmacro ACG_THEME_SYSTEM_COLOR 15 $AcgThemeFace ; COLOR_BTNFACE
    !insertmacro ACG_THEME_SYSTEM_COLOR 18 $AcgThemeFaceText ; COLOR_BTNTEXT
    !insertmacro ACG_THEME_SYSTEM_COLOR 5 $AcgThemeInput ; COLOR_WINDOW
    !insertmacro ACG_THEME_SYSTEM_COLOR 8 $AcgThemeInputText ; COLOR_WINDOWTEXT
  ${EndIf}
  Push $HWNDPARENT
  Call ${PREFIX}AcgThemeTree
  System::Store L
FunctionEnd

; Walk only already-created descendants of our dialog; no control creation,
; subclassing, style changes, focus changes or callbacks are performed here.
; All HWNDs use pointer-sized arguments. Preserve every scratch register and
; the NSIS stack at each recursion level, including the saved next sibling.
Function ${PREFIX}AcgThemeTree
  Exch $0
  System::Store S
  System::Call 'user32::IsWindow(p r0)i.r2'
  ${If} $2 != 0
    System::Call 'user32::GetClassNameW(p r0, w .r1, i ${NSIS_MAX_STRLEN})i.r2'
    StrCpy $5 0
    StrCpy $6 $AcgThemeFaceText
    StrCpy $7 $AcgThemeFace
    ${If} $2 != 0
      ${If} $1 == "#32770"
        StrCpy $5 1
      ${ElseIf} $1 == "Static"
        System::Call 'user32::GetWindowLongW(p r0, i -16)i.r3'
        IntOp $4 $3 & 0x1F ; SS_TYPEMASK
        ; Text/simple background statics only. Do not touch icons, bitmaps,
        ; metafiles, owner-drawn statics or the native etched separators.
        ${If} $4 <= 12
        ${AndIf} $4 != 3
        ${AndIf} $4 != 10
          StrCpy $5 1
        ${EndIf}
      ${ElseIf} $1 == "Edit"
        StrCpy $5 1
        StrCpy $6 $AcgThemeInputText
        StrCpy $7 $AcgThemeInput
        ${If} $AcgThemeHighContrast == 1
          System::Call 'user32::GetWindowLongW(p r0, i -16)i.r3'
          IntOp $4 $3 & 0x08000800 ; WS_DISABLED | ES_READONLY
          ${If} $4 != 0
            StrCpy $6 $AcgThemeFaceText
            StrCpy $7 $AcgThemeFace
          ${EndIf}
        ${EndIf}
      ${ElseIf} $1 == "Button"
        System::Call 'user32::GetWindowLongW(p r0, i -16)i.r3'
        IntOp $4 $3 & 0x0F ; BS_TYPEMASK
        ${If} $4 == 2 ; BS_CHECKBOX
        ${OrIf} $4 == 3 ; BS_AUTOCHECKBOX
        ${OrIf} $4 == 4 ; BS_RADIOBUTTON
        ${OrIf} $4 == 5 ; BS_3STATE
        ${OrIf} $4 == 6 ; BS_AUTO3STATE
        ${OrIf} $4 == 7 ; BS_GROUPBOX
        ${OrIf} $4 == 9 ; BS_AUTORADIOBUTTON
          IntOp $3 $3 & 0x1000 ; Leave BS_PUSHLIKE controls native, too.
          ${If} $3 == 0
            StrCpy $5 1
            ${If} $AcgThemeHighContrast == 1
            ${AndIf} $4 != 7
              ; Match MUI2 Finish.nsh's HC-only workaround for bug #443:
              ; themed check/radio text ignores SetCtlColors. Keep normal
              ; themes, push buttons, default buttons and elevation shields.
              System::Call 'uxtheme::SetWindowTheme(p r0, w " ", w " ")i'
            ${EndIf}
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ${If} $5 == 1
      System::Call 'user32::IsWindowEnabled(p r0)i.r2'
      ${If} $2 == 0
        StrCpy $6 $AcgThemeDisabledText
      ${EndIf}
      SetCtlColors $0 $6 $7
    ${EndIf}

    System::Call 'user32::GetWindow(p r0, i 5)p.r1' ; GW_CHILD
    ${While} $1 != 0
      System::Call 'user32::GetWindow(p r1, i 2)p.r2' ; GW_HWNDNEXT
      Push $1
      Call ${PREFIX}AcgThemeTree
      StrCpy $1 $2
    ${EndWhile}
  ${EndIf}
  System::Store L
  Pop $0
FunctionEnd
!macroend

!endif

!include "FileFunc.nsh"

!macro customInstall
  # Do not grant sandbox access to a drive root or through an install-directory junction.
  ${GetRoot} "$INSTDIR" $R8
  GetFullPathName $R9 "$INSTDIR"
  StrCmp $R9 $R8 caelushInstallAclInvalidPath

  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 caelushInstallAclInvalidPath
  IfFileExists "$INSTDIR\icudtl.dat" 0 caelushInstallAclInvalidPath
  IfFileExists "$INSTDIR\resources\app.asar" 0 caelushInstallAclInvalidPath

  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.r8'
  IntOp $R8 $R8 & 0x400
  IntCmp $R8 0 caelushInstallAclPathSafe caelushInstallAclInvalidPath caelushInstallAclInvalidPath

caelushInstallAclPathSafe:
  # The parent ACE is inherited by the already-extracted app files without a recursive scan.
  ClearErrors
  ExecWait '"$SYSDIR\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-1:(OI)(CI)(RX)"' $0
  IfErrors caelushInstallAclCommandFailed
  StrCmp $0 "0" caelushInstallAclSucceeded caelushInstallAclFailed

caelushInstallAclInvalidPath:
  StrCpy $1 "refusing an invalid, linked, or drive-root install directory"
  Goto caelushInstallAclReportFailure

caelushInstallAclCommandFailed:
  StrCpy $1 "Windows icacls.exe could not be started"
  Goto caelushInstallAclReportFailure

caelushInstallAclFailed:
  StrCpy $1 "icacls.exe returned exit code $0"
  Goto caelushInstallAclReportFailure

caelushInstallAclSucceeded:
  FileOpen $R7 "$TEMP\Caelush-install-permissions.log" w
  IfErrors caelushInstallAclDone
  FileWrite $R7 "Result: success; sandbox RX access added to the install directory.$\r$\n"
  FileWrite $R7 "Install directory: $INSTDIR$\r$\n"
  FileClose $R7
  Goto caelushInstallAclDone

caelushInstallAclReportFailure:
  FileOpen $R7 "$TEMP\Caelush-install-permissions.log" w
  IfErrors caelushInstallAclShowFailure
  FileWrite $R7 "Result: failure while setting sandbox read access.$\r$\n"
  FileWrite $R7 "Install directory: $INSTDIR$\r$\n"
  FileWrite $R7 "Reason: $1$\r$\n"
  FileClose $R7

caelushInstallAclShowFailure:
  ${If} ${Silent}
    SetErrorLevel 1
    Abort
  ${Else}
    MessageBox MB_ICONSTOP|MB_OK "Caelush 安装目录权限设置失败，程序可能无法启动。$\r$\n$\r$\n目录：$INSTDIR$\r$\n原因：$1$\r$\n日志：$TEMP\Caelush-install-permissions.log"
    SetErrorLevel 1
    Abort
  ${EndIf}

caelushInstallAclDone:
!macroend

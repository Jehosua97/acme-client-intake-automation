Option Explicit

Dim fileSystem, shell, scriptsRoot, supervisorPath, nodePath, npmPath, command, exitCode
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

If WScript.Arguments.Count < 2 Then WScript.Quit 2

scriptsRoot = fileSystem.GetParentFolderName(WScript.ScriptFullName)
supervisorPath = fileSystem.BuildPath(scriptsRoot, "start-windows-supervisor.ps1")
nodePath = WScript.Arguments(0)
npmPath = WScript.Arguments(1)

If Not fileSystem.FileExists(supervisorPath) Then WScript.Quit 3
If Not fileSystem.FileExists(nodePath) Then WScript.Quit 4
If Not fileSystem.FileExists(npmPath) Then WScript.Quit 5

shell.CurrentDirectory = fileSystem.GetParentFolderName(scriptsRoot)
command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass " & _
  "-WindowStyle Hidden -File """ & supervisorPath & """ -NodePath """ & _
  nodePath & """ -NpmPath """ & npmPath & """"
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

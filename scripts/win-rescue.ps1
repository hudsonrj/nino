# Ressgata janelas do WSLg que nascem fora da tela.
#
# O WSLg posiciona as janelas do Linux num sistema de coordenadas próprio,
# diferente do Windows, e elas acabam fora da área visível. Este script
# encontra a janela pelo título e a move para um canto conhecido do monitor.
#
#   powershell -ExecutionPolicy Bypass -File win-rescue.ps1 -Titulo "Nino"

param(
  [string]$Titulo = 'Nino',
  [int]$Largura = 480,
  [int]$Altura  = 720,
  [int]$Margem  = 24
)

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class NinoWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@

# Área de trabalho real, segundo o Windows.
Add-Type -AssemblyName System.Windows.Forms
$tela = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea

$alvos = New-Object System.Collections.ArrayList
$cb = [NinoWin+EnumProc]{
  param($h, $l)
  $sb = New-Object System.Text.StringBuilder 512
  [NinoWin]::GetWindowText($h, $sb, 512) | Out-Null
  $t = $sb.ToString()
  if ($t -like "*$Titulo*") { [void]$alvos.Add(@{ H = $h; T = $t }) }
  return $true
}
[NinoWin]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

if ($alvos.Count -eq 0) {
  Write-Output "NENHUMA janela encontrada com o titulo '$Titulo'"
  exit 1
}

$x = $tela.X + $tela.Width  - $Largura - $Margem
$y = $tela.Y + $tela.Height - $Altura  - $Margem
# SWP_SHOWWINDOW(0x40) | SWP_NOACTIVATE(0x10)
$flags = 0x0050
# HWND_TOPMOST
$topmost = [IntPtr](-1)

foreach ($a in $alvos) {
  $antes = New-Object NinoWin+RECT
  [NinoWin]::GetWindowRect($a.H, [ref]$antes) | Out-Null
  [NinoWin]::ShowWindow($a.H, 9) | Out-Null   # SW_RESTORE
  [NinoWin]::SetWindowPos($a.H, $topmost, $x, $y, $Largura, $Altura, $flags) | Out-Null
  $depois = New-Object NinoWin+RECT
  [NinoWin]::GetWindowRect($a.H, [ref]$depois) | Out-Null
  Write-Output ("MOVIDA '{0}': antes=({1},{2}) depois=({3},{4}) tamanho={5}x{6}" -f `
    $a.T, $antes.Left, $antes.Top, $depois.Left, $depois.Top, `
    ($depois.Right - $depois.Left), ($depois.Bottom - $depois.Top))
}

Write-Output ("TELA: {0}x{1} em ({2},{3})" -f $tela.Width, $tela.Height, $tela.X, $tela.Y)

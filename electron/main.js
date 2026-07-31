'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const { PosPrinter } = require('electron-pos-printer');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let win = null;

// ---------------------------------------------------------------------------
// Direct USB writing (bypasses the Windows spooler + vendor printer driver).
// Many cheap thermal receipt printers (e.g. "POS-80") silently swallow RAW
// jobs routed through the print spooler, while writing directly to the USB
// device interface delivers the ESC/POS bytes reliably.
// ---------------------------------------------------------------------------

const USB_RAW_PS1 = path.join(os.tmpdir(), 'bistro_usb_raw.ps1');

function writeUsbScript() {
  if (fs.existsSync(USB_RAW_PS1)) return;
  const script = String.raw`param([string]$B64File, [string]$PrinterName)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class BistroUsbNative {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr CreateFile(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool WriteFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToWrite, out uint lpNumberOfBytesWritten, IntPtr lpOverlapped);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr hObject);
}
"@

$bytes = [System.Convert]::FromBase64String([System.IO.File]::ReadAllText($B64File).Trim())
$guid = '28D78FAD-5A12-11D1-AE5B-0000F803A8C2'

function Get-UsbPath([string]$usbInst) {
  return '\\?\' + $usbInst.Replace('\', '#') + '#{' + $guid + '}'
}

function Write-ToUsb([string]$usbInst) {
  $path = Get-UsbPath $usbInst
  $h = [BistroUsbNative]::CreateFile($path, 0x40000000, 0, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
  if ($h -eq [IntPtr]::Zero -or $h -eq [IntPtr](-1)) { return $false }
  try {
    $w = 0
    $ok = [BistroUsbNative]::WriteFile($h, $bytes, [uint32]$bytes.Length, [ref]$w, [IntPtr]::Zero)
    return ($ok -and $w -eq $bytes.Length)
  } finally {
    [BistroUsbNative]::CloseHandle($h) | Out-Null
  }
}

$candidates = @()
if ($PrinterName) {
  $norm = ($PrinterName -replace '[^a-z0-9]', '').ToLower()
  $swDevs = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like 'USBPRINT\*' }
  foreach ($d in $swDevs) {
    $instName = ($d.InstanceId.Substring(9) -replace '[^a-z0-9]', '').ToLower()
    $friendly = ($d.FriendlyName -replace '[^a-z0-9]', '').ToLower()
    if ($norm.Contains($instName) -or $instName.Contains($norm) -or $norm.Contains($friendly) -or $friendly.Contains($norm)) {
      $parent = (Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_Parent' -ErrorAction SilentlyContinue).Data
      if ($parent -and $parent -like 'USB\*') { $candidates += $parent }
    }
  }
}
if ($candidates.Count -eq 0) {
  $candidates = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
    Where-Object { $_.Class -eq 'USB' -and $_.InstanceId -match 'VID_[0-9A-F]{4}&PID_[0-9A-F]{4}' -and (($_.FriendlyName + ' ' + $_.InstanceId) -match 'print|pos|thermal|receipt|80') } |
    Select-Object -ExpandProperty InstanceId)
}
$seen = @{}
foreach ($c in $candidates) {
  if ($seen[$c]) { continue }
  $seen[$c] = $true
  if (Write-ToUsb $c) {
    Write-Output ('USBOK ' + $c)
    exit 0
  }
}
Write-Output 'NOUSB'
exit 1
`;
  try { fs.writeFileSync(USB_RAW_PS1, script); } catch (err) { console.error('Failed to write USB script:', err); }
}

/**
 * Sends raw ESC/POS bytes directly to a USB receipt printer by resolving the
 * USB device behind the named Windows printer (or any printer-like USB
 * device as a fallback). Resolves with { ok, method, device } on success.
 */
function runUsbRaw(bytesBase64, deviceName) {
  return new Promise((resolve, reject) => {
    writeUsbScript();
    const b64File = path.join(os.tmpdir(), 'bistro_print_' + process.pid + '_' + Date.now() + '.b64');
    try {
      fs.writeFileSync(b64File, bytesBase64);
    } catch (err) {
      reject(err);
      return;
    }
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', USB_RAW_PS1, b64File, deviceName || ''], { windowsHide: true });
    let out = '';
    let errOut = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { errOut += d.toString(); });
    child.on('error', err => {
      try { fs.unlinkSync(b64File); } catch (e) { /* ignore */ }
      reject(err);
    });
    child.on('close', () => {
      try { fs.unlinkSync(b64File); } catch (e) { /* ignore */ }
      const m = out.match(/USBOK (.+)/);
      if (m) {
        resolve({ ok: true, method: 'usb-direct', device: m[1] });
      } else {
        reject(new Error((errOut || out || 'تعذر الكتابة مباشرة على جهاز USB').trim().slice(0, 300)));
      }
    });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    title: 'Bistro POS',
    autoHideMenuBar: true,
    backgroundColor: '#f7f5f0',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'index.html'));

  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/**
 * IPC: print:raw
 * Sends raw ESC/POS bytes to a network printer (IP:port, usually 9100).
 * Job: { ip, port, bytesBase64, timeout }
 */
ipcMain.handle('print:raw', (event, job) => {
  return new Promise((resolve, reject) => {
    const ip = String((job && job.ip) || '').trim();
    const port = Number(job && job.port) || 9100;
    const bytes = Buffer.from((job && job.bytesBase64) || '', 'base64');

    if (!ip || !bytes.length) {
      reject(new Error('بيانات الطباعة غير صحيحة (IP أو محتوى مفقود).'));
      return;
    }

    const timeoutMs = Number(job.timeout) || 8000;
    const sock = net.connect({ host: ip, port });
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        sock.destroy();
        reject(new Error(`انتهت مهلة الاتصال بالطابعة ${ip}:${port}. تحقق من عنوان IP وشبكة الطابعة.`));
      }
    }, timeoutMs);

    sock.on('connect', () => {
      sock.write(bytes, () => {
        clearTimeout(timer);
        settled = true;
        sock.end();
        resolve({ ok: true, sent: bytes.length, device: ip + ':' + port });
      });
    });

    sock.on('error', err => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(`تعذر الاتصال بالطابعة ${ip}:${port} - ${String(err.message || err)}`));
      }
    });
  });
});

/**
 * IPC: print:list
 * Lists the printers installed on Windows (deviceName/displayName/status).
 */
ipcMain.handle('print:list', async () => {
  if (!win) return [];
  try {
    const printers = await win.webContents.getPrintersAsync();
    return (printers || []).map(p => ({
      name: p.name || '',
      displayName: p.displayName || p.name || '',
      status: p.status || 0
    }));
  } catch (err) {
    console.error('Failed to list printers:', err);
    return [];
  }
});

/**
 * IPC: print:windows-raw
 * Sends raw ESC/POS bytes to a printer installed in Windows. Tries a direct
 * USB write first (bypasses the spooler + vendor driver, which swallow RAW
 * jobs on many thermal receipt printers), then falls back to the print
 * spooler (System.Printing via PowerShell).
 * Job: { deviceName, bytesBase64 }
 */
ipcMain.handle('print:windows-raw', async (event, job) => {
  const deviceName = job && job.deviceName;
  const bytesBase64 = job && job.bytesBase64;
  if (!deviceName || !bytesBase64) {
    throw new Error('بيانات الطباعة غير مكتملة (deviceName أو bytesBase64 مفقود).');
  }
  const bytes = Buffer.from(bytesBase64, 'base64');
  if (!bytes.length) {
    throw new Error('محتوى الطباعة فارغ.');
  }
  try {
    const res = await runUsbRaw(bytesBase64, deviceName);
    return res;
  } catch (usbErr) {
    try {
      await PosPrinter.sendRawCommand(deviceName, bytes);
      return { ok: true, method: 'spooler', device: deviceName };
    } catch (err) {
      throw new Error(`تعذر الطباعة على الطابعة "${deviceName}" - ${String(err.message || err)}`);
    }
  }
});

/**
 * IPC: print:usb-direct
 * Sends raw ESC/POS bytes directly to a USB receipt printer, bypassing the
 * Windows spooler and the vendor driver entirely.
 * Job: { deviceName, bytesBase64 }
 */
ipcMain.handle('print:usb-direct', async (event, job) => {
  const deviceName = job && job.deviceName;
  const bytesBase64 = job && job.bytesBase64;
  if (!bytesBase64) {
    throw new Error('بيانات الطباعة غير مكتملة (bytesBase64 مفقود).');
  }
  return runUsbRaw(bytesBase64, deviceName || '');
});

/**
 * IPC: print:silent
 * Prints an HTML document silently to a specific Windows printer (deviceName).
 * Options: { deviceName, html }
 */
ipcMain.handle('print:silent', async (event, opts) => {
  const deviceName = opts && opts.deviceName;
  const html = opts && opts.html;
  const copies = Math.max(1, Math.min(10, Number((opts && opts.copies) || 1)));
  if (!deviceName || !html) {
    throw new Error('بيانات الطباعة الصامتة غير مكتملة (deviceName أو html مفقود).');
  }

  const printWin = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });

  try {
    await printWin.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(html));
    // Measure the actual content height (in CSS px) and convert to microns so
    // the driver gets an explicit page that fits the receipt exactly.
    // Width is 72mm: an 80mm thermal roll prints a 72mm printable area
    // (576 dots @203dpi) — a wider page clips the right edge of RTL text.
    const heightMicrons = await printWin.webContents.executeJavaScript(`
      (async () => {
        try { await document.fonts.ready; } catch (e) {}
        const h = Math.max(
          document.body ? document.body.scrollHeight : 0,
          document.documentElement ? document.documentElement.scrollHeight : 0
        );
        const microns = Math.ceil(h * (25.4 / 96) * 1000);
        return Math.max(50000, Math.min(600000, microns + 15000));
      })()
    `);
    const pageSize = { width: 72000, height: heightMicrons };
    for (let i = 0; i < copies; i++) {
      const result = await new Promise((resolve) => {
        printWin.webContents.print({
          silent: true,
          deviceName: deviceName,
          printBackground: true,
          pageSize: pageSize
        }, (success, failureReason) => resolve({ success, failureReason }));
      });
      if (!result.success) {
        throw new Error(`رُفضت الطباعة على الطابعة "${deviceName}". تأكد من أنها مثبتة ومتصلة في Windows.` + (result.failureReason ? ` (${result.failureReason})` : ''));
      }
    }
    return { ok: true, device: deviceName, copies: copies };
  } finally {
    printWin.destroy();
  }
});

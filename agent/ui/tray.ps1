# Content Blocker Agent - tray icon.
# Runs in the logged-in user's session (started at logon from the HKLM Run key
# and once right after install). It only DISPLAYS state read from status.txt,
# which the Windows service writes. There is deliberately no "Exit", "Disable"
# or "Uninstall" item: the protection itself is the service, so closing or
# killing this icon never unblocks anything.
# The one thing it can ask the service to do is "check for an update now": it
# drops update-request.txt in the logs folder and shows the answer the service
# writes to update-result.txt (the service itself runs as SYSTEM and does the
# real download + SHA-256 check + install, see agent/src/updater.js).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::CatchException)

$script:Self      = $PSCommandPath
$script:AppDir    = Split-Path -Parent $PSCommandPath
$script:Assets    = Join-Path $script:AppDir 'assets'
$script:LogDir    = 'C:\Users\Public\Documents\ContentBlockerLogs'
$script:StatusPath = Join-Path $script:LogDir 'status.txt'
$script:RequestPath = Join-Path $script:LogDir 'update-request.txt'
$script:ResultPath  = Join-Path $script:LogDir 'update-result.txt'
$script:AppName   = 'Content Blocker Agent'

# One tray icon per user session.
$createdNew = $false
$script:Mutex = New-Object System.Threading.Mutex($true, 'Local\ContentBlockerTray', [ref]$createdNew)
if (-not $createdNew) { exit }

# Loads an image WITHOUT keeping the file open. [Image]::FromFile locks the file for as
# long as the image object lives, which made the installer fail on updates with
# "DeleteFile failed; code 32" (logo-128.png in use). A copy in memory has no lock.
function Load-ImageNoLock([string]$path) {
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $ms = New-Object System.IO.MemoryStream(,$bytes)
    try {
        $img = [System.Drawing.Image]::FromStream($ms)
        try { return (New-Object System.Drawing.Bitmap($img)) } finally { $img.Dispose() }
    } finally { $ms.Dispose() }
}

function Load-Icon([string]$name) {
    $p = Join-Path $script:Assets $name
    return New-Object System.Drawing.Icon($p, [System.Windows.Forms.SystemInformation]::SmallIconSize)
}
$script:IconOk       = Load-Icon 'tray-ok.ico'
$script:IconUnlocked = Load-Icon 'tray-unlocked.ico'
$script:IconWarn     = Load-Icon 'tray-warn.ico'
$script:IconMain     = New-Object System.Drawing.Icon((Join-Path $script:Assets 'icon.ico'))

function Read-Status {
    $h = @{}
    try {
        $lines = Get-Content -LiteralPath $script:StatusPath -Encoding UTF8 -ErrorAction Stop
        foreach ($line in $lines) {
            $i = $line.IndexOf('=')
            if ($i -gt 0) { $h[$line.Substring(0, $i)] = $line.Substring($i + 1) }
        }
    } catch { }
    return $h
}

function Read-KvFile([string]$path) {
    $h = @{}
    try {
        foreach ($line in (Get-Content -LiteralPath $path -Encoding UTF8 -ErrorAction Stop)) {
            $i = $line.IndexOf('=')
            if ($i -gt 0) { $h[$line.Substring(0, $i)] = $line.Substring($i + 1) }
        }
    } catch { }
    return $h
}

function Parse-Utc([string]$text) {
    try {
        return [datetime]::Parse($text, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
    } catch { return $null }
}

# Kind: ok (green) | unlocked (amber) | down (red)
function Get-State {
    $s = Read-Status
    $r = @{ Kind = 'down'; Title = 'שירות ההגנה אינו פעיל'; Detail = 'לא התקבל עדכון מהשירות'; Data = $s }
    if (-not $s.ContainsKey('updated')) { return $r }
    $updated = Parse-Utc $s['updated']
    if ($null -eq $updated) { return $r }
    $age = ((Get-Date).ToUniversalTime() - $updated).TotalSeconds
    if ($age -gt 120) { return $r }

    if ($s['blocking'] -eq '1') {
        $r.Kind = 'ok'
        $r.Title = 'ההגנה פעילה'
        $r.Detail = 'קבצי וידאו ונגנים חסומים במחשב זה'
        if ($s['server_ok'] -eq '0') { $r.Detail = 'ההגנה פעילה (אין כרגע חיבור לשרת, הגדרות אחרונות בתוקף)' }
    } else {
        $r.Kind = 'unlocked'
        $r.Title = 'ההגנה שוחררה זמנית'
        $until = $null
        if ($s.ContainsKey('unlocked_until') -and $s['unlocked_until']) { $until = Parse-Utc $s['unlocked_until'] }
        if ($until) { $r.Detail = 'החסימה תחזור אוטומטית בשעה ' + $until.ToLocalTime().ToString('HH:mm') }
        else { $r.Detail = 'החסימה תחזור אוטומטית בקרוב' }
    }
    return $r
}

function Get-NumberText($data) {
    $n = $data['device_number']
    if ($n) { return ('מחשב מספר ' + $n) }
    return 'מספר המחשב: עדיין לא נקבע'
}

# The computer number is announced once (per number) so the person at this PC
# knows what to say when asking for an unlock. Remembered per Windows user.
$script:AnnounceFile = Join-Path $env:LOCALAPPDATA 'ContentBlockerTray\announced-number.txt'
function Announce-NumberOnce($data) {
    $n = $data['device_number']
    if (-not $n) { return }
    $prev = ''
    try { if (Test-Path -LiteralPath $script:AnnounceFile) { $prev = (Get-Content -LiteralPath $script:AnnounceFile -Raw).Trim() } } catch { }
    if ($prev -eq $n) { return }
    Show-Balloon $script:AppName ('מספר המחשב הזה בדשבורד: ' + $n + '. כשמבקשים פתיחה, ציינו את המספר.') 'Info'
    try {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $script:AnnounceFile) | Out-Null
        Set-Content -LiteralPath $script:AnnounceFile -Value $n -Encoding ASCII
    } catch { }
}

# ---------- tray icon + menu ----------
$script:Notify = New-Object System.Windows.Forms.NotifyIcon
$script:Notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.RightToLeft = [System.Windows.Forms.RightToLeft]::Yes

$script:MiStatus = New-Object System.Windows.Forms.ToolStripMenuItem
$script:MiStatus.Enabled = $false
$script:MiStatus.Font = New-Object System.Drawing.Font($script:MiStatus.Font, [System.Drawing.FontStyle]::Bold)
[void]$menu.Items.Add($script:MiStatus)
$script:MiNumber = New-Object System.Windows.Forms.ToolStripMenuItem
$script:MiNumber.Enabled = $false
$script:MiNumber.Font = New-Object System.Drawing.Font($script:MiNumber.Font.FontFamily, 11, [System.Drawing.FontStyle]::Bold)
[void]$menu.Items.Add($script:MiNumber)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$miAbout = New-Object System.Windows.Forms.ToolStripMenuItem('אודות')
$miDash  = New-Object System.Windows.Forms.ToolStripMenuItem('פתח את הדשבורד בדפדפן')
$miLogs  = New-Object System.Windows.Forms.ToolStripMenuItem('פתח את תיקיית היומנים (לוגים)')
$miCopy  = New-Object System.Windows.Forms.ToolStripMenuItem('העתק פרטי מחשב (לשליחה בהודעה)')
$miRefresh = New-Object System.Windows.Forms.ToolStripMenuItem('רענן סטטוס')
$script:MiUpdate = New-Object System.Windows.Forms.ToolStripMenuItem('בדוק עדכון עכשיו')
[void]$menu.Items.Add($miAbout)
[void]$menu.Items.Add($miDash)
[void]$menu.Items.Add($miLogs)
[void]$menu.Items.Add($miCopy)
[void]$menu.Items.Add($miRefresh)
[void]$menu.Items.Add($script:MiUpdate)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$script:MiVersion = New-Object System.Windows.Forms.ToolStripMenuItem($script:AppName)
$script:MiVersion.Enabled = $false
[void]$menu.Items.Add($script:MiVersion)
$script:Notify.ContextMenuStrip = $menu

function Open-Dashboard {
    $url = (Read-Status)['dashboard_url']
    if ($url) { Start-Process $url } else { Show-Balloon 'הדשבורד' 'כתובת הדשבורד עדיין לא ידועה, נסו שוב בעוד רגע.' 'Warning' }
}

function Show-Balloon([string]$title, [string]$text, [string]$kind) {
    try {
        $script:Notify.BalloonTipTitle = $title
        $script:Notify.BalloonTipText = $text
        $script:Notify.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::$kind
        $script:Notify.ShowBalloonTip(6000)
    } catch { }
}

$script:LastKind = $null
function Update-Ui([bool]$quiet) {
    $st = Get-State
    switch ($st.Kind) {
        'ok'       { $script:Notify.Icon = $script:IconOk }
        'unlocked' { $script:Notify.Icon = $script:IconUnlocked }
        default    { $script:Notify.Icon = $script:IconWarn }
    }
    $numText = Get-NumberText $st.Data
    $shortNum = ''
    if ($st.Data['device_number']) { $shortNum = 'מחשב ' + $st.Data['device_number'] + ' | ' }
    $tip = $shortNum + $st.Title
    if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }   # NotifyIcon.Text hard limit
    $script:Notify.Text = $tip
    $script:MiStatus.Text = $st.Title
    $script:MiNumber.Text = $numText
    Announce-NumberOnce $st.Data
    $ver = $st.Data['version']
    if ($ver) { $script:MiVersion.Text = $script:AppName + '  v' + $ver }
    # After an auto-update the installer replaces tray.ps1 but cannot restart the
    # icon in the user's session. This running copy is the old script, so when the
    # service reports a different version it starts a fresh copy of itself.
    if ($ver -and -not $script:StartVersion) { $script:StartVersion = $ver }
    elseif ($ver -and $script:StartVersion -and $ver -ne $script:StartVersion) { Restart-Tray $ver }

    if ((-not $quiet) -and $null -ne $script:LastKind -and $script:LastKind -ne $st.Kind) {
        switch ($st.Kind) {
            'ok'       { Show-Balloon $script:AppName 'ההגנה הופעלה מחדש' 'Info' }
            'unlocked' { Show-Balloon $script:AppName ($st.Title + '. ' + $st.Detail) 'Info' }
            default    { Show-Balloon $script:AppName 'שימו לב: שירות ההגנה אינו פעיל' 'Warning' }
        }
    }
    $script:LastKind = $st.Kind
    return $st
}

# ---------- restart after update ----------
function Restart-Tray([string]$newVersion) {
    try {
        # Per-user note for the NEW copy of the tray: it shows "updated" as a balloon.
        try {
            $noteDir = Join-Path $env:LOCALAPPDATA 'ContentBlockerTray'
            New-Item -ItemType Directory -Force -Path $noteDir | Out-Null
            Set-Content -LiteralPath (Join-Path $noteDir 'updated.txt') -Value ($script:StartVersion + '|' + $newVersion) -Encoding UTF8
        } catch { }
        $vbs = Join-Path $script:AppDir 'ps-hidden.vbs'
        if (-not (Test-Path -LiteralPath $vbs)) { return }
        $script:Notify.Visible = $false
        try { $script:Mutex.ReleaseMutex() } catch { }   # let the new copy take the single-instance mutex
        Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + $vbs + '" tray.ps1') -WorkingDirectory $script:AppDir
        $script:Ctx.ExitThread()
    } catch { }
}

# ---------- "check for update now" ----------
$script:UpdateSince = $null      # UTC time of the pending request, $null when none is pending
$script:UpdateStage = ''
$script:UpdateDeadline = $null

function Finish-UpdateCheck {
    $script:UpdateSince = $null
    $script:UpdateStage = ''
    $script:UpdateTimer.Stop()
    $script:MiUpdate.Enabled = $true
    $script:MiUpdate.Text = 'בדוק עדכון עכשיו'
}

function Start-UpdateCheck {
    if ($null -ne $script:UpdateSince) { Show-Balloon $script:AppName 'בדיקת עדכון כבר רצה, רגע בבקשה...' 'Info'; return }
    $st = Get-State
    if ($st.Kind -eq 'down') {
        Show-Balloon $script:AppName 'שירות ההגנה אינו פעיל, ולכן אי אפשר לבדוק עדכון כרגע.' 'Warning'
        return
    }
    $now = (Get-Date).ToUniversalTime()
    try {
        Set-Content -LiteralPath $script:RequestPath -Value $now.ToString('o') -Encoding ASCII -ErrorAction Stop
    } catch {
        Show-Balloon $script:AppName 'לא הצלחתי לשלוח בקשה לשירות (אין הרשאה לכתוב בתיקיית היומנים).' 'Warning'
        return
    }
    $script:UpdateSince = $now.AddSeconds(-3)
    $script:UpdateStage = 'checking'
    $script:UpdateDeadline = (Get-Date).AddSeconds(60)
    $script:MiUpdate.Enabled = $false
    $script:MiUpdate.Text = 'בודק עדכון...'
    Show-Balloon $script:AppName 'בודק אם יש גרסה חדשה...' 'Info'
    $script:UpdateTimer.Start()
}

function Poll-UpdateCheck {
    if ($null -eq $script:UpdateSince) { $script:UpdateTimer.Stop(); return }
    $r = Read-KvFile $script:ResultPath
    $at = $null
    if ($r.ContainsKey('at')) { $at = Parse-Utc $r['at'] }
    if (($null -ne $at) -and ($at -ge $script:UpdateSince)) {
        $res = $r['result']; $latest = $r['latest']; $cur = $r['current']
        if ($res -eq 'checking') { return }
        if ($res -eq 'downloading') {
            if ($script:UpdateStage -ne 'downloading') {
                $script:UpdateStage = 'downloading'
                $script:UpdateDeadline = (Get-Date).AddMinutes(6)
                Show-Balloon $script:AppName ('נמצאה גרסה חדשה ' + $latest + '. מוריד ומאמת...') 'Info'
            }
            return
        }
        if ($res -eq 'updating') {
            Show-Balloon $script:AppName ('הגרסה ' + $latest + ' אומתה ומותקנת עכשיו. ההגנה תמשיך לפעול, והשירות יופעל מחדש בעוד רגע.') 'Info'
        } elseif ($res -eq 'uptodate') {
            Show-Balloon $script:AppName ('אין עדכון חדש. הגרסה המותקנת (' + $cur + ') היא העדכנית ביותר.') 'Info'
        } elseif ($res -eq 'disabled') {
            Show-Balloon $script:AppName 'העדכון האוטומטי כבוי במחשב הזה.' 'Warning'
        } elseif ($res -eq 'incomplete') {
            Show-Balloon $script:AppName ('יש גרסה חדשה (' + $latest + ') אבל הפרסום שלה ב-GitHub עדיין לא הושלם. נסו שוב בעוד כמה דקות.') 'Warning'
        } elseif ($res -eq 'busy') {
            if ($r['reason'] -eq 'toofast') { Show-Balloon $script:AppName 'בדיקה כבר בוצעה הרגע, נסו שוב בעוד כמה שניות.' 'Info' }
            else { Show-Balloon $script:AppName 'השירות עסוק כרגע (עדכון או הסרה מתבצעים), נסו שוב בעוד רגע.' 'Warning' }
        } else {
            $why = switch ($r['reason']) {
                'ratelimit' { 'GitHub הגביל זמנית את מספר הבדיקות מהרשת הזו. נסו שוב בעוד כמה דקות.' }
                'notfound'  { 'לא נמצאה גרסה מפורסמת במאגר (או שהמאגר פרטי).' }
                'network'   { 'אין חיבור ל-GitHub מהמחשב הזה.' }
                default     { 'שגיאה: ' + $r['message'] }
            }
            Show-Balloon $script:AppName ('בדיקת העדכון נכשלה. ' + $why) 'Warning'
        }
        Finish-UpdateCheck
        return
    }
    if ((Get-Date) -gt $script:UpdateDeadline) {
        if ($script:UpdateStage -eq 'downloading') {
            Show-Balloon $script:AppName 'ההורדה מתעכבת. פרטים ב-agent.log (תפריט: פתח את תיקיית היומנים).' 'Warning'
        } else {
            Show-Balloon $script:AppName 'השירות לא ענה תוך דקה. ייתכן שהוא עסוק או שאין חיבור לאינטרנט.' 'Warning'
        }
        Finish-UpdateCheck
    }
}

# ---------- About window ----------
function Show-About {
    if ($script:AboutForm -and -not $script:AboutForm.IsDisposed) { $script:AboutForm.Activate(); return }
    $st = Update-Ui $true
    $d = $st.Data

    $f = New-Object System.Windows.Forms.Form
    $script:AboutForm = $f
    $f.Text = 'אודות - ' + $script:AppName
    $f.Icon = $script:IconMain
    $f.StartPosition = 'CenterScreen'
    $f.FormBorderStyle = 'FixedDialog'
    $f.MaximizeBox = $false
    $f.MinimizeBox = $false
    $f.ShowInTaskbar = $true
    $f.BackColor = [System.Drawing.Color]::White
    $f.ClientSize = New-Object System.Drawing.Size(460, 520)

    $hdr = New-Object System.Windows.Forms.Panel
    $hdr.Dock = 'Top'; $hdr.Height = 170
    $hdr.BackColor = [System.Drawing.Color]::FromArgb(24, 44, 140)
    $f.Controls.Add($hdr)

    $pic = New-Object System.Windows.Forms.PictureBox
    $pic.Image = Load-ImageNoLock (Join-Path $script:Assets 'logo-128.png')
    $pic.SizeMode = 'Zoom'
    $pic.Size = New-Object System.Drawing.Size(96, 96)
    $pic.Location = New-Object System.Drawing.Point(182, 14)
    $pic.BackColor = [System.Drawing.Color]::Transparent
    $hdr.Controls.Add($pic)

    $t1 = New-Object System.Windows.Forms.Label
    $t1.Text = $script:AppName
    $t1.ForeColor = [System.Drawing.Color]::White
    $t1.Font = New-Object System.Drawing.Font('Segoe UI', 17, [System.Drawing.FontStyle]::Bold)
    $t1.TextAlign = 'MiddleCenter'
    $t1.SetBounds(0, 114, 460, 32)
    $hdr.Controls.Add($t1)

    $t2 = New-Object System.Windows.Forms.Label
    $t2.Text = 'הגנה על צפייה בתכנים במחשב'
    $t2.RightToLeft = 'Yes'
    $t2.ForeColor = [System.Drawing.Color]::FromArgb(200, 220, 255)
    $t2.Font = New-Object System.Drawing.Font('Segoe UI', 10)
    $t2.TextAlign = 'MiddleCenter'
    $t2.SetBounds(0, 142, 460, 22)
    $hdr.Controls.Add($t2)

    $numLbl = New-Object System.Windows.Forms.Label
    $numLbl.Text = (Get-NumberText $d)
    $numLbl.RightToLeft = 'Yes'
    $numLbl.ForeColor = [System.Drawing.Color]::FromArgb(24, 44, 140)
    $numLbl.Font = New-Object System.Drawing.Font('Segoe UI', 22, [System.Drawing.FontStyle]::Bold)
    $numLbl.TextAlign = 'MiddleCenter'
    $numLbl.SetBounds(0, 176, 460, 52)
    $f.Controls.Add($numLbl)

    $ver = $d['version']; if (-not $ver) { $ver = '-' }
    $dev = $d['device_name']; if (-not $dev) { $dev = $env:COMPUTERNAME }
    $locked = $d['locked_count']; if (-not $locked) { $locked = '0' }
    $scan = ''
    if ($d.ContainsKey('last_full_scan') -and $d['last_full_scan']) {
        $when = Parse-Utc $d['last_full_scan']
        if ($when) { $scan = $when.ToLocalTime().ToString('dd/MM/yyyy HH:mm') }
    }
    if (-not $scan) { $scan = 'עדיין לא הושלמה'; }

    $lines = @(
        ('גרסה: ' + $ver),
        ('שם המכשיר: ' + $dev),
        ('מצב: ' + $st.Title),
        $st.Detail,
        ('קבצי וידאו מוגנים כרגע: ' + $locked),
        ('סריקה מלאה אחרונה: ' + $scan)
    )
    $info = New-Object System.Windows.Forms.Label
    $info.Text = ($lines -join "`r`n")
    $info.RightToLeft = 'Yes'
    $info.Font = New-Object System.Drawing.Font('Segoe UI', 10.5)
    $info.TextAlign = 'MiddleCenter'
    $info.SetBounds(20, 232, 420, 150)
    $f.Controls.Add($info)

    $about = New-Object System.Windows.Forms.Label
    $about.Text = 'התוכנה חוסמת גישה לקבצי וידאו ולנגני וידאו במחשב הזה, לפי ההגדרות בדשבורד. ההגנה פועלת כשירות של Windows ולא ניתן לכבות אותה מכאן.'
    $about.RightToLeft = 'Yes'
    $about.ForeColor = [System.Drawing.Color]::FromArgb(90, 90, 90)
    $about.Font = New-Object System.Drawing.Font('Segoe UI', 9)
    $about.TextAlign = 'MiddleCenter'
    $about.SetBounds(30, 384, 400, 48)
    $f.Controls.Add($about)

    $logPath = New-Object System.Windows.Forms.Label
    $logPath.Text = 'יומנים: ' + $script:LogDir
    $logPath.RightToLeft = 'Yes'
    $logPath.ForeColor = [System.Drawing.Color]::FromArgb(120, 120, 120)
    $logPath.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
    $logPath.TextAlign = 'MiddleCenter'
    $logPath.SetBounds(10, 436, 440, 20)
    $f.Controls.Add($logPath)

    $btnDash = New-Object System.Windows.Forms.Button
    $btnDash.Text = 'פתח דשבורד'
    $btnDash.SetBounds(70, 468, 150, 34)
    $btnDash.Add_Click({ Open-Dashboard })
    $f.Controls.Add($btnDash)

    $btnClose = New-Object System.Windows.Forms.Button
    $btnClose.Text = 'סגור'
    $btnClose.SetBounds(240, 468, 150, 34)
    $btnClose.Add_Click({ $script:AboutForm.Close() })
    $f.Controls.Add($btnClose)
    $f.AcceptButton = $btnClose
    $f.CancelButton = $btnClose

    [void]$f.ShowDialog()
    $pic.Image.Dispose()
    $f.Dispose()
}

# ---------- wiring ----------
$miAbout.Add_Click({ try { Show-About } catch { } })
$miDash.Add_Click({ try { Open-Dashboard } catch { } })
$miLogs.Add_Click({ try { Start-Process 'explorer.exe' -ArgumentList ('"' + $script:LogDir + '"') } catch { } })
$miRefresh.Add_Click({ try { [void](Update-Ui $true); Show-Balloon $script:AppName ((Get-State).Title) 'Info' } catch { } })
$miCopy.Add_Click({
    try {
        $id = (Read-Status)['device_id']
        if ($id) {
            $d = Read-Status
            $num = $d['device_number']; if (-not $num) { $num = '?' }
            $details = 'מחשב מספר ' + $num + ' | שם: ' + $d['device_name'] + ' | מזהה: ' + $id
            [System.Windows.Forms.Clipboard]::SetText($details)
            Show-Balloon $script:AppName 'פרטי המחשב הועתקו ללוח, אפשר להדביק בהודעה' 'Info'
        } else {
            Show-Balloon $script:AppName 'מזהה המכשיר עדיין לא זמין' 'Warning'
        }
    } catch { }
})
$script:Notify.Add_DoubleClick({ try { Show-About } catch { } })
$script:UpdateTimer = New-Object System.Windows.Forms.Timer
$script:UpdateTimer.Interval = 1000
$script:UpdateTimer.Add_Tick({ try { Poll-UpdateCheck } catch { } })
$script:MiUpdate.Add_Click({ try { Start-UpdateCheck } catch { } })
$script:StartVersion = (Read-Status)['version']

[void](Update-Ui $true)

# Just restarted by an update of the agent? Say so (the protection stayed on throughout).
try {
    $noteFile = Join-Path $env:LOCALAPPDATA 'ContentBlockerTray\updated.txt'
    if (Test-Path -LiteralPath $noteFile) {
        $parts = ((Get-Content -LiteralPath $noteFile -Raw -Encoding UTF8).Trim()).Split('|')
        Remove-Item -LiteralPath $noteFile -Force -ErrorAction SilentlyContinue
        if ($parts.Count -ge 2 -and $parts[1]) {
            Show-Balloon $script:AppName ('הסוכן עודכן לגרסה ' + $parts[1] + '. ההגנה נשארה פעילה.') 'Info'
        }
    }
} catch { }

# Poll status; also exit by ourselves once the program has been uninstalled
# (our own script file is gone), so no stale icon lingers.
$script:Ctx = New-Object System.Windows.Forms.ApplicationContext
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({
    try {
        if (-not (Test-Path -LiteralPath $script:Self)) { $script:Ctx.ExitThread(); return }
        [void](Update-Ui $false)
    } catch { }
})
$timer.Start()

try {
    [System.Windows.Forms.Application]::Run($script:Ctx)
} finally {
    $timer.Stop()
    $script:Notify.Visible = $false
    $script:Notify.Dispose()
    try { $script:Mutex.ReleaseMutex() } catch { }
}

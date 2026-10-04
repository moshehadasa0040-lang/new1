# Content Blocker Agent - installer progress window.
# Started (hidden, no console) by the installer just before the long
# "lock every video file" step, so the wait is not a blank progress bar:
# live counters, a stage checklist and rotating tips. It only READS
# install-progress.txt written by the agent (--lock-files) and closes itself
# when the agent is done. Closing it early does not affect the installation.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::CatchException)

$script:AppDir   = Split-Path -Parent $PSCommandPath
$script:Assets   = Join-Path $script:AppDir 'assets'
$script:LogDir   = 'C:\Users\Public\Documents\ContentBlockerLogs'
$script:ProgressPath = Join-Path $script:LogDir 'install-progress.txt'
$script:ResultPath   = 'C:\ProgramData\ContentBlockerAgent\install-lock-result.txt'

# Files older than this window's own start (minus a little slack, the agent is
# launched a moment BEFORE this window finishes starting) belong to an earlier
# install and are ignored.
$script:Launched = (Get-Process -Id $PID).StartTime.ToUniversalTime().AddSeconds(-5)

function Read-Kv([string]$path) {
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

$tips = @(
    'אפשר לשחרר את החסימה זמנית מהדשבורד, בלי להסיר את התוכנה',
    'אייקון המגן ליד השעון מראה בכל רגע אם ההגנה פעילה',
    'הקבצים ננעלים ברמת ההרשאות של Windows, לא רק בנגן הוידאו',
    'כל מה שהתוכנה עושה נרשם ביומן: C:\Users\Public\Documents\ContentBlockerLogs',
    'שיחה פתוחה עם הילדים על הסיבה לחסימה עובדת טוב יותר מכל תוכנה',
    'סיסמה חזקה לדשבורד היא קו ההגנה הראשון, שמרו אותה במקום בטוח',
    'סרטון חדש שמגיע לתיקיות המשתמש ננעל אוטומטית תוך כחצי דקה',
    'מזהה המכשיר זמין בתפריט של אייקון המגן, שימושי כשפונים לתמיכה',
    'מומלץ לעדכן את Windows באופן קבוע, עדכונים סוגרים פרצות אבטחה'
)

$f = New-Object System.Windows.Forms.Form
$f.Text = 'Content Blocker Agent'
$f.Icon = New-Object System.Drawing.Icon((Join-Path $script:Assets 'icon.ico'))
$f.StartPosition = 'CenterScreen'
$f.FormBorderStyle = 'FixedDialog'
$f.MaximizeBox = $false
$f.MinimizeBox = $false
$f.TopMost = $true
$f.BackColor = [System.Drawing.Color]::White
$f.ClientSize = New-Object System.Drawing.Size(520, 470)

$hdr = New-Object System.Windows.Forms.Panel
$hdr.Dock = 'Top'; $hdr.Height = 128
$hdr.BackColor = [System.Drawing.Color]::FromArgb(24, 44, 140)
$f.Controls.Add($hdr)

$pic = New-Object System.Windows.Forms.PictureBox
$pic.Image = [System.Drawing.Image]::FromFile((Join-Path $script:Assets 'logo-128.png'))
$pic.SizeMode = 'Zoom'
$pic.Size = New-Object System.Drawing.Size(76, 76)
$pic.Location = New-Object System.Drawing.Point(222, 10)
$pic.BackColor = [System.Drawing.Color]::Transparent
$hdr.Controls.Add($pic)

$title = New-Object System.Windows.Forms.Label
$title.Text = 'מתקינים את ההגנה על המחשב'
$title.RightToLeft = 'Yes'
$title.ForeColor = [System.Drawing.Color]::White
$title.Font = New-Object System.Drawing.Font('Segoe UI', 15, [System.Drawing.FontStyle]::Bold)
$title.TextAlign = 'MiddleCenter'
$title.SetBounds(0, 90, 520, 34)
$hdr.Controls.Add($title)

$bar = New-Object System.Windows.Forms.ProgressBar
$bar.Style = 'Continuous'
$bar.Minimum = 0; $bar.Maximum = 1000; $bar.Value = 0
$bar.SetBounds(30, 148, 460, 24)
$f.Controls.Add($bar)

$pct = New-Object System.Windows.Forms.Label
$pct.Text = '0%'
$pct.Font = New-Object System.Drawing.Font('Segoe UI', 20, [System.Drawing.FontStyle]::Bold)
$pct.ForeColor = [System.Drawing.Color]::FromArgb(24, 44, 140)
$pct.TextAlign = 'MiddleCenter'
$pct.SetBounds(0, 176, 520, 40)
$f.Controls.Add($pct)

$stages = New-Object System.Windows.Forms.Label
$stages.RightToLeft = 'Yes'
$stages.Font = New-Object System.Drawing.Font('Segoe UI', 10.5)
$stages.TextAlign = 'MiddleCenter'
$stages.SetBounds(30, 220, 460, 96)
$f.Controls.Add($stages)

$counters = New-Object System.Windows.Forms.Label
$counters.RightToLeft = 'Yes'
$counters.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
$counters.ForeColor = [System.Drawing.Color]::FromArgb(60, 60, 60)
$counters.TextAlign = 'MiddleCenter'
$counters.SetBounds(30, 320, 460, 26)
$f.Controls.Add($counters)

$tipBox = New-Object System.Windows.Forms.Panel
$tipBox.BackColor = [System.Drawing.Color]::FromArgb(238, 244, 255)
$tipBox.SetBounds(30, 356, 460, 72)
$f.Controls.Add($tipBox)

$tipHead = New-Object System.Windows.Forms.Label
$tipHead.Text = 'ידעתם?'
$tipHead.RightToLeft = 'Yes'
$tipHead.Font = New-Object System.Drawing.Font('Segoe UI', 9.5, [System.Drawing.FontStyle]::Bold)
$tipHead.ForeColor = [System.Drawing.Color]::FromArgb(24, 44, 140)
$tipHead.TextAlign = 'MiddleCenter'
$tipHead.SetBounds(0, 6, 460, 20)
$tipBox.Controls.Add($tipHead)

$tipText = New-Object System.Windows.Forms.Label
$tipText.RightToLeft = 'Yes'
$tipText.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$tipText.TextAlign = 'MiddleCenter'
$tipText.SetBounds(10, 28, 440, 40)
$tipBox.Controls.Add($tipText)

$foot = New-Object System.Windows.Forms.Label
$foot.Text = 'אפשר להמשיך להשתמש במחשב, ההתקנה תסתיים מעצמה'
$foot.RightToLeft = 'Yes'
$foot.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
$foot.ForeColor = [System.Drawing.Color]::FromArgb(120, 120, 120)
$foot.TextAlign = 'MiddleCenter'
$foot.SetBounds(0, 438, 520, 22)
$f.Controls.Add($foot)

# ---------- state ----------
$script:Display   = 0.0     # eased bar value, 0..1000
$script:Target    = 0       # real value from the agent, 0..1000
$script:Tick      = 0
$script:TipIndex  = Get-Random -Maximum $tips.Count
$script:LastSeen  = Get-Date
$script:SawFresh  = $false
$script:LastStamp = ''
$script:Done      = $false
$script:DoneAt    = $null
$script:StartedAt = Get-Date
$tipText.Text = $tips[$script:TipIndex]

function Stage-Of([string]$phase) {
    switch ($phase) {
        'done'   { return 4 }
        'retry'  { return 3 }
        'verify' { return 3 }
        'scan'   { return 2 }
        'lock'   { return 2 }
        default  { return 1 }
    }
}

function Render-Stages([int]$cur, [string]$drive, [string]$dots) {
    $names = @('סריקת תיקיות המשתמש', 'סריקת כל הכוננים', 'אימות ובדיקה', 'סיום')
    if ($cur -eq 2 -and $drive) { $names[1] = 'סריקת כל הכוננים (' + $drive + ')' }
    $out = @()
    for ($i = 1; $i -le 4; $i++) {
        if ($i -lt $cur -or $cur -eq 4) { $out += ([string][char]0x2713 + '  ' + $names[$i - 1]) }
        elseif ($i -eq $cur) { $out += ([string][char]0x25BA + '  ' + $names[$i - 1] + $dots) }
        else { $out += ([string][char]0x00B7 + '  ' + $names[$i - 1]) }
    }
    return ($out -join "`r`n")
}

function Poll {
    $now = Get-Date
    $kv = Read-Kv $script:ProgressPath
    $stamp = $null
    if ($kv.ContainsKey('updated')) { $stamp = Parse-Utc $kv['updated'] }
    $fresh = ($null -ne $stamp) -and ($stamp -ge $script:Launched)

    if ($fresh) {
        $script:SawFresh = $true
        if ($kv['updated'] -ne $script:LastStamp) { $script:LastStamp = $kv['updated']; $script:LastSeen = $now }
        $p = 0; [void][int]::TryParse($kv['percent'], [ref]$p)
        $script:Target = [Math]::Max($script:Target, [Math]::Min(1000, $p * 10))
        $phase = $kv['phase']
        $dots = ('.' * (($script:Tick % 4)))
        $stages.Text = Render-Stages (Stage-Of $phase) $kv['drive'] $dots
        $found = $kv['found']; if (-not $found) { $found = '0' }
        $locked = $kv['locked']; if (-not $locked) { $locked = '0' }
        $secs = 0; [void][int]::TryParse($kv['elapsed'], [ref]$secs)
        $counters.Text = ('נמצאו ' + $found + '   |   ננעלו ' + $locked + '   |   זמן ' + ([TimeSpan]::FromSeconds($secs).ToString('mm\:ss')))

        if ($phase -eq 'done' -and -not $script:Done) {
            $script:Done = $true
            $script:DoneAt = $now
            $script:Target = 1000
            $res = $null
            if (Test-Path -LiteralPath $script:ResultPath) {
                $info = Get-Item -LiteralPath $script:ResultPath
                if ($info.LastWriteTimeUtc -ge $script:Launched) { $res = (Get-Content -LiteralPath $script:ResultPath -Raw).Trim() }
            }
            if ($res -and $res.StartsWith('INCOMPLETE')) {
                $title.Text = 'ההתקנה הסתיימה, אך לא כל הקבצים ננעלו'
                $stages.Text = 'חלק מהקבצים לא ניתנו לנעילה.' + "`r`n" + 'הפרטים נרשמו ביומן, והשירות ימשיך לנסות.'
                $script:Grace = 9
            } else {
                $title.Text = 'ההגנה הותקנה בהצלחה'
                $script:Grace = 3
            }
        }
    } else {
        $dots = ('.' * (($script:Tick % 4)))
        $stages.Text = Render-Stages 1 '' $dots
        $counters.Text = 'מתחילים...'
    }

    # give up quietly if the agent never started or went silent
    $silent = ($now - $script:LastSeen).TotalSeconds
    if ((-not $script:SawFresh) -and (($now - $script:StartedAt).TotalSeconds -gt 300)) { $f.Close() }
    if ($script:SawFresh -and -not $script:Done -and $silent -gt 180) { $f.Close() }
    if (($now - $script:StartedAt).TotalMinutes -gt 60) { $f.Close() }
    if ($script:Done -and (($now - $script:DoneAt).TotalSeconds -gt $script:Grace)) { $f.Close() }
}

$animTimer = New-Object System.Windows.Forms.Timer
$animTimer.Interval = 80
$animTimer.Add_Tick({
    try {
        $script:Tick++
        # ease the bar toward the real value (looks smooth, never runs ahead of it)
        $script:Display = $script:Display + ($script:Target - $script:Display) * 0.12
        if ($script:Target - $script:Display -lt 1) { $script:Display = [double]$script:Target }
        $bar.Value = [int][Math]::Max(0, [Math]::Min(1000, $script:Display))
        $pct.Text = ([int]([Math]::Round($script:Display / 10))).ToString() + '%'
        if ($script:Tick % 8 -eq 0) { Poll }                       # ~ every 0.65s
        if ($script:Tick % 90 -eq 0) {                             # ~ every 7s
            $script:TipIndex = ($script:TipIndex + 1) % $tips.Count
            $tipText.Text = $tips[$script:TipIndex]
        }
    } catch { }
})
$script:Grace = 3
$animTimer.Start()
Poll

[void]$f.ShowDialog()
$animTimer.Stop()
$pic.Image.Dispose()
$f.Dispose()

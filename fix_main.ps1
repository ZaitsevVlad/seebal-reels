$f = 'c:\Users\user\SEEBAL\main.js'
$c = [IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8)

# The orphaned block starts at the first CSS snippet (seebal-vq-brand in raw code)
# and ends just before the real "// --- IPC Handlers" comment
$startMarker = 'font-weight:900;letter-spacing:.02em'
$endMarker = '// ' + [char]0x2500 + [char]0x2500 + [char]0x2500 + ' IPC Handlers'

$startPos = $c.IndexOf($startMarker)
$endPos = $c.IndexOf($endMarker)

if ($startPos -ge 0 -and $endPos -gt $startPos) {
    # Walk backwards from startPos to beginning of that line
    $lineStart = $startPos
    while ($lineStart -gt 0 -and $c[$lineStart - 1] -ne "`n") { $lineStart-- }
    
    $cleaned = $c.Substring(0, $lineStart) + $c.Substring($endPos)
    [IO.File]::WriteAllText($f, $cleaned, [System.Text.Encoding]::UTF8)
    Write-Host "OK: removed $($endPos - $lineStart) chars of orphaned code. File is now $($cleaned.Length) chars."
} else {
    Write-Host "Markers not found. startPos=$startPos endPos=$endPos"
    # Show context around where we expect things
    $sample = $c.Substring([Math]::Max(0, 36000), [Math]::Min(200, $c.Length - 36000))
    Write-Host "Sample at ~36000: $sample"
}

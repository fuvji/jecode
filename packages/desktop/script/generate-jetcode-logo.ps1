# Generates the jetcode transparent app mark and every icon format the desktop
# build and web renderer consume. Run from the repository root:
#   powershell -NoProfile -ExecutionPolicy Bypass -File packages/desktop/script/generate-jetcode-logo.ps1
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$masterSize = 1024
$out = Join-Path $root "packages\desktop\logo-work"
New-Item -ItemType Directory -Force -Path $out | Out-Null

function New-LogoBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  $s = $size / 1024.0
  $rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
  $gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 34, 211, 238),
    [System.Drawing.Color]::FromArgb(255, 217, 70, 239),
    35.0
  )
  $blend = New-Object System.Drawing.Drawing2D.ColorBlend(4)
  $blend.Colors = @(
    [System.Drawing.Color]::FromArgb(255, 34, 211, 238),
    [System.Drawing.Color]::FromArgb(255, 79, 140, 255),
    [System.Drawing.Color]::FromArgb(255, 139, 92, 246),
    [System.Drawing.Color]::FromArgb(255, 217, 70, 239)
  )
  $blend.Positions = @(0.0, 0.42, 0.72, 1.0)
  $gradient.InterpolationColors = $blend

  # Bold geometric J: a swept top bar, vertical stem, and rounded return hook.
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.StartFigure()
  $path.AddBezier(300 * $s, 300 * $s, 420 * $s, 300 * $s, 620 * $s, 300 * $s, 690 * $s, 300 * $s)
  $path.AddBezier(690 * $s, 300 * $s, 735 * $s, 300 * $s, 760 * $s, 330 * $s, 760 * $s, 378 * $s)
  $path.AddLine(760 * $s, 590 * $s, 760 * $s, 600 * $s)
  $path.AddBezier(760 * $s, 600 * $s, 760 * $s, 738 * $s, 668 * $s, 812 * $s, 540 * $s, 812 * $s)
  $path.AddBezier(540 * $s, 812 * $s, 442 * $s, 812 * $s, 366 * $s, 756 * $s, 334 * $s, 672 * $s)
  $pen = New-Object System.Drawing.Pen($gradient, (148 * $s))
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $g.DrawPath($pen, $path)

  # A clean white highlight along the upper edge keeps the mark crisp on dark UI.
  $highlight = New-Object System.Drawing.Drawing2D.GraphicsPath
  $highlight.AddBezier(330 * $s, 260 * $s, 430 * $s, 250 * $s, 640 * $s, 248 * $s, 742 * $s, 266 * $s)
  $hpen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(150, 255, 255, 255), (18 * $s))
  $hpen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $hpen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawPath($hpen, $highlight)

  # Four-point spark: speed, precision, and a little jet exhaust.
  $cx = 828 * $s
  $cy = 212 * $s
  $long = 62 * $s
  $short = 17 * $s
  $star = New-Object System.Drawing.Drawing2D.GraphicsPath
  $star.AddPolygon([System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new($cx, ($cy - $long)),
    [System.Drawing.PointF]::new(($cx + $short), ($cy - $short)),
    [System.Drawing.PointF]::new(($cx + $long), $cy),
    [System.Drawing.PointF]::new(($cx + $short), ($cy + $short)),
    [System.Drawing.PointF]::new($cx, ($cy + $long)),
    [System.Drawing.PointF]::new(($cx - $short), ($cy + $short)),
    [System.Drawing.PointF]::new(($cx - $long), $cy),
    [System.Drawing.PointF]::new(($cx - $short), ($cy - $short))
  ))
  $g.FillPath($gradient, $star)
  $starPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(110, 255, 255, 255), (10 * $s))
  $starPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $g.DrawPath($starPen, $star)

  $pen.Dispose(); $hpen.Dispose(); $starPen.Dispose()
  $path.Dispose(); $highlight.Dispose(); $star.Dispose()
  $gradient.Dispose(); $g.Dispose()
  return $bmp
}

function Save-Png([System.Drawing.Bitmap]$bitmap, [string]$path) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
}

function Resize-Logo([System.Drawing.Bitmap]$source, [int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($source, 0, 0, $size, $size)
  $g.Dispose()
  return $bmp
}

function Write-Ico([string]$path, [string[]]$pngFiles) {
  $images = @()
  foreach ($file in $pngFiles) {
    $bytes = [System.IO.File]::ReadAllBytes($file)
    $name = [System.IO.Path]::GetFileNameWithoutExtension($file)
    $size = [int]($name -replace "[^0-9]", "")
    if ($size -le 0) { $size = 256 }
    $images += [pscustomobject]@{ Size = $size; Bytes = $bytes }
  }
  $headerLength = 6 + (16 * $images.Count)
  $offset = $headerLength
  $stream = New-Object System.IO.MemoryStream
  $writer = New-Object System.IO.BinaryWriter($stream)
  $writer.Write([byte]0); $writer.Write([byte]0)
  $writer.Write([byte]1); $writer.Write([byte]0)
  $writer.Write([uint16]$images.Count)
  foreach ($image in $images) {
    $dim = if ($image.Size -ge 256) { 0 } else { $image.Size }
    $writer.Write([byte]$dim); $writer.Write([byte]$dim)
    $writer.Write([byte]0); $writer.Write([byte]0)
    $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]$image.Bytes.Length); $writer.Write([uint32]$offset)
    $offset += $image.Bytes.Length
  }
  foreach ($image in $images) { $writer.Write($image.Bytes) }
  $writer.Flush()
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
  [System.IO.File]::WriteAllBytes($path, $stream.ToArray())
  $writer.Dispose(); $stream.Dispose()
}

function Write-BigEndian([System.IO.BinaryWriter]$writer, [uint32]$value) {
  $writer.Write([byte](($value -shr 24) -band 0xff))
  $writer.Write([byte](($value -shr 16) -band 0xff))
  $writer.Write([byte](($value -shr 8) -band 0xff))
  $writer.Write([byte]($value -band 0xff))
}

function Write-Icns([string]$path, [string[]]$pngFiles) {
  $elements = @()
  foreach ($file in $pngFiles) {
    $name = [System.IO.Path]::GetFileNameWithoutExtension($file)
    $size = [int]($name -replace "[^0-9]", "")
    $type = switch ($size) {
      16 { "icp4" }
      32 { "icp5" }
      64 { "icp6" }
      128 { "ic07" }
      256 { "ic08" }
      512 { "ic09" }
      1024 { "ic10" }
      default { $null }
    }
    if ($type) { $elements += [pscustomobject]@{ Type = $type; Bytes = [System.IO.File]::ReadAllBytes($file) } }
  }
  $bodyLength = 8
  foreach ($element in $elements) { $bodyLength += 8 + $element.Bytes.Length }
  $stream = New-Object System.IO.MemoryStream
  $writer = New-Object System.IO.BinaryWriter($stream)
  $writer.Write([System.Text.Encoding]::ASCII.GetBytes("icns"))
  Write-BigEndian $writer ([uint32]$bodyLength)
  foreach ($element in $elements) {
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes($element.Type))
    Write-BigEndian $writer ([uint32](8 + $element.Bytes.Length))
    $writer.Write($element.Bytes)
  }
  $writer.Flush()
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
  [System.IO.File]::WriteAllBytes($path, $stream.ToArray())
  $writer.Dispose(); $stream.Dispose()
}

$master = New-LogoBitmap $masterSize
Save-Png $master (Join-Path $out "jetcode-1024.png")
$sizes = @(16, 24, 30, 32, 44, 48, 64, 71, 89, 96, 107, 128, 142, 150, 180, 192, 256, 284, 310, 512, 1024)
$rendered = @{}
foreach ($size in $sizes) {
  $bmp = Resize-Logo $master $size
  $file = Join-Path $out "jetcode-$size.png"
  Save-Png $bmp $file
  $rendered[$size] = $file
  $bmp.Dispose()
}

$channels = @("dev", "beta", "prod")
$squareNames = @{
  "30" = "Square30x30Logo.png"
  "44" = "Square44x44Logo.png"
  "71" = "Square71x71Logo.png"
  "89" = "Square89x89Logo.png"
  "107" = "Square107x107Logo.png"
  "142" = "Square142x142Logo.png"
  "150" = "Square150x150Logo.png"
  "284" = "Square284x284Logo.png"
  "310" = "Square310x310Logo.png"
}
foreach ($channel in $channels) {
  $dir = Join-Path $root "packages\desktop\icons\$channel"
  Copy-Item (Join-Path $out "jetcode-512.png") (Join-Path $dir "icon.png") -Force
  Copy-Item (Join-Path $out "jetcode-128.png") (Join-Path $dir "128x128.png") -Force
  Copy-Item (Join-Path $out "jetcode-256.png") (Join-Path $dir "128x128@2x.png") -Force
  Copy-Item (Join-Path $out "jetcode-32.png") (Join-Path $dir "32x32.png") -Force
  Copy-Item (Join-Path $out "jetcode-64.png") (Join-Path $dir "64x64.png") -Force
  Copy-Item (Join-Path $out "jetcode-256.png") (Join-Path $dir "dock.png") -Force
  Copy-Item (Join-Path $out "jetcode-150.png") (Join-Path $dir "StoreLogo.png") -Force
  foreach ($entry in $squareNames.GetEnumerator()) {
    Copy-Item (Join-Path $out "jetcode-$($entry.Key).png") (Join-Path $dir $entry.Value) -Force
  }
  Write-Ico (Join-Path $dir "icon.ico") @(
    (Join-Path $out "jetcode-16.png"), (Join-Path $out "jetcode-24.png"), (Join-Path $out "jetcode-32.png"),
    (Join-Path $out "jetcode-48.png"), (Join-Path $out "jetcode-64.png"), (Join-Path $out "jetcode-128.png"),
    (Join-Path $out "jetcode-256.png")
  )
  Write-Icns (Join-Path $dir "icon.icns") @(
    (Join-Path $out "jetcode-16.png"), (Join-Path $out "jetcode-32.png"), (Join-Path $out "jetcode-64.png"),
    (Join-Path $out "jetcode-128.png"), (Join-Path $out "jetcode-256.png"), (Join-Path $out "jetcode-512.png"),
    (Join-Path $out "jetcode-1024.png")
  )
  if (Test-Path (Join-Path $dir "icon.icon")) {
    Copy-Item (Join-Path $out "jetcode-1024.png") (Join-Path $dir "icon.icon\Assets\icon.png") -Force
  }
}

$faviconDir = Join-Path $root "packages\ui\src\assets\favicon"
Copy-Item (Join-Path $out "jetcode-96.png") (Join-Path $faviconDir "favicon-96x96.png") -Force
Copy-Item (Join-Path $out "jetcode-96.png") (Join-Path $faviconDir "favicon-96x96-v3.png") -Force
Copy-Item (Join-Path $out "jetcode-180.png") (Join-Path $faviconDir "apple-touch-icon.png") -Force
Copy-Item (Join-Path $out "jetcode-180.png") (Join-Path $faviconDir "apple-touch-icon-v3.png") -Force
Copy-Item (Join-Path $out "jetcode-192.png") (Join-Path $faviconDir "web-app-manifest-192x192.png") -Force
Copy-Item (Join-Path $out "jetcode-512.png") (Join-Path $faviconDir "web-app-manifest-512x512.png") -Force
Write-Ico (Join-Path $faviconDir "favicon.ico") @(
  (Join-Path $out "jetcode-16.png"), (Join-Path $out "jetcode-32.png"), (Join-Path $out "jetcode-48.png"),
  (Join-Path $out "jetcode-64.png")
)
Write-Ico (Join-Path $faviconDir "favicon-v3.ico") @(
  (Join-Path $out "jetcode-16.png"), (Join-Path $out "jetcode-32.png"), (Join-Path $out "jetcode-48.png"),
  (Join-Path $out "jetcode-64.png")
)

$svg = @'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="jetcode">
  <defs>
    <linearGradient id="j" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#22D3EE"/>
      <stop offset=".42" stop-color="#4F8CFF"/>
      <stop offset=".72" stop-color="#8B5CF6"/>
      <stop offset="1" stop-color="#D946EF"/>
    </linearGradient>
  </defs>
  <path d="M300 300H690C735 300 760 330 760 378V600C760 738 668 812 540 812C442 812 366 756 334 672" fill="none" stroke="url(#j)" stroke-width="148" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M330 260C430 250 640 248 742 266" fill="none" stroke="#fff" stroke-opacity=".59" stroke-width="18" stroke-linecap="round"/>
  <path d="M828 150L845 195L890 212L845 229L828 274L811 229L766 212L811 195Z" fill="url(#j)" stroke="#fff" stroke-opacity=".43" stroke-width="10" stroke-linejoin="round"/>
</svg>
'@
[System.IO.File]::WriteAllText((Join-Path $faviconDir "favicon.svg"), $svg)
[System.IO.File]::WriteAllText((Join-Path $faviconDir "favicon-v3.svg"), $svg)
[System.IO.File]::WriteAllText((Join-Path $root "packages\desktop\app-icon.svg"), $svg)

$master.Dispose()
Write-Host "Generated transparent jetcode icons in $out"

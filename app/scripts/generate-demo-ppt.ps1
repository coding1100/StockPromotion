$ErrorActionPreference = 'Stop'

function RGBColor([int]$r, [int]$g, [int]$b) {
  return $r + ($g * 256) + ($b * 65536)
}

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$outDir = Join-Path $projectRoot 'app\presentations'
if (-not (Test-Path -LiteralPath $outDir)) {
  New-Item -Path $outDir -ItemType Directory | Out-Null
}

$outFile = Join-Path $outDir 'Stock-Promotion-Client-Demo-5-Slides.pptx'

$ppLayoutTitle = 1
$ppLayoutText = 2
$ppLayoutBlank = 12

$msoShapeRectangle = 1
$msoShapeRoundedRectangle = 5
$msoShapeRightArrow = 33

$msoTrue = -1

$fontTitle = 'Segoe UI Semibold'
$fontBody = 'Segoe UI'

$colorNavy = RGBColor 14 37 66
$colorBlue = RGBColor 26 87 158
$colorTeal = RGBColor 9 140 150
$colorOrange = RGBColor 232 122 47
$colorLight = RGBColor 245 248 252
$colorWhite = RGBColor 255 255 255
$colorDarkText = RGBColor 38 45 56
$colorMuted = RGBColor 86 101 115

$ppt = $null
$presentation = $null

try {
  $ppt = New-Object -ComObject PowerPoint.Application
  $ppt.Visible = $msoTrue
  $presentation = $ppt.Presentations.Add()

  function Set-SlideBackground($slide, $color) {
    $slide.Background.Fill.Solid()
    $slide.Background.Fill.ForeColor.RGB = $color
  }

  function Add-HeaderBar($slide, $text) {
    $bar = $slide.Shapes.AddShape($msoShapeRectangle, 0, 0, 960, 42)
    $bar.Fill.Solid()
    $bar.Fill.ForeColor.RGB = $colorNavy
    $bar.Line.Visible = 0

    $tb = $slide.Shapes.AddTextbox(1, 24, 8, 650, 24)
    $tb.TextFrame.TextRange.Text = $text
    $tb.TextFrame.TextRange.Font.Name = $fontBody
    $tb.TextFrame.TextRange.Font.Size = 14
    $tb.TextFrame.TextRange.Font.Color.RGB = $colorWhite
  }

  # Slide 1: Title
  $slide1 = $presentation.Slides.Add(1, $ppLayoutBlank)
  Set-SlideBackground $slide1 $colorLight
  Add-HeaderBar $slide1 'Client Presentation | Stock Promotion Automation'

  $accent = $slide1.Shapes.AddShape($msoShapeRectangle, 46, 95, 14, 170)
  $accent.Fill.Solid(); $accent.Fill.ForeColor.RGB = $colorTeal; $accent.Line.Visible = 0

  $title1 = $slide1.Shapes.AddTextbox(1, 74, 100, 790, 120)
  $title1.TextFrame.TextRange.Text = 'Stock Promotion Automation Platform'
  $title1.TextFrame.TextRange.Font.Name = $fontTitle
  $title1.TextFrame.TextRange.Font.Size = 48
  $title1.TextFrame.TextRange.Font.Bold = $msoTrue
  $title1.TextFrame.TextRange.Font.Color.RGB = $colorNavy

  $subtitle1 = $slide1.Shapes.AddTextbox(1, 74, 220, 760, 120)
  $subtitle1.TextFrame.TextRange.Text = "End-to-end discovery, AI content generation, and controlled multi-platform publishing for stock campaigns.`n`nDemo Date: April 13, 2026"
  $subtitle1.TextFrame.TextRange.Font.Name = $fontBody
  $subtitle1.TextFrame.TextRange.Font.Size = 21
  $subtitle1.TextFrame.TextRange.Font.Color.RGB = $colorMuted

  $pill1 = $slide1.Shapes.AddShape($msoShapeRoundedRectangle, 74, 390, 250, 46)
  $pill1.Fill.Solid(); $pill1.Fill.ForeColor.RGB = $colorBlue; $pill1.Line.Visible = 0
  $pill1.TextFrame.TextRange.Text = 'Phase 1 + 2 + 3 Ready'
  $pill1.TextFrame.TextRange.Font.Name = $fontBody
  $pill1.TextFrame.TextRange.Font.Size = 16
  $pill1.TextFrame.TextRange.Font.Bold = $msoTrue
  $pill1.TextFrame.TextRange.Font.Color.RGB = $colorWhite
  $pill1.TextFrame.TextRange.ParagraphFormat.Alignment = 2

  # Slide 2: What the app does
  $slide2 = $presentation.Slides.Add(2, $ppLayoutBlank)
  Set-SlideBackground $slide2 $colorWhite
  Add-HeaderBar $slide2 'What The App Does'

  $title2 = $slide2.Shapes.AddTextbox(1, 50, 60, 540, 60)
  $title2.TextFrame.TextRange.Text = 'Business Outcome'
  $title2.TextFrame.TextRange.Font.Name = $fontTitle
  $title2.TextFrame.TextRange.Font.Size = 34
  $title2.TextFrame.TextRange.Font.Color.RGB = $colorNavy

  $leftCard = $slide2.Shapes.AddShape($msoShapeRoundedRectangle, 50, 130, 555, 345)
  $leftCard.Fill.Solid(); $leftCard.Fill.ForeColor.RGB = $colorLight
  $leftCard.Line.ForeColor.RGB = RGBColor 221 229 238

  $points2 = @(
    'Monitors Reddit and additional market connectors for stock and crypto trend signals',
    'Detects high-interest symbols using weighted trend scoring windows (1h, 6h, 24h)',
    'Generates engaging draft content with structured LLM output',
    'Publishes to StockTwits (browser automation) and Telegram (bot pipeline)',
    'Tracks publish success, failures, retries, and account health in real time'
  )
  $tb2 = $slide2.Shapes.AddTextbox(1, 75, 155, 505, 300)
  $tb2.TextFrame.TextRange.Text = ('• ' + ($points2 -join "`r`n• "))
  $tb2.TextFrame.TextRange.Font.Name = $fontBody
  $tb2.TextFrame.TextRange.Font.Size = 20
  $tb2.TextFrame.TextRange.Font.Color.RGB = $colorDarkText

  $rightCard = $slide2.Shapes.AddShape($msoShapeRoundedRectangle, 630, 130, 280, 345)
  $rightCard.Fill.Solid(); $rightCard.Fill.ForeColor.RGB = RGBColor 18 49 90
  $rightCard.Line.Visible = 0

  $tb2r = $slide2.Shapes.AddTextbox(1, 655, 160, 230, 290)
  $tb2r.TextFrame.TextRange.Text = "Client Value`n`n• Faster campaign turnaround`n• Consistent content quality`n• Safer account operations`n• Clear operational visibility`n• Reliable retry and recovery"
  $tb2r.TextFrame.TextRange.Font.Name = $fontBody
  $tb2r.TextFrame.TextRange.Font.Size = 19
  $tb2r.TextFrame.TextRange.Font.Color.RGB = $colorWhite

  # Slide 3: How it works
  $slide3 = $presentation.Slides.Add(3, $ppLayoutBlank)
  Set-SlideBackground $slide3 $colorWhite
  Add-HeaderBar $slide3 'How It Works: 6-Step Pipeline'

  $title3 = $slide3.Shapes.AddTextbox(1, 50, 62, 860, 48)
  $title3.TextFrame.TextRange.Text = 'Data In -> AI Decisions -> Controlled Publishing -> Monitoring'
  $title3.TextFrame.TextRange.Font.Name = $fontTitle
  $title3.TextFrame.TextRange.Font.Size = 29
  $title3.TextFrame.TextRange.Font.Color.RGB = $colorNavy

  $steps = @(
    @{ x=55;  y=140; w=130; h=95; fill=(RGBColor 232 244 255); text='1. Ingest`nReddit + APIs'; font=$colorDarkText },
    @{ x=205; y=140; w=130; h=95; fill=(RGBColor 220 242 238); text='2. Trends`nScore symbols'; font=$colorDarkText },
    @{ x=355; y=140; w=130; h=95; fill=(RGBColor 255 239 220); text='3. Drafts`nLLM generation'; font=$colorDarkText },
    @{ x=505; y=140; w=130; h=95; fill=(RGBColor 246 238 255); text='4. Policy`nChecks + approvals'; font=$colorDarkText },
    @{ x=655; y=140; w=130; h=95; fill=(RGBColor 232 244 255); text='5. Queue`nSchedule + retry'; font=$colorDarkText },
    @{ x=805; y=140; w=130; h=95; fill=(RGBColor 220 242 238); text='6. Publish`nStockTwits + Telegram'; font=$colorDarkText }
  )

  foreach ($step in $steps) {
    $box = $slide3.Shapes.AddShape($msoShapeRoundedRectangle, $step.x, $step.y, $step.w, $step.h)
    $box.Fill.Solid(); $box.Fill.ForeColor.RGB = $step.fill
    $box.Line.ForeColor.RGB = RGBColor 190 205 222
    $box.TextFrame.TextRange.Text = $step.text
    $box.TextFrame.TextRange.Font.Name = $fontBody
    $box.TextFrame.TextRange.Font.Size = 14
    $box.TextFrame.TextRange.Font.Bold = $msoTrue
    $box.TextFrame.TextRange.Font.Color.RGB = $step.font
    $box.TextFrame.TextRange.ParagraphFormat.Alignment = 2
  }

  for ($i = 0; $i -lt 5; $i++) {
    $x = 188 + (150 * $i)
    $arrow = $slide3.Shapes.AddShape($msoShapeRightArrow, $x, 173, 18, 28)
    $arrow.Fill.Solid(); $arrow.Fill.ForeColor.RGB = $colorBlue
    $arrow.Line.Visible = 0
  }

  $monitor = $slide3.Shapes.AddShape($msoShapeRoundedRectangle, 75, 290, 840, 168)
  $monitor.Fill.Solid(); $monitor.Fill.ForeColor.RGB = $colorLight
  $monitor.Line.ForeColor.RGB = RGBColor 215 224 235

  $tb3 = $slide3.Shapes.AddTextbox(1, 95, 315, 800, 130)
  $tb3.TextFrame.TextRange.Text = "Platform controls active across the flow:`n• API-key protected control plane`n• Queue-based async workers (Redis/BullMQ)`n• Idempotent jobs + cooldown duplicate suppression`n• Full audit trail of ingest, draft, approval, publish, and recovery actions"
  $tb3.TextFrame.TextRange.Font.Name = $fontBody
  $tb3.TextFrame.TextRange.Font.Size = 20
  $tb3.TextFrame.TextRange.Font.Color.RGB = $colorDarkText

  # Slide 4: Reliability and governance
  $slide4 = $presentation.Slides.Add(4, $ppLayoutBlank)
  Set-SlideBackground $slide4 $colorWhite
  Add-HeaderBar $slide4 'Reliability, Safety, and Operations'

  $title4 = $slide4.Shapes.AddTextbox(1, 50, 62, 860, 52)
  $title4.TextFrame.TextRange.Text = 'Built For Stable Daily Campaign Execution'
  $title4.TextFrame.TextRange.Font.Name = $fontTitle
  $title4.TextFrame.TextRange.Font.Size = 33
  $title4.TextFrame.TextRange.Font.Color.RGB = $colorNavy

  $cols = @(
    @{ x=50; y=130; w=275; h=315; color=(RGBColor 235 246 255); title='Account Safety'; body='• Multi-account routing`n• Health scoring by outcomes`n• Quarantine restricted accounts`n• Replacement workflow' },
    @{ x=342; y=130; w=275; h=315; color=(RGBColor 235 250 246); title='Publishing Resilience'; body='• Retry policies + backoff`n• Dead-letter queue triage`n• Replay failed windows`n• Near-duplicate suppression' },
    @{ x=634; y=130; w=275; h=315; color=(RGBColor 255 245 232); title='Operations Control'; body='• Metrics + readiness checks`n• Connector health monitoring`n• Audit logs for every action`n• Retention and recovery runbooks' }
  )

  foreach ($c in $cols) {
    $card = $slide4.Shapes.AddShape($msoShapeRoundedRectangle, $c.x, $c.y, $c.w, $c.h)
    $card.Fill.Solid(); $card.Fill.ForeColor.RGB = $c.color
    $card.Line.ForeColor.RGB = RGBColor 205 219 232

    $ct = $slide4.Shapes.AddTextbox(1, $c.x + 18, $c.y + 16, $c.w - 36, 40)
    $ct.TextFrame.TextRange.Text = $c.title
    $ct.TextFrame.TextRange.Font.Name = $fontTitle
    $ct.TextFrame.TextRange.Font.Size = 22
    $ct.TextFrame.TextRange.Font.Color.RGB = $colorNavy

    $cb = $slide4.Shapes.AddTextbox(1, $c.x + 18, $c.y + 64, $c.w - 36, $c.h - 86)
    $cb.TextFrame.TextRange.Text = $c.body
    $cb.TextFrame.TextRange.Font.Name = $fontBody
    $cb.TextFrame.TextRange.Font.Size = 18
    $cb.TextFrame.TextRange.Font.Color.RGB = $colorDarkText
  }

  # Slide 5: Demo plan and next steps
  $slide5 = $presentation.Slides.Add(5, $ppLayoutBlank)
  Set-SlideBackground $slide5 $colorLight
  Add-HeaderBar $slide5 'Live Demo Plan (Postman + Dashboard Endpoints)'

  $title5 = $slide5.Shapes.AddTextbox(1, 50, 62, 860, 55)
  $title5.TextFrame.TextRange.Text = 'What We Will Demonstrate To The Client'
  $title5.TextFrame.TextRange.Font.Name = $fontTitle
  $title5.TextFrame.TextRange.Font.Size = 33
  $title5.TextFrame.TextRange.Font.Color.RGB = $colorNavy

  $left5 = $slide5.Shapes.AddShape($msoShapeRoundedRectangle, 50, 130, 560, 330)
  $left5.Fill.Solid(); $left5.Fill.ForeColor.RGB = $colorWhite
  $left5.Line.ForeColor.RGB = RGBColor 211 223 236

  $planText = "Demo sequence (API):`n1) /health/live and /health/ready`n2) POST /orchestration/run (sync)`n3) GET /orchestration/trends`n4) GET /orchestration/drafts`n5) GET /orchestration/publish/jobs`n6) GET /orchestration/dashboard/operations`n7) GET /accounts"
  $tb5l = $slide5.Shapes.AddTextbox(1, 78, 160, 500, 280)
  $tb5l.TextFrame.TextRange.Text = $planText
  $tb5l.TextFrame.TextRange.Font.Name = $fontBody
  $tb5l.TextFrame.TextRange.Font.Size = 20
  $tb5l.TextFrame.TextRange.Font.Color.RGB = $colorDarkText

  $right5 = $slide5.Shapes.AddShape($msoShapeRoundedRectangle, 635, 130, 275, 330)
  $right5.Fill.Solid(); $right5.Fill.ForeColor.RGB = $colorNavy
  $right5.Line.Visible = 0

  $tb5r = $slide5.Shapes.AddTextbox(1, 660, 162, 225, 260)
  $tb5r.TextFrame.TextRange.Text = "Success criteria`n`n• End-to-end run completes`n• Trends and drafts are visible`n• Publish jobs are scheduled`n• Operational controls are transparent`n• System is production-ready for managed rollout"
  $tb5r.TextFrame.TextRange.Font.Name = $fontBody
  $tb5r.TextFrame.TextRange.Font.Size = 18
  $tb5r.TextFrame.TextRange.Font.Color.RGB = $colorWhite

  $footer5 = $slide5.Shapes.AddTextbox(1, 50, 475, 860, 40)
  $footer5.TextFrame.TextRange.Text = 'Thank you. Questions and client-specific rollout planning next.'
  $footer5.TextFrame.TextRange.Font.Name = $fontTitle
  $footer5.TextFrame.TextRange.Font.Size = 18
  $footer5.TextFrame.TextRange.Font.Color.RGB = $colorBlue

  if (Test-Path -LiteralPath $outFile) {
    Remove-Item -LiteralPath $outFile -Force
  }

  $presentation.SaveAs($outFile)
  $presentation.Close()
  $ppt.Quit()

  Write-Output "CREATED: $outFile"
}
finally {
  if ($presentation -ne $null) {
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($presentation) | Out-Null
  }
  if ($ppt -ne $null) {
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($ppt) | Out-Null
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}

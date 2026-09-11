# Smoke: start server → /health → /v1/audio/speech → stop
param(
    [int]$Port = 8011,
    [string]$ModelsDir = "",
    [string]$BaseLmFile = "",
    [string]$AcousticFile = "",
    [string]$AlignerLmFile = "",
    [string]$AlignerAudioFile = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$OutDir = Join-Path $Root "outputs"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$Wav = Join-Path $OutDir "smoke.wav"
$BinDir = Join-Path $Root "bin"
$Server = Join-Path $BinDir "llama-tts-server.exe"
$Models = if ($ModelsDir) { $ModelsDir } else { Join-Path $Root "models" }
$BaseLm = if ($BaseLmFile) { $BaseLmFile } else { Join-Path $Models "VoxCPM2-BaseLM-Q8_0.gguf" }
$Acoustic = if ($AcousticFile) { $AcousticFile } else { Join-Path $Models "VoxCPM2-Acoustic-F16.gguf" }
$AlignerLm = if ($AlignerLmFile) {
    $AlignerLmFile
} else {
    @(
        (Join-Path $Models "Qwen3-Aligner-LM-Q8_0.gguf"),
        (Join-Path $Models "Qwen3-Aligner-LM-F16.gguf")
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
$AlignerAudio = if ($AlignerAudioFile) {
    $AlignerAudioFile
} else {
    Join-Path $Models "Qwen3-Aligner-Audio-F16.gguf"
}
$AlignerRequired = [bool]$AlignerLmFile -or [bool]$AlignerAudioFile
$Log = Join-Path $OutDir "smoke-server.log"

foreach ($p in @($Server, $BaseLm, $Acoustic)) {
    if (-not (Test-Path -LiteralPath $p)) { throw "Missing: $p" }
}
if ($AlignerRequired) {
    foreach ($p in @($AlignerLm, $AlignerAudio)) {
        if (-not $p -or -not (Test-Path -LiteralPath $p)) { throw "Missing configured aligner file: $p" }
    }
}

$cudaBin = "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.3\bin\x64"
$env:PATH = "$BinDir;$cudaBin;$env:PATH"

# Kill leftover on this port if any
Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

# Quote paths: "TTS Test" otherwise splits under Start-Process
$argParts = @(
    "--host", "127.0.0.1",
    "--port", $Port,
    "--voxcpm2-base-lm", "`"$BaseLm`"",
    "--voxcpm2-acoustic", "`"$Acoustic`"",
    "--voxcpm2-n-gpu-layers", "-1"
)
if ($AlignerLm -and (Test-Path -LiteralPath $AlignerLm) -and (Test-Path -LiteralPath $AlignerAudio)) {
    $argParts += @("--aligner-lm", "`"$AlignerLm`"", "--aligner-audio", "`"$AlignerAudio`"")
}
$argLine = $argParts -join " "

$proc = Start-Process -FilePath $Server `
    -ArgumentList $argLine `
    -WorkingDirectory $BinDir `
    -RedirectStandardOutput $Log `
    -RedirectStandardError "$Log.err" `
    -PassThru `
    -WindowStyle Hidden

Write-Host "Started pid=$($proc.Id) on :$Port"

try {
    $ok = $false
    for ($i = 0; $i -lt 90; $i++) {
        Start-Sleep -Seconds 2
        if ($proc.HasExited) {
            throw "Server exited early code=$($proc.ExitCode). See $Log / $Log.err"
        }
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
            Write-Host ("health ok after {0}s: {1}" -f (2 * ($i + 1)), ($h | ConvertTo-Json -Compress))
            $ok = $true
            break
        } catch {
            Write-Host ("waiting health... {0}s" -f (2 * ($i + 1)))
        }
    }
    if (-not $ok) { throw "Health check timed out" }

    $body = @{
        model            = "voxcpm2"
        input            = "你好，这是 VoxCPM2 最小环境冒烟测试。"
        voice            = "default"
        response_format  = "wav"
    } | ConvertTo-Json

    Write-Host "POST /v1/audio/speech ..."
    Invoke-WebRequest -Uri "http://127.0.0.1:$Port/v1/audio/speech" `
        -Method POST `
        -ContentType "application/json; charset=utf-8" `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) `
        -OutFile $Wav `
        -TimeoutSec 300

    $len = (Get-Item -LiteralPath $Wav).Length
    if ($len -lt 1000) { throw "WAV too small: $len bytes" }
    Write-Host "OK wrote $Wav ($len bytes)"
}
finally {
    if (-not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Write-Host "stopped pid=$($proc.Id)"
    }
}

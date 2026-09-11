# Minimal VoxCPM2 OpenAI-compatible server (llama-tts-server)
param(
    [int]$Port = 8001,
    [string]$HostAddr = "127.0.0.1",
    [int]$NGpuLayers = -1,
    [string]$ModelsDir = "",
    [string]$BaseLmFile = "",
    [string]$AcousticFile = "",
    [string]$AlignerLmFile = "",
    [string]$AlignerAudioFile = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$BinDir = Join-Path $Root "bin"
$Models = if ($ModelsDir) { $ModelsDir } else { Join-Path $Root "models" }
$Server = Join-Path $BinDir "llama-tts-server.exe"
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

foreach ($p in @($Server, $BaseLm, $Acoustic)) {
    if (-not (Test-Path -LiteralPath $p)) { throw "Missing: $p" }
}
if ($AlignerRequired) {
    foreach ($p in @($AlignerLm, $AlignerAudio)) {
        if (-not $p -or -not (Test-Path -LiteralPath $p)) { throw "Missing configured aligner file: $p" }
    }
}

# Prefer this package's DLLs; CUDA Toolkit provides cudart/cublas
$cudaBin = "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.3\bin\x64"
$env:PATH = "$BinDir;$cudaBin;$env:PATH"

Write-Host "VoxCPM2 server → http://${HostAddr}:$Port"
Write-Host "  BaseLM:   $BaseLm"
Write-Host "  Acoustic: $Acoustic"
Write-Host "  Binary:   $Server"

$ServerArgs = @(
    "--host", $HostAddr,
    "--port", $Port,
    "--voxcpm2-base-lm", $BaseLm,
    "--voxcpm2-acoustic", $Acoustic,
    "--voxcpm2-n-gpu-layers", $NGpuLayers
)
if ($AlignerLm -and (Test-Path -LiteralPath $AlignerLm) -and (Test-Path -LiteralPath $AlignerAudio)) {
    $ServerArgs += @("--aligner-lm", $AlignerLm, "--aligner-audio", $AlignerAudio)
    Write-Host "  Aligner:  $AlignerLm + $AlignerAudio"
}

Set-Location -LiteralPath $BinDir
& $Server @ServerArgs

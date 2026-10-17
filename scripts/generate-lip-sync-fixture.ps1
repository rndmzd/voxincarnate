param([string]$Voice = 'Microsoft Zira Desktop')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$fixtureDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\.qa'))
[IO.Directory]::CreateDirectory($fixtureDirectory) | Out-Null
$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $speech.SelectVoice($Voice)
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $destination = Join-Path $fixtureDirectory 'lip-sync-speech.wav'
  $speech.SetOutputToWaveFile($destination, $format)
  $speech.Speak('Mom bought me a blue balloon. We move five very vivid fish. You owe Lou a really wide smile. Ah. Ee. Oh. Oo. Pa. Ba. Ma. Hello, lovely little world.')
  $speech.SetOutputToNull()
  Write-Output $destination
} finally { $speech.Dispose() }

param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$ArtifactPath
)

$ErrorActionPreference = "Stop"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 24.x is required." }
$nodeVersion = (& node --version).TrimStart("v")
if ([int]$nodeVersion.Split('.')[0] -ne 24) { throw "Node.js 24.x is required." }

$temporaryDirectory = $null
try {
  $artifactDirectory = (Resolve-Path -LiteralPath $ArtifactPath).Path
  if ((Get-Item -LiteralPath $artifactDirectory).PSIsContainer -eq $false) {
    if (-not $artifactDirectory.EndsWith('.tgz')) { throw "Artifact must be a directory or .tgz archive." }
    $temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("caelush-install-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
    tar -xzf $artifactDirectory -C $temporaryDirectory
    $artifactDirectory = $temporaryDirectory
  }

  $manifestPath = Join-Path $artifactDirectory 'manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Artifact manifest.json is missing." }
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  $platform = if ($env:PROCESSOR_ARCHITECTURE -like 'ARM*') { 'unsupported' } else { 'windows' }
  if ($manifest.platform -ne $platform -or $manifest.arch -ne 'x64') { throw "Artifact platform does not match this system." }
  if (Test-Path -LiteralPath (Join-Path $artifactDirectory 'manifest.sha256')) {
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifestPath).Hash.ToLowerInvariant()
    $expectedHash = ((Get-Content -LiteralPath (Join-Path $artifactDirectory 'manifest.sha256')) -split '\s+')[0].ToLowerInvariant()
    if ($actualHash -ne $expectedHash) { throw "Artifact manifest checksum mismatch." }
  }
  $checksumsPath = Join-Path $artifactDirectory 'checksums.sha256'
  if (Test-Path -LiteralPath $checksumsPath) {
    $rootPath = (Resolve-Path -LiteralPath $artifactDirectory).Path.TrimEnd('\') + '\'
    foreach ($line in Get-Content -LiteralPath $checksumsPath) {
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      if ($line -notmatch '^(?<hash>[0-9a-fA-F]{64})\s{2}(?<relative>.+)$') { throw "Invalid artifact checksum record." }
      $targetPath = [System.IO.Path]::GetFullPath((Join-Path $artifactDirectory ($Matches.relative -replace '/', '\')))
      if (-not $targetPath.StartsWith($rootPath, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Artifact checksum path escapes the artifact." }
      $target = Get-Item -LiteralPath $targetPath
      if ($target.PSIsContainer -or ($target.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw "Artifact checksum target is not a regular file." }
      $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $targetPath).Hash.ToLowerInvariant()
      if ($actualHash -ne $Matches.hash.ToLowerInvariant()) { throw "Artifact checksum mismatch." }
    }
  }

  $installRoot = if ($env:CAELUSH_INSTALL_ROOT) { $env:CAELUSH_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA 'Caelush\versions' }
  $versionDirectory = Join-Path $installRoot $manifest.version
  $binDirectory = if ($env:CAELUSH_BIN_DIR) { $env:CAELUSH_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'Caelush\bin' }
  New-Item -ItemType Directory -Force -Path $installRoot, $binDirectory | Out-Null
  if (-not (Test-Path -LiteralPath $versionDirectory)) {
    New-Item -ItemType Directory -Path $versionDirectory | Out-Null
    Copy-Item -Recurse -Force -Path (Join-Path $artifactDirectory '*') -Destination $versionDirectory
  }
  $shimPath = Join-Path $binDirectory 'caelush.cmd'
  "@echo off`r`nnode `"$versionDirectory\bin\caelush`" %*`r`n" | Set-Content -Encoding ascii -LiteralPath $shimPath

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $pathParts = @($userPath -split ';' | Where-Object { $_ -ne '' })
  if ($pathParts -notcontains $binDirectory) {
    [Environment]::SetEnvironmentVariable('Path', (($pathParts + $binDirectory) -join ';'), 'User')
  }
  Write-Output "Caelush $($manifest.version) installed at $versionDirectory"
}
finally {
  if ($temporaryDirectory -and (Test-Path -LiteralPath $temporaryDirectory)) {
    Remove-Item -Recurse -Force -LiteralPath $temporaryDirectory
  }
}

[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)][ValidateNotNullOrEmpty()][string]$BundlePath,
  [Parameter(Mandatory = $false)][ValidateNotNullOrEmpty()][string]$ReuseProductRoot,
  [switch]$KeepStage
)

$ErrorActionPreference = "Stop"
$scriptRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $scriptRoot "../../.."))
$hostTempRoot = [IO.Path]::GetFullPath($env:TEMP)
$cacheRoot = Join-Path $hostTempRoot "caelush-d0c-cache"
$electronCache = Join-Path $cacheRoot "electron-cache"
$stageRoot = Join-Path $hostTempRoot ("caelush-d0c-stage-" + [guid]::NewGuid().ToString("N"))
$evidenceDirectory = Join-Path $cacheRoot "evidence"
$nodeVersion = "24.18.0"
$electronVersion = "44.7.0"
$nodeArchiveSha256 = "0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821"
$hostGitCommand = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$hostGitDirectory = if ($hostGitCommand) { Split-Path -Parent $hostGitCommand.Source } else { $null }

function Resolve-VerifiedDownload {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256
  )
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    $existingDigest = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($existingDigest -ne $ExpectedSha256) { throw "Cached archive SHA-256 mismatch: $Path" }
    return
  }
  $partialPath = "$Path.partial"
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Uri -OutFile $partialPath
    $downloadedDigest = (Get-FileHash -LiteralPath $partialPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($downloadedDigest -ne $ExpectedSha256) { throw "Downloaded archive SHA-256 mismatch." }
    Move-Item -LiteralPath $partialPath -Destination $Path
  }
  catch {
    Remove-Item -LiteralPath $partialPath -Force -ErrorAction SilentlyContinue
    throw
  }
}
if ([string]::IsNullOrWhiteSpace($BundlePath) -and [string]::IsNullOrWhiteSpace($ReuseProductRoot)) {
  throw "Pass either -BundlePath or -ReuseProductRoot."
}
if (![string]::IsNullOrWhiteSpace($BundlePath)) {
  $BundlePath = [IO.Path]::GetFullPath($BundlePath)
  if (!(Test-Path -LiteralPath $BundlePath -PathType Leaf)) {
    throw "Portable Caelush release archive not found: $BundlePath. Build the existing portable release as a separate build prerequisite; this POC does not invoke or modify the Release Builder."
  }
}

$nodeArchive = Join-Path $cacheRoot "node-v$nodeVersion-win-x64.zip"
$nodeExpandRoot = Join-Path $stageRoot "node-unpacked"
$productRoot = Join-Path $stageRoot "product"
$runtimeRoot = Join-Path $stageRoot "runtime"
$electronRoot = Join-Path $stageRoot "electron"
$appRoot = Join-Path $electronRoot "resources/app"
$pocDataRoot = Join-Path $stageRoot "test-data"
$evidencePath = Join-Path $evidenceDirectory ("windows-poc-" + (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + [guid]::NewGuid().ToString("N") + ".json")
$originalEnvironment = @{}
foreach ($name in @("PATH", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "electron_config_cache", "CAELUSH_POC_GIT_PATH", "CAELUSH_POC_EVIDENCE_FILE", "CAELUSH_POC_BUNDLE_SHA256", "CAELUSH_POC_PRODUCT_SOURCE", "CAELUSH_POC_NODE_ARCHIVE_SHA256", "CAELUSH_POC_ELECTRON_ARCHIVE_SHA256")) {
  $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

New-Item -ItemType Directory -Path $cacheRoot, $electronCache, $stageRoot, $productRoot, $runtimeRoot, $electronRoot, $appRoot, $pocDataRoot, $evidenceDirectory -Force | Out-Null

try {
  $bundleDigest = $null
  $productSource = "PORTABLE_ARCHIVE"
  if (![string]::IsNullOrWhiteSpace($BundlePath)) {
    $BundlePath = [IO.Path]::GetFullPath($BundlePath)
    $bundleDigest = (Get-FileHash -LiteralPath $BundlePath -Algorithm SHA256).Hash.ToLowerInvariant()
    & (Join-Path $env:SystemRoot "System32/tar.exe") -xzf $BundlePath -C $productRoot
    if ($LASTEXITCODE -ne 0) { throw "Portable Caelush release extraction failed with exit code $LASTEXITCODE." }
  }
  else {
    $ReuseProductRoot = [IO.Path]::GetFullPath($ReuseProductRoot)
    if (!(Test-Path -LiteralPath $ReuseProductRoot -PathType Container)) {
      throw "Reusable staged product directory not found: $ReuseProductRoot."
    }
    if ([IO.Path]::GetFullPath($ReuseProductRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) -eq $productRoot.TrimEnd([IO.Path]::DirectorySeparatorChar)) {
      throw "ReuseProductRoot must be outside the newly created POC stage."
    }
    Get-ChildItem -LiteralPath $ReuseProductRoot -Force | ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination $productRoot -Recurse -Force
    }
    $productSource = "REUSED_VERIFIED_PRODUCT_TREE"
  }
  $env:CAELUSH_POC_BUNDLE_SHA256 = $bundleDigest
  $env:CAELUSH_POC_PRODUCT_SOURCE = $productSource
  Resolve-VerifiedDownload `
    -Path $nodeArchive `
    -Uri "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip" `
    -ExpectedSha256 $nodeArchiveSha256

  $electronExeInPackage = Join-Path $scriptRoot "node_modules/electron/dist/electron.exe"
  $installedElectronVersion = $null
  if (Test-Path -LiteralPath $electronExeInPackage -PathType Leaf) {
    $installedElectronVersion = (Get-Content -LiteralPath (Join-Path $scriptRoot "node_modules/electron/package.json") -Raw | ConvertFrom-Json).version
  }
  if ($installedElectronVersion -ne $electronVersion -or !(Test-Path -LiteralPath $electronExeInPackage -PathType Leaf)) {
    $env:electron_config_cache = $electronCache
    & npm ci --prefix $scriptRoot --registry https://registry.npmjs.org/
    if ($LASTEXITCODE -ne 0) { throw "Pinned Electron npm install failed with exit code $LASTEXITCODE." }
  }
  $electronDist = Join-Path $scriptRoot "node_modules/electron/dist"
  $electronExeSource = Join-Path $electronDist "electron.exe"
  $installedElectronVersion = (Get-Content -LiteralPath (Join-Path $scriptRoot "node_modules/electron/package.json") -Raw | ConvertFrom-Json).version
  if ($installedElectronVersion -ne $electronVersion) { throw "Unexpected Electron version $installedElectronVersion." }
  $electronArchiveName = "electron-v$electronVersion-win32-x64.zip"
  $electronChecksums = Get-Content -LiteralPath (Join-Path $scriptRoot "node_modules/electron/checksums.json") -Raw | ConvertFrom-Json
  $electronArchiveSha256 = $electronChecksums.$electronArchiveName
  if ($electronArchiveSha256 -notmatch '^[0-9a-f]{64}$') { throw "Pinned Electron package has no valid Windows x64 archive checksum." }
  $electronZip = Join-Path $electronCache $electronArchiveName
  Resolve-VerifiedDownload `
    -Path $electronZip `
    -Uri "https://cdn.npmmirror.com/binaries/electron/v$electronVersion/$electronArchiveName" `
    -ExpectedSha256 $electronArchiveSha256
  New-Item -ItemType Directory -Path $electronDist -Force | Out-Null
  Expand-Archive -LiteralPath $electronZip -DestinationPath $electronDist -Force
  if (!(Test-Path -LiteralPath $electronExeSource -PathType Leaf)) { throw "Electron $electronVersion binary is missing from its verified archive." }

  $nodeArchiveDigest = (Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($nodeArchiveDigest -ne $nodeArchiveSha256) { throw "Bundled Node archive digest mismatch." }
  Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExpandRoot
  $nodeExeSource = Join-Path $nodeExpandRoot "node-v$nodeVersion-win-x64/node.exe"
  if (!(Test-Path -LiteralPath $nodeExeSource -PathType Leaf)) { throw "Node $nodeVersion executable is missing from the official archive." }
  Copy-Item -LiteralPath $nodeExeSource -Destination (Join-Path $runtimeRoot "node.exe")

  $releaseManifestPath = Join-Path $productRoot "manifest.json"
  $releaseManifest = Get-Content -LiteralPath $releaseManifestPath -Raw | ConvertFrom-Json
  if ($releaseManifest.version -ne "0.1.0" -or $releaseManifest.platform -ne "windows" -or $releaseManifest.arch -ne "x64") {
    throw "The input release manifest is not Caelush 0.1.0 Windows x64."
  }
  $manifestHashLine = Get-Content -LiteralPath (Join-Path $productRoot "manifest.sha256") -Raw
  $manifestDigest = (Get-FileHash -LiteralPath $releaseManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($manifestHashLine -notmatch ("(?m)^" + [regex]::Escape($manifestDigest) + "\s+manifest\.json\s*$")) {
    throw "The portable release Manifest hash does not match its checksum file."
  }
  $runnerManifestPath = Join-Path $productRoot "sandbox-runner/manifest.json"
  $runnerPath = Join-Path $productRoot "sandbox-runner/caelush-sandbox-runner.exe"
  if (!(Test-Path -LiteralPath $runnerPath -PathType Leaf) -or !(Test-Path -LiteralPath $runnerManifestPath -PathType Leaf)) {
    throw "The input portable release is missing its Sandbox Runner or Manifest."
  }

  Copy-Item -Path (Join-Path $electronDist "*") -Destination $electronRoot -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $scriptRoot "poc-main.cjs") -Destination $appRoot
  Copy-Item -LiteralPath (Join-Path $scriptRoot "poc-child.mjs") -Destination $appRoot
  Copy-Item -LiteralPath (Join-Path $scriptRoot "poc-ipc.cjs") -Destination $appRoot
  Copy-Item -LiteralPath (Join-Path $scriptRoot "pty-smoke.mjs") -Destination $appRoot
  Copy-Item -LiteralPath (Join-Path $scriptRoot "poc-electron-node-probe.mjs") -Destination $appRoot
  Copy-Item -LiteralPath (Join-Path $scriptRoot "sandbox-smoke.mjs") -Destination $appRoot
  Copy-Item -LiteralPath (Join-Path $scriptRoot "sqlite-check.mjs") -Destination $appRoot
  $electronAppManifest = @{
    name = "caelush-windows-desktop-feasibility-poc"
    version = "0.1.0"
    private = $true
    main = "poc-main.cjs"
  } | ConvertTo-Json
  Set-Content -LiteralPath (Join-Path $appRoot "package.json") -Value $electronAppManifest -Encoding utf8

  $electronArchiveDigest = (Get-FileHash -LiteralPath $electronZip -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($electronArchiveDigest -ne $electronArchiveSha256) { throw "Verified Electron archive hash changed after extraction." }

  $env:PATH = Join-Path $env:SystemRoot "System32"
  $env:TEMP = $pocDataRoot
  $env:TMP = $pocDataRoot
  $env:APPDATA = Join-Path $pocDataRoot "appdata"
  $env:LOCALAPPDATA = Join-Path $pocDataRoot "localappdata"
  if ($hostGitDirectory) { $env:CAELUSH_POC_GIT_PATH = $hostGitDirectory }
  $env:CAELUSH_POC_EVIDENCE_FILE = $evidencePath
  $env:CAELUSH_POC_BUNDLE_SHA256 = $bundleDigest
  $env:CAELUSH_POC_NODE_ARCHIVE_SHA256 = $nodeArchiveDigest
  $env:CAELUSH_POC_ELECTRON_ARCHIVE_SHA256 = $electronArchiveDigest

  $electronExe = Join-Path $electronRoot "electron.exe"
  $app = Join-Path $electronRoot "resources/app"
  $pocStdout = Join-Path $stageRoot "poc.stdout.log"
  $pocStderr = Join-Path $stageRoot "poc.stderr.log"
  $electronProcess = Start-Process `
    -FilePath $electronExe `
    -ArgumentList ('"' + $app + '"') `
    -RedirectStandardOutput $pocStdout `
    -RedirectStandardError $pocStderr `
    -PassThru `
    -Wait `
    -WindowStyle Hidden
  $pocExitCode = $electronProcess.ExitCode
  if (Test-Path -LiteralPath $pocStdout -PathType Leaf) {
    Get-Content -LiteralPath $pocStdout -Raw
  }
  if (Test-Path -LiteralPath $pocStderr -PathType Leaf) {
    Get-Content -LiteralPath $pocStderr -Raw
  }
  if ($pocExitCode -ne 0) { throw "Electron POC exited with code $pocExitCode." }
  if (!(Test-Path -LiteralPath $evidencePath -PathType Leaf)) { throw "Electron POC did not write its evidence JSON." }
  Write-Output "POC_EVIDENCE=$evidencePath"
  Get-Content -LiteralPath $evidencePath -Raw
}
finally {
  foreach ($name in $originalEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], "Process")
  }
  if (!$KeepStage -and (Test-Path -LiteralPath $stageRoot)) {
    $stageFullPath = [IO.Path]::GetFullPath($stageRoot)
    $tempFullPath = [IO.Path]::GetFullPath($hostTempRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (!$stageFullPath.StartsWith($tempFullPath, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove a POC staging directory outside the host temp directory."
    }
    Remove-Item -LiteralPath $stageFullPath -Recurse -Force
  }
  elseif ($KeepStage -and (Test-Path -LiteralPath $stageRoot)) {
    Write-Output "POC_STAGE=$stageRoot"
  }
}

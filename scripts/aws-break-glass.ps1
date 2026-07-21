[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('dev', 'test')]
  [string]$Stage,

  [Parameter(Mandatory = $true)]
  [string]$Confirmation,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d{6}$')]
  [string]$MfaCode,

  [string]$AdminProfile = 'zoolanding',
  [string]$Region = 'us-east-1',
  [string]$AccountId = '765932874577',
  [string]$HectorMfaArn = 'arn:aws:iam::765932874577:mfa/HectorPhone'
)

$ErrorActionPreference = 'Stop'
if ($Confirmation -cne "DESTROY $Stage") {
  throw "Refusing destructive operation; pass -Confirmation 'DESTROY $Stage'."
}
if ($AccountId -ne '765932874577' -or $Region -ne 'us-east-1') {
  throw 'This runbook is locked to AWS account 765932874577 in us-east-1.'
}

$awsCommand = Get-Command aws -ErrorAction SilentlyContinue
if ($awsCommand) {
  $awsCli = $awsCommand.Source
} else {
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw 'AWS CLI v2 was not found in PATH and LOCALAPPDATA is unavailable.'
  }
  $awsCli = Join-Path $env:LOCALAPPDATA 'Programs\Amazon\AWSCLIV2\aws.exe'
  if (-not (Test-Path -LiteralPath $awsCli -PathType Leaf)) {
    throw "AWS CLI v2 was not found in PATH or at $awsCli."
  }
}
$awsVersion = & $awsCli --version 2>&1
if ($LASTEXITCODE -ne 0 -or "$awsVersion" -notmatch '^aws-cli/2\.') {
  throw "RoadMap2U break-glass requires AWS CLI v2; found: $awsVersion"
}
$effectiveCaBundle = $env:AWS_CA_BUNDLE
if ([string]::IsNullOrWhiteSpace("$effectiveCaBundle")) {
  $profileCaBundle = & $awsCli configure get ca_bundle --profile $AdminProfile
  $profileCaBundleExitCode = $LASTEXITCODE
  if (
    $profileCaBundleExitCode -notin @(0, 1) -or
    ($profileCaBundleExitCode -eq 1 -and -not [string]::IsNullOrWhiteSpace("$profileCaBundle"))
  ) {
    throw "Reading the AWS CA bundle for profile $AdminProfile failed with exit code $profileCaBundleExitCode."
  }
  $effectiveCaBundle = $profileCaBundle
}
if (-not [string]::IsNullOrWhiteSpace("$effectiveCaBundle")) {
  $effectiveCaBundle = [Environment]::ExpandEnvironmentVariables("$effectiveCaBundle".Trim())
  if (-not (Test-Path -LiteralPath $effectiveCaBundle -PathType Leaf)) {
    throw "The effective AWS CA bundle does not exist: $effectiveCaBundle"
  }
  $effectiveCaBundle = (Resolve-Path -LiteralPath $effectiveCaBundle).Path
} else {
  $effectiveCaBundle = $null
}

function Assert-LastCommand([string]$Description) {
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code $LASTEXITCODE."
  }
}

function Test-BucketExists([string]$BucketName, [string]$TemporaryDirectory) {
  $errorPath = Join-Path $TemporaryDirectory 'head-bucket.err'
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $awsCli s3api head-bucket `
      --region $Region `
      --bucket $BucketName 2> $errorPath
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -eq 0) {
    return $true
  }

  $details = if (Test-Path -LiteralPath $errorPath) {
    Get-Content -LiteralPath $errorPath -Raw
  } else {
    ''
  }
  if ($details -match '(404|Not Found|NoSuchBucket)') {
    return $false
  }
  throw "Checking bucket $BucketName failed with exit code $exitCode`: $details"
}

function Clear-VersionedBucket([string]$BucketName, [string]$TemporaryDirectory) {
  $page = 0
  while ($true) {
    $page++
    $inventoryJson = & $awsCli s3api list-object-versions `
      --region $Region `
      --bucket $BucketName `
      --max-keys 1000 `
      --no-paginate `
      --output json
    Assert-LastCommand "Listing object versions page $page in $BucketName"
    $inventory = $inventoryJson | ConvertFrom-Json
    $entries = @($inventory.Versions) + @($inventory.DeleteMarkers) |
      Where-Object { $null -ne $_ -and -not [string]::IsNullOrWhiteSpace($_.Key) }
    if (@($entries).Count -eq 0) {
      return
    }

    $deleteRequest = @{
      Objects = @($entries | ForEach-Object {
        @{ Key = [string]$_.Key; VersionId = [string]$_.VersionId }
      })
      Quiet = $true
    }
    $deletePath = Join-Path $TemporaryDirectory "delete-page-$page.json"
    $deleteJson = $deleteRequest | ConvertTo-Json -Depth 6
    [IO.File]::WriteAllText($deletePath, $deleteJson, [Text.UTF8Encoding]::new($false))

    $responseJson = & $awsCli s3api delete-objects `
      --region $Region `
      --bucket $BucketName `
      --delete "file://$deletePath" `
      --output json
    Assert-LastCommand "Deleting object versions page $page from $BucketName"
    $response = $responseJson | ConvertFrom-Json
    if ($null -ne $response.Errors -and @($response.Errors).Count -ne 0) {
      throw "S3 reported one or more failed version deletions in $BucketName."
    }
  }
}

function Test-StackExists([string]$StackName, [string]$TemporaryDirectory) {
  $safeName = $StackName -replace '[^A-Za-z0-9-]', '_'
  $errorPath = Join-Path $TemporaryDirectory "$safeName.err"
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $awsCli cloudformation describe-stacks `
      --region $Region `
      --stack-name $StackName `
      --query 'Stacks[0].StackStatus' `
      --output text 2> $errorPath | Out-Null
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -eq 0) {
    return $true
  }

  $details = if (Test-Path -LiteralPath $errorPath) {
    Get-Content -LiteralPath $errorPath -Raw
  } else {
    ''
  }
  if ($details -match 'ValidationError' -and $details -match 'does not exist') {
    return $false
  }
  throw "Checking stack $StackName failed with exit code $exitCode`: $details"
}

$roleArn = "arn:aws:iam::$AccountId`:role/roadmap2u/operations/roadmap2u-nonprod-break-glass"
$credentialsJson = & $awsCli sts assume-role `
  --profile $AdminProfile `
  --region $Region `
  --role-arn $roleArn `
  --role-session-name "roadmap2u-$Stage-break-glass" `
  --duration-seconds 3600 `
  --serial-number $HectorMfaArn `
  --token-code $MfaCode `
  --query Credentials `
  --output json
Assert-LastCommand 'Assuming the RoadMap2U non-production break-glass role'
$credentials = $credentialsJson | ConvertFrom-Json

$previous = @{
  AccessKey = $env:AWS_ACCESS_KEY_ID
  SecretKey = $env:AWS_SECRET_ACCESS_KEY
  SessionToken = $env:AWS_SESSION_TOKEN
  Region = $env:AWS_REGION
  CaBundle = $env:AWS_CA_BUNDLE
  Profile = $env:AWS_PROFILE
  DefaultProfile = $env:AWS_DEFAULT_PROFILE
}
$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) (
  'roadmap2u-break-glass-' + [Guid]::NewGuid()
)
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
$env:AWS_ACCESS_KEY_ID = $credentials.AccessKeyId
$env:AWS_SECRET_ACCESS_KEY = $credentials.SecretAccessKey
$env:AWS_SESSION_TOKEN = $credentials.SessionToken
$env:AWS_REGION = $Region
$env:AWS_CA_BUNDLE = $effectiveCaBundle
$env:AWS_PROFILE = $AdminProfile
$env:AWS_DEFAULT_PROFILE = $AdminProfile

try {
  $callerAccount = & $awsCli sts get-caller-identity --query Account --output text
  Assert-LastCommand 'Verifying the break-glass AWS account'
  if ($callerAccount -ne $AccountId) {
    throw "Refusing account $callerAccount; expected $AccountId."
  }

  $bucket = "roadmap2u-$Stage-$AccountId"
  if (Test-BucketExists $bucket $temporaryDirectory) {
    Clear-VersionedBucket $bucket $temporaryDirectory
  } else {
    Write-Host "Bucket $bucket does not exist; continuing the resumable teardown."
  }

  foreach ($stackName in @("Roadmap-$Stage-Hosting", "Roadmap-$Stage-Backend")) {
    if (Test-StackExists $stackName $temporaryDirectory) {
      & $awsCli cloudformation delete-stack `
        --region $Region `
        --stack-name $stackName
      Assert-LastCommand "Starting or continuing deletion of $stackName"
      & $awsCli cloudformation wait stack-delete-complete `
        --region $Region `
        --stack-name $stackName
      Assert-LastCommand "Waiting for deletion of $stackName"
    } else {
      Write-Host "Stack $stackName does not exist; continuing the resumable teardown."
    }
  }
} finally {
  $env:AWS_ACCESS_KEY_ID = $previous.AccessKey
  $env:AWS_SECRET_ACCESS_KEY = $previous.SecretKey
  $env:AWS_SESSION_TOKEN = $previous.SessionToken
  $env:AWS_REGION = $previous.Region
  $env:AWS_CA_BUNDLE = $previous.CaBundle
  $env:AWS_PROFILE = $previous.Profile
  $env:AWS_DEFAULT_PROFILE = $previous.DefaultProfile

  if (Test-Path -LiteralPath $temporaryDirectory) {
    $resolvedTemporaryPath = (Resolve-Path -LiteralPath $temporaryDirectory).Path
    $resolvedTempRoot = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path
    if (-not $resolvedTemporaryPath.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove non-temporary path $resolvedTemporaryPath."
    }
    Remove-Item -LiteralPath $resolvedTemporaryPath -Recurse -Force
  }
}

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('dev', 'test', 'prod')]
  [string]$Stage,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^us-east-1_[A-Za-z0-9]+$')]
  [string]$UserPoolId,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^smoke_[a-z0-9_]{1,14}$')]
  [string]$Username,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
  [string]$UserId,

  [Parameter(Mandatory = $true)]
  [string]$Confirmation,

  [string]$AdminProfile = 'zoolanding',
  [string]$Region = 'us-east-1',
  [string]$AccountId = '765932874577',
  [string]$HectorMfaArn = 'arn:aws:iam::765932874577:mfa/HectorPhone',
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d{6}$')]
  [string]$MfaCode
)

$ErrorActionPreference = 'Stop'
$expectedConfirmation = "DELETE SMOKE $Stage $Username"
if ($Confirmation -cne $expectedConfirmation) {
  throw "Refusing cleanup. Pass -Confirmation '$expectedConfirmation'."
}
if ($Region -cne 'us-east-1' -or $AccountId -cne '765932874577') {
  throw 'RoadMap2U smoke cleanup is fixed to account 765932874577 in us-east-1.'
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
  throw "RoadMap2U smoke cleanup requires AWS CLI v2; found: $awsVersion"
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

function Get-UserPartitionItems(
  [string]$TableName,
  [string]$PartitionKey,
  [string]$TemporaryDirectory
) {
  $valuesPath = Join-Path $TemporaryDirectory 'query-values.json'
  @{ ':pk' = @{ S = $PartitionKey } } |
    ConvertTo-Json -Depth 4 |
    Set-Content -LiteralPath $valuesPath -Encoding ascii

  $items = @()
  $exclusiveStartKey = $null
  do {
    $arguments = @(
      'dynamodb', 'query',
      '--region', $Region,
      '--table-name', $TableName,
      '--key-condition-expression', 'pk = :pk',
      '--expression-attribute-values', "file://$valuesPath",
      '--projection-expression', 'pk, sk',
      '--no-paginate',
      '--output', 'json'
    )
    if ($null -ne $exclusiveStartKey) {
      $exclusiveStartKeyPath = Join-Path $TemporaryDirectory 'exclusive-start-key.json'
      $exclusiveStartKey |
        ConvertTo-Json -Depth 8 |
        Set-Content -LiteralPath $exclusiveStartKeyPath -Encoding ascii
      $arguments += @('--exclusive-start-key', "file://$exclusiveStartKeyPath")
    }

    $pageJson = & $awsCli @arguments
    Assert-LastCommand "Querying $PartitionKey from $TableName"
    $page = $pageJson | ConvertFrom-Json
    $items += @($page.Items)
    $exclusiveStartKey = $page.LastEvaluatedKey
  } while (
    $null -ne $exclusiveStartKey -and
    $exclusiveStartKey.PSObject.Properties.Count -gt 0
  )

  return ,$items
}

function Remove-UserPartitionItems(
  [string]$TableName,
  [array]$Items,
  [string]$TemporaryDirectory
) {
  for ($index = 0; $index -lt $Items.Count; $index++) {
    $item = $Items[$index]
    $keyPath = Join-Path $TemporaryDirectory "delete-key-$index.json"
    @{
      pk = @{ S = [string]$item.pk.S }
      sk = @{ S = [string]$item.sk.S }
    } |
      ConvertTo-Json -Depth 5 |
      Set-Content -LiteralPath $keyPath -Encoding ascii

    & $awsCli dynamodb delete-item `
      --region $Region `
      --table-name $TableName `
      --key "file://$keyPath"
    Assert-LastCommand "Deleting smoke record $($item.pk.S)/$($item.sk.S) from $TableName"
  }
}

$callerJson = & $awsCli sts get-caller-identity `
  --profile $AdminProfile `
  --region $Region `
  --output json
Assert-LastCommand 'Checking the administrator identity'
$caller = $callerJson | ConvertFrom-Json
if ($caller.Account -cne $AccountId) {
  throw "AWS profile $AdminProfile points to account $($caller.Account), not $AccountId."
}

$roleArn = "arn:aws:iam::$AccountId`:role/roadmap2u/$Stage/operations/roadmap2u-$Stage-smoke-cleanup"
$credentialsJson = & $awsCli sts assume-role `
  --profile $AdminProfile `
  --region $Region `
  --role-arn $roleArn `
  --role-session-name "roadmap2u-$Stage-smoke-cleanup" `
  --duration-seconds 3600 `
  --serial-number $HectorMfaArn `
  --token-code $MfaCode `
  --query Credentials `
  --output json
Assert-LastCommand 'Assuming roadmap2u-smoke-cleanup'
$credentials = $credentialsJson | ConvertFrom-Json

$previous = @{
  AccessKey = $env:AWS_ACCESS_KEY_ID
  SecretKey = $env:AWS_SECRET_ACCESS_KEY
  SessionToken = $env:AWS_SESSION_TOKEN
  Region = $env:AWS_REGION
  CaBundle = $env:AWS_CA_BUNDLE
}
$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) (
  'roadmap2u-smoke-cleanup-' + [Guid]::NewGuid()
)
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null

try {
  $env:AWS_ACCESS_KEY_ID = $credentials.AccessKeyId
  $env:AWS_SECRET_ACCESS_KEY = $credentials.SecretAccessKey
  $env:AWS_SESSION_TOKEN = $credentials.SessionToken
  $env:AWS_REGION = $Region
  $env:AWS_CA_BUNDLE = $effectiveCaBundle

  $configuredPoolId = & $awsCli ssm get-parameter `
    --region $Region `
    --name "/roadmap2u/$Stage/user-pool-id" `
    --query 'Parameter.Value' `
    --output text
  Assert-LastCommand "Reading the $Stage User Pool ID"
  if ($configuredPoolId.Trim() -cne $UserPoolId) {
    throw "User Pool $UserPoolId is not the configured $Stage pool."
  }

  $userJson = & $awsCli cognito-idp admin-get-user `
    --region $Region `
    --user-pool-id $UserPoolId `
    --username $Username `
    --output json
  Assert-LastCommand "Reading smoke user $Username"
  $user = $userJson | ConvertFrom-Json
  $actualSub = ($user.UserAttributes | Where-Object { $_.Name -ceq 'sub' }).Value
  if ($actualSub -cne $UserId) {
    throw "Cognito user $Username has sub $actualSub, not the requested $UserId."
  }

  $tableName = "roadmap-$Stage"
  $partitionKey = "USER#$UserId"
  $items = @(Get-UserPartitionItems $tableName $partitionKey $temporaryDirectory)
  if ($items.Count -gt 0) {
    Remove-UserPartitionItems $tableName $items $temporaryDirectory
  }

  $reservationKeyPath = Join-Path $temporaryDirectory 'username-reservation-key.json'
  $reservationNamesPath = Join-Path $temporaryDirectory 'username-reservation-names.json'
  $reservationValuesPath = Join-Path $temporaryDirectory 'username-reservation-values.json'
  @{
    pk = @{ S = "UNIQ#USERNAME#$($Username.ToLowerInvariant())" }
    sk = @{ S = 'UNIQ' }
  } |
    ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath $reservationKeyPath -Encoding ascii
  @{ '#pk' = 'pk'; '#uid' = 'userId' } |
    ConvertTo-Json -Depth 3 |
    Set-Content -LiteralPath $reservationNamesPath -Encoding ascii
  @{ ':expectedUserId' = @{ S = $UserId } } |
    ConvertTo-Json -Depth 4 |
    Set-Content -LiteralPath $reservationValuesPath -Encoding ascii
  & $awsCli dynamodb delete-item `
    --region $Region `
    --table-name $tableName `
    --key "file://$reservationKeyPath" `
    --condition-expression 'attribute_not_exists(#pk) OR #uid = :expectedUserId' `
    --expression-attribute-names "file://$reservationNamesPath" `
    --expression-attribute-values "file://$reservationValuesPath"
  Assert-LastCommand "Deleting the $Username reservation"

  $remaining = @(Get-UserPartitionItems $tableName $partitionKey $temporaryDirectory)
  if ($remaining.Count -ne 0) {
    throw "Smoke cleanup verification found $($remaining.Count) remaining $partitionKey records."
  }

  & $awsCli cognito-idp admin-delete-user `
    --region $Region `
    --user-pool-id $UserPoolId `
    --username $Username
  Assert-LastCommand "Deleting smoke user $Username"
  Write-Host "Deleted Cognito user $Username and its $Stage DynamoDB records."
} finally {
  $env:AWS_ACCESS_KEY_ID = $previous.AccessKey
  $env:AWS_SECRET_ACCESS_KEY = $previous.SecretKey
  $env:AWS_SESSION_TOKEN = $previous.SessionToken
  $env:AWS_REGION = $previous.Region
  $env:AWS_CA_BUNDLE = $previous.CaBundle

  if (Test-Path -LiteralPath $temporaryDirectory) {
    $resolvedTemporaryPath = (Resolve-Path -LiteralPath $temporaryDirectory).Path
    $resolvedTempRoot = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path
    if (-not $resolvedTemporaryPath.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove non-temporary path $resolvedTemporaryPath."
    }
    Remove-Item -LiteralPath $resolvedTemporaryPath -Recurse -Force
  }
}

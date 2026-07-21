[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('create-operator', 'deploy-control-plane', 'deploy-stage-toolkits', 'deploy-all', 'delete-operator')]
  [string]$Phase,

  [string]$AdminProfile = 'zoolanding',
  [string]$Region = 'us-east-1',
  [string]$AccountId = '765932874577',
  [string]$HostedZoneId = 'Z08619612LYY2MSBEZSCQ',
  [string]$HectorAdminPrincipalArn = 'arn:aws:iam::765932874577:user/Hector-admin',
  [string]$HectorMfaArn = 'arn:aws:iam::765932874577:mfa/HectorPhone',
  [string]$MfaCode
)

$ErrorActionPreference = 'Stop'
if (
  $AccountId -cne '765932874577' -or
  $Region -cne 'us-east-1' -or
  $HostedZoneId -cne 'Z08619612LYY2MSBEZSCQ' -or
  $HectorAdminPrincipalArn -cne 'arn:aws:iam::765932874577:user/Hector-admin' -or
  $HectorMfaArn -cne 'arn:aws:iam::765932874577:mfa/HectorPhone'
) {
  throw 'RoadMap2U bootstrap identifiers are immutable; refuse account, region, zone, principal, or MFA overrides.'
}
$repoRoot = Split-Path -Parent $PSScriptRoot
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
  throw "RoadMap2U bootstrap requires AWS CLI v2; found: $awsVersion"
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
$operatorStackName = 'RoadMap2U-BootstrapOperator'
$operatorRoleArn = "arn:aws:iam::$AccountId`:role/roadmap2u/bootstrap/RoadMap2U-BootstrapOperator"
$controlPlaneBucket = "roadmap2u-bootstrap-templates-$AccountId-$Region"

function Assert-LastCommand([string]$Description) {
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code $LASTEXITCODE."
  }
}

$callerJson = & $awsCli sts get-caller-identity `
  --profile $AdminProfile `
  --region $Region `
  --output json
Assert-LastCommand 'Checking the Hector-admin bootstrap identity'
$caller = $callerJson | ConvertFrom-Json
if ($caller.Account -cne $AccountId -or $caller.Arn -cne $HectorAdminPrincipalArn) {
  throw "AWS profile $AdminProfile must resolve exactly to $HectorAdminPrincipalArn in $AccountId."
}

function Assert-GitHubOidcProvider {
  $providerArn = "arn:aws:iam::$AccountId`:oidc-provider/token.actions.githubusercontent.com"
  $providerJson = & $awsCli iam get-open-id-connect-provider `
    --profile $AdminProfile `
    --region $Region `
    --open-id-connect-provider-arn $providerArn `
    --output json
  Assert-LastCommand 'Reading the existing GitHub Actions OIDC provider'
  $provider = $providerJson | ConvertFrom-Json
  if ($provider.Url -ne 'token.actions.githubusercontent.com') {
    throw "Unexpected GitHub Actions OIDC provider URL: $($provider.Url)"
  }
  if (
    @($provider.ClientIDList).Count -ne 1 -or
    $provider.ClientIDList -notcontains 'sts.amazonaws.com'
  ) {
    throw 'The existing GitHub Actions OIDC provider client list must be exactly sts.amazonaws.com.'
  }
}

function Enter-BootstrapOperatorSession {
  if ([string]::IsNullOrWhiteSpace($MfaCode) -or $MfaCode -notmatch '^\d{6}$') {
    throw 'deploy-control-plane, deploy-stage-toolkits, and deploy-all require -MfaCode with six digits.'
  }

  $credentialsJson = & $awsCli sts assume-role `
    --profile $AdminProfile `
    --region $Region `
    --role-arn $operatorRoleArn `
    --role-session-name 'roadmap2u-bootstrap' `
    --duration-seconds 3600 `
    --serial-number $HectorMfaArn `
    --token-code $MfaCode `
    --query Credentials `
    --output json
  Assert-LastCommand 'Assuming RoadMap2U-BootstrapOperator'
  $credentials = $credentialsJson | ConvertFrom-Json

  $previous = @{
    AccessKey = $env:AWS_ACCESS_KEY_ID
    SecretKey = $env:AWS_SECRET_ACCESS_KEY
    SessionToken = $env:AWS_SESSION_TOKEN
    Region = $env:AWS_REGION
    CaBundle = $env:AWS_CA_BUNDLE
  }
  $env:AWS_ACCESS_KEY_ID = $credentials.AccessKeyId
  $env:AWS_SECRET_ACCESS_KEY = $credentials.SecretAccessKey
  $env:AWS_SESSION_TOKEN = $credentials.SessionToken
  $env:AWS_REGION = $Region
  if (-not [string]::IsNullOrWhiteSpace("$effectiveCaBundle")) {
    $env:AWS_CA_BUNDLE = $effectiveCaBundle
  }
  return $previous
}

function Exit-BootstrapOperatorSession([hashtable]$Previous) {
  $env:AWS_ACCESS_KEY_ID = $Previous.AccessKey
  $env:AWS_SECRET_ACCESS_KEY = $Previous.SecretKey
  $env:AWS_SESSION_TOKEN = $Previous.SessionToken
  $env:AWS_REGION = $Previous.Region
  $env:AWS_CA_BUNDLE = $Previous.CaBundle
}

function Remove-FailedControlPlaneStack {
  $recoverableControlPlaneStates = @('ROLLBACK_COMPLETE', 'ROLLBACK_FAILED')
  $stackStatus = & $awsCli cloudformation list-stacks `
    --region $Region `
    --stack-status-filter $recoverableControlPlaneStates `
    --query "StackSummaries[?StackName=='Roadmap-CiBootstrap'] | [0].StackStatus" `
    --output text
  Assert-LastCommand 'Checking Roadmap-CiBootstrap recovery state'

  if ($stackStatus -in $recoverableControlPlaneStates) {
    & $awsCli cloudformation delete-stack `
      --region $Region `
      --stack-name 'Roadmap-CiBootstrap'
    Assert-LastCommand 'Starting failed Roadmap-CiBootstrap recovery deletion'
    & $awsCli cloudformation wait stack-delete-complete `
      --region $Region `
      --stack-name 'Roadmap-CiBootstrap'
    Assert-LastCommand 'Waiting for failed Roadmap-CiBootstrap recovery deletion'
  }
}

if ($Phase -eq 'create-operator') {
  & $awsCli cloudformation deploy `
    --profile $AdminProfile `
    --region $Region `
    --stack-name $operatorStackName `
    --template-file (Join-Path $repoRoot 'bootstrap\bootstrap-operator.template.json') `
    --parameter-overrides "HectorAdminPrincipalArn=$HectorAdminPrincipalArn" `
    --capabilities CAPABILITY_NAMED_IAM `
    --no-fail-on-empty-changeset
  Assert-LastCommand 'Creating the temporary bootstrap operator'
  exit 0
}

if ($Phase -eq 'delete-operator') {
  & $awsCli s3 rm `
    "s3://$controlPlaneBucket/control-plane/" `
    --recursive `
    --profile $AdminProfile `
    --region $Region
  Assert-LastCommand 'Emptying the temporary control-plane template prefix'
  & $awsCli cloudformation delete-stack `
    --profile $AdminProfile `
    --region $Region `
    --stack-name $operatorStackName
  Assert-LastCommand 'Starting temporary bootstrap operator deletion'
  & $awsCli cloudformation wait stack-delete-complete `
    --profile $AdminProfile `
    --region $Region `
    --stack-name $operatorStackName
  Assert-LastCommand 'Waiting for temporary bootstrap operator deletion'
  exit 0
}

if ($Phase -in @('deploy-control-plane', 'deploy-all')) {
  Assert-GitHubOidcProvider
}

$previousCredentials = Enter-BootstrapOperatorSession
try {
  if ($Phase -in @('deploy-control-plane', 'deploy-all')) {
    Remove-FailedControlPlaneStack
    $npxCommand = Get-Command npx.cmd -ErrorAction SilentlyContinue
    if (-not $npxCommand) {
      $npxCommand = Get-Command npx -ErrorAction Stop
    }
    $assemblyDirectory = Join-Path ([IO.Path]::GetTempPath()) ("roadmap2u-control-plane-" + [Guid]::NewGuid())
    New-Item -ItemType Directory -Path $assemblyDirectory | Out-Null
    try {
      Push-Location $repoRoot
      try {
        & $npxCommand.Source --no-install cdk synth Roadmap-CiBootstrap `
          --exclusively `
          --quiet `
          --output $assemblyDirectory `
          -c 'stage=dev' `
          -c "AWS_ACCOUNT_ID=$AccountId" `
          -c "HOSTED_ZONE_ID=$HostedZoneId"
        Assert-LastCommand 'Bootstrapless Roadmap-CiBootstrap synth'
      } finally {
        Pop-Location
      }

      $controlPlaneTemplate = Join-Path $assemblyDirectory 'Roadmap-CiBootstrap.template.json'
      if (-not (Test-Path -LiteralPath $controlPlaneTemplate)) {
        throw "Synth did not produce $controlPlaneTemplate."
      }
      & $awsCli cloudformation deploy `
        --region $Region `
        --stack-name 'Roadmap-CiBootstrap' `
        --template-file $controlPlaneTemplate `
        --s3-bucket $controlPlaneBucket `
        --s3-prefix 'control-plane' `
        --capabilities CAPABILITY_NAMED_IAM `
        --no-fail-on-empty-changeset
      Assert-LastCommand 'Deploying Roadmap-CiBootstrap directly with CloudFormation'
      & $awsCli cloudformation update-termination-protection `
        --region $Region `
        --stack-name 'Roadmap-CiBootstrap' `
        --enable-termination-protection
      Assert-LastCommand 'Protecting Roadmap-CiBootstrap'
    } finally {
      if (Test-Path -LiteralPath $assemblyDirectory) {
        $resolvedTemporaryPath = (Resolve-Path -LiteralPath $assemblyDirectory).Path
        $resolvedTempRoot = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path
        if (-not $resolvedTemporaryPath.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
          throw "Refusing to remove non-temporary path $resolvedTemporaryPath."
        }
        Remove-Item -LiteralPath $resolvedTemporaryPath -Recurse -Force
      }
    }
  }

  if ($Phase -in @('deploy-stage-toolkits', 'deploy-all')) {
    $toolkits = @(
      @{ Stage = 'dev'; Stack = 'RoadMap2U-CDK-dev' },
      @{ Stage = 'test'; Stack = 'RoadMap2U-CDK-test' },
      @{ Stage = 'prod'; Stack = 'RoadMap2U-CDK-prod' }
    )
    foreach ($toolkit in $toolkits) {
      $template = Join-Path $repoRoot "bootstrap\roadmap2u-$($toolkit.Stage)-bootstrap.template.json"
      & $awsCli cloudformation deploy `
        --region $Region `
        --stack-name $toolkit.Stack `
        --template-file $template `
        --capabilities CAPABILITY_NAMED_IAM `
        --no-fail-on-empty-changeset
      Assert-LastCommand "Deploying $($toolkit.Stack)"
      & $awsCli cloudformation update-termination-protection `
        --region $Region `
        --stack-name $toolkit.Stack `
        --enable-termination-protection
      Assert-LastCommand "Protecting $($toolkit.Stack)"
    }
  }
} finally {
  Exit-BootstrapOperatorSession $previousCredentials
}

# Every AWS account this tool runs in, and the Lambdas in each that run a
# given image. Dot-sourced by ai/mcpServer/deploy.ps1 and
# ai/sppDataSync/deploy.ps1 -- both build ONE image, then push it to every
# enabled target's own ECR and point that target's functions at it.
#
# The accounts are independent, parallel installs of the same tool (not a
# primary/replica pair): each has its own Cognito, data bucket, SSM params
# and DynamoDB tables. Only the code is shared.
#
# Profile is an AWS CLI profile name ("aws configure list-profiles").
# A target with Enabled = $false is skipped unless named via -Target.
#
# Function names: add a new customer's function here when they get a stack
# in that account (see each template's ResourceSuffix). rbreaux's
# mcp-server stack uses "-rbreaux-2fb4", not "-rbreaux-2f4b" like its
# sppDataSync sibling -- confirmed these really differ, not a typo; the
# second account keeps the same names on purpose so both stay identical.

$CustomerMcpFunctions = @(
  "sppMcpServer",
  "sppMcpServer-bgb",
  "sppMcpServer-rbreaux-2fb4",
  "sppMcpServer-med-learning-group-llc",
  "sppMcpServer-rbreaux-4781"
)

$CustomerSyncFunctions = @(
  "sppDataSync",
  "sppDataSync-bgb",
  "sppDataSync-rbreaux-2f4b",
  "sppDataSync-med-learning-group-llc",
  "sppDataSync-rbreaux-4781",
  "sppDataSync-triton"
)

$DeployTargets = @(
  @{
    Name      = "original"
    AccountId = "776528084998"
    Region    = "us-east-2"
    Profile   = "default"
    Enabled   = $true
    Functions = @{ "spp-mcp-server" = $CustomerMcpFunctions; "spp-data-sync" = $CustomerSyncFunctions }
  },
  @{
    Name      = "second"
    AccountId = "836629854711"
    Region    = "us-east-1"
    Profile   = "spp-second"
    Enabled   = $true
    Functions = @{ "spp-mcp-server" = $CustomerMcpFunctions; "spp-data-sync" = $CustomerSyncFunctions }
  }
)

# Native commands (docker, aws) don't throw on failure in PowerShell --
# they just set $LASTEXITCODE and keep going, so $ErrorActionPreference
# alone doesn't stop the script. Confirmed happening in practice: a failed
# `docker push` (403, not logged in to ECR) let the script fall through to
# `update-function-code`, which happily pointed the Lambda at the ":latest"
# tag that was still the OLD image -- reporting "Done" while deploying
# nothing. Every native call below is followed by a check against this.
function Assert-Success($StepName) {
  if ($LASTEXITCODE -ne 0) {
    throw "$StepName failed (exit code $LASTEXITCODE) -- aborting, nothing further was touched."
  }
}

function Resolve-DeployTargets([string[]]$Target) {
  if ($Target) {
    $unknown = $Target | Where-Object { ($DeployTargets.Name) -notcontains $_ }
    if ($unknown) {
      throw "Unknown -Target: $($unknown -join ', ') -- must be one of: $($DeployTargets.Name -join ', ')"
    }
    return $DeployTargets | Where-Object { $Target -contains $_.Name }
  }
  return $DeployTargets | Where-Object { $_.Enabled }
}

# Pushes the already-built local image $RepoName:latest to each target's ECR
# and updates that target's functions to it (all of them, or just -Only).
# -PushOnly stops after the push -- for a new account whose functions don't
# exist yet (ai/account-setup/setup-account.ps1 creates them from the image).
function Publish-ImageToTargets([string]$RepoName, [string[]]$Target, [string[]]$Only, [switch]$PushOnly) {
  $targets = @(Resolve-DeployTargets $Target)
  if (-not $targets) { throw "No deploy targets selected." }

  if ($Only) {
    $known = $targets | ForEach-Object { $_.Functions[$RepoName] }
    $unknown = $Only | Where-Object { $known -notcontains $_ }
    if ($unknown) {
      throw "Unknown function name(s) for -Only: $($unknown -join ', ') -- must be one of: $(($known | Select-Object -Unique) -join ', ')"
    }
  }

  $total = 0
  foreach ($t in $targets) {
    $Region = $t.Region
    $AwsArgs = @("--region", $Region, "--profile", $t.Profile)
    $RegistryHost = "$($t.AccountId).dkr.ecr.$Region.amazonaws.com"
    $ImageUri = "$RegistryHost/$RepoName`:latest"
    $FunctionNames = $t.Functions[$RepoName]
    if ($Only) { $FunctionNames = $FunctionNames | Where-Object { $Only -contains $_ } }

    Write-Host "=== Target '$($t.Name)' ($($t.AccountId), $Region) ===" -ForegroundColor Magenta

    # Guard against a profile pointing at the wrong account -- pushing a
    # build into someone else's ECR, or updating the wrong account's
    # same-named functions, is exactly what two parallel installs invite.
    $callerAccount = aws sts get-caller-identity @AwsArgs --query Account --output text
    Assert-Success "sts get-caller-identity ($($t.Name))"
    if ($callerAccount -ne $t.AccountId) {
      throw "Profile '$($t.Profile)' is account $callerAccount, but target '$($t.Name)' expects $($t.AccountId) -- aborting."
    }

    Write-Host "Authenticating to ECR..." -ForegroundColor Cyan
    # Piped through cmd.exe rather than PowerShell's own pipeline --
    # PowerShell re-encodes a native command's piped output, which silently
    # corrupts the ECR auth token and makes `docker login` fail with an
    # opaque "400 Bad Request" (confirmed manually: the identical command
    # succeeds every time run through cmd.exe or bash, and fails every time
    # through a native PowerShell pipe).
    cmd /c "aws ecr get-login-password --region $Region --profile $($t.Profile) | docker login --username AWS --password-stdin $RegistryHost"
    Assert-Success "docker login ($($t.Name))"

    Write-Host "Tagging image..." -ForegroundColor Cyan
    docker tag "$RepoName`:latest" $ImageUri
    Assert-Success "docker tag ($($t.Name))"

    Write-Host "Pushing to ECR..." -ForegroundColor Cyan
    docker push $ImageUri
    Assert-Success "docker push ($($t.Name))"

    # Ask ECR itself (not the local docker CLI) what digest ":latest" now
    # resolves to, and deploy every function against that fixed digest
    # rather than the mutable tag. That's what makes the post-deploy check
    # below meaningful -- comparing a function's CodeSha256 against a tag
    # that could move out from under us wouldn't actually confirm anything.
    $digest = aws ecr describe-images --repository-name $RepoName @AwsArgs `
      --image-ids imageTag=latest --query "imageDetails[0].imageDigest" --output text
    Assert-Success "ecr describe-images ($($t.Name))"
    if (-not $digest -or $digest -eq "None") {
      throw "Could not resolve the pushed image's digest from ECR -- aborting."
    }
    $DigestUri = "$RegistryHost/$RepoName@$digest"
    $expectedSha = $digest -replace '^sha256:', ''
    Write-Host "Resolved digest: $digest" -ForegroundColor Cyan

    if ($PushOnly) { continue }

    foreach ($FunctionName in $FunctionNames) {
      Write-Host "Updating $FunctionName..." -ForegroundColor Cyan
      aws lambda update-function-code --function-name $FunctionName --image-uri $DigestUri @AwsArgs --query "LastUpdateStatus" --output text
      Assert-Success "update-function-code ($FunctionName, $($t.Name))"

      aws lambda wait function-updated --function-name $FunctionName @AwsArgs
      Assert-Success "wait function-updated ($FunctionName, $($t.Name))"

      # Belt-and-suspenders: update-function-code reporting success is not
      # the same as the function actually running this build (see the
      # docker-push failure above -- a step "succeeding" while doing the
      # wrong thing is exactly the failure mode this exists to catch).
      # Confirm the deployed CodeSha256 actually matches what we just pushed.
      $actualSha = aws lambda get-function-configuration --function-name $FunctionName @AwsArgs --query "CodeSha256" --output text
      Assert-Success "get-function-configuration ($FunctionName, $($t.Name))"
      if ($actualSha -ne $expectedSha) {
        throw "$FunctionName ($($t.Name)) is on CodeSha256 $actualSha, expected $expectedSha -- deploy did not take effect as expected."
      }
      Write-Host "$FunctionName confirmed on digest $actualSha" -ForegroundColor Green
      $total++
    }
  }

  Write-Host "Done -- $total function(s) across $($targets.Count) target(s) verified on the new image." -ForegroundColor Green
}

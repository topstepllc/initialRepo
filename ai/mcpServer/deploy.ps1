# -Only limits the rollout to the named function(s) from $FunctionNames
# below, e.g. to try a change on one customer before the rest:
#   .\deploy.ps1 -Only sppMcpServer-rbreaux-4781
param(
  [string[]]$Only
)

$ErrorActionPreference = "Stop"

$AccountId = "776528084998"
$Region = "us-east-2"
$RepoName = "spp-mcp-server"
$RegistryHost = "$AccountId.dkr.ecr.$Region.amazonaws.com"
$ImageUri = "$RegistryHost/$RepoName`:latest"

# Every customer's Lambda that runs this same image -- see
# mcp-server-infra.yaml's ResourceSuffix param, which is how each
# customer's stack names its own copy ("sppMcpServer" + suffix). Add a new
# customer's function name here when they get a stack; this script builds
# ONE image, then deploys it to every function listed. (rbreaux's mcp-server
# stack uses "-rbreaux-2fb4", not "-rbreaux-2f4b" like its sppDataSync
# sibling -- confirmed these two suffixes really do differ for that
# customer, not a typo here.)
$FunctionNames = @(
  "sppMcpServer",
  "sppMcpServer-bgb",
  "sppMcpServer-rbreaux-2fb4",
  "sppMcpServer-med-learning-group-llc",
  "sppMcpServer-rbreaux-4781"
)

if ($Only) {
  $unknown = $Only | Where-Object { $FunctionNames -notcontains $_ }
  if ($unknown) {
    throw "Unknown function name(s) for -Only: $($unknown -join ', ') -- must be one of: $($FunctionNames -join ', ')"
  }
  $FunctionNames = $Only
}

# Native commands (docker, aws) don't throw on failure in PowerShell --
# they just set $LASTEXITCODE and keep going, so $ErrorActionPreference
# alone doesn't stop the script. Confirmed happening in practice on the
# sppDataSync sibling of this script: a failed `docker push` (403, not
# logged in to ECR) let the script fall through to `update-function-code`,
# which happily pointed the Lambda at the ":latest" tag that was still the
# OLD image -- reporting "Done" while deploying nothing. Every native call
# below is followed by a check against this.
function Assert-Success($StepName) {
  if ($LASTEXITCODE -ne 0) {
    throw "$StepName failed (exit code $LASTEXITCODE) -- aborting, nothing further was touched."
  }
}

$env:AWS_PAGER = ""

# Build context is the REPO ROOT, not this folder -- the Dockerfile reaches
# into ai/aiQueryReports (DuckDB tool logic) and layer/nodejs (SPP OAuth
# utilities) to reuse both without duplicating them.
Push-Location "$PSScriptRoot\..\.."
try {
  Write-Host "Building image..." -ForegroundColor Cyan
  docker buildx build --platform linux/amd64 --provenance=false --output=type=docker `
    -f ai/mcpServer/Dockerfile -t $RepoName .
  Assert-Success "docker build"
} finally {
  Pop-Location
}

Write-Host "Authenticating to ECR..." -ForegroundColor Cyan
# Piped through cmd.exe rather than PowerShell's own pipeline -- PowerShell
# re-encodes a native command's piped output, which silently corrupts the
# ECR auth token and makes `docker login` fail with an opaque "400 Bad
# Request" (confirmed manually: the identical command succeeds every time
# run through cmd.exe or bash, and fails every time through a native
# PowerShell pipe).
cmd /c "aws ecr get-login-password --region $Region | docker login --username AWS --password-stdin $RegistryHost"
Assert-Success "docker login"

Write-Host "Tagging image..." -ForegroundColor Cyan
docker tag "$RepoName`:latest" $ImageUri
Assert-Success "docker tag"

Write-Host "Pushing to ECR..." -ForegroundColor Cyan
docker push $ImageUri
Assert-Success "docker push"

# Ask ECR itself (not the local docker CLI) what digest ":latest" now
# resolves to, and deploy every function against that fixed digest rather
# than the mutable tag. That's what makes the post-deploy check below
# meaningful -- comparing a function's CodeSha256 against a tag that could
# move out from under us wouldn't actually confirm anything.
$digest = aws ecr describe-images --repository-name $RepoName --region $Region `
  --image-ids imageTag=latest --query "imageDetails[0].imageDigest" --output text
Assert-Success "ecr describe-images"
if (-not $digest -or $digest -eq "None") {
  throw "Could not resolve the pushed image's digest from ECR -- aborting."
}
$DigestUri = "$RegistryHost/$RepoName@$digest"
$expectedSha = $digest -replace '^sha256:', ''
Write-Host "Resolved digest: $digest" -ForegroundColor Cyan

foreach ($FunctionName in $FunctionNames) {
  Write-Host "Updating $FunctionName..." -ForegroundColor Cyan
  aws lambda update-function-code --function-name $FunctionName --image-uri $DigestUri --region $Region --query "LastUpdateStatus" --output text
  Assert-Success "update-function-code ($FunctionName)"

  aws lambda wait function-updated --function-name $FunctionName --region $Region
  Assert-Success "wait function-updated ($FunctionName)"

  # Belt-and-suspenders: update-function-code reporting success is not the
  # same as the function actually running this build (see the docker-push
  # failure above -- a step "succeeding" while doing the wrong thing is
  # exactly the failure mode this script now exists to catch). Confirm the
  # deployed CodeSha256 actually matches what we just pushed.
  $actualSha = aws lambda get-function-configuration --function-name $FunctionName --region $Region --query "CodeSha256" --output text
  Assert-Success "get-function-configuration ($FunctionName)"
  if ($actualSha -ne $expectedSha) {
    throw "$FunctionName is on CodeSha256 $actualSha, expected $expectedSha -- deploy did not take effect as expected."
  }
  Write-Host "$FunctionName confirmed on digest $actualSha" -ForegroundColor Green
}

Write-Host "Done -- all $($FunctionNames.Count) functions verified on the new image." -ForegroundColor Green

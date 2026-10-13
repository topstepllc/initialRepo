# Builds the spp-data-sync image once and deploys it to every enabled
# account in ai/deploy-targets.ps1.
#   -Only   limits the rollout to the named function(s):
#             .\deploy.ps1 -Only sppDataSync-bgb
#   -Target limits it to the named account(s) (also how to reach one whose
#           Enabled is still $false):
#             .\deploy.ps1 -Target second
#   -PushOnly builds and pushes without updating any function.
param(
  [string[]]$Only,
  [string[]]$Target,
  [switch]$PushOnly
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\..\deploy-targets.ps1"

$RepoName = "spp-data-sync"
$env:AWS_PAGER = ""

# Build context is the REPO ROOT, not this folder -- the Dockerfile reaches
# into layer/nodejs to reuse the SPP OAuth utilities without duplicating them.
Push-Location "$PSScriptRoot\..\.."
try {
  Write-Host "Building image..." -ForegroundColor Cyan
  docker buildx build --platform linux/amd64 --provenance=false --output=type=docker `
    -f ai/sppDataSync/Dockerfile -t $RepoName .
  Assert-Success "docker build"
} finally {
  Pop-Location
}

Publish-ImageToTargets -RepoName $RepoName -Target $Target -Only $Only -PushOnly:$PushOnly

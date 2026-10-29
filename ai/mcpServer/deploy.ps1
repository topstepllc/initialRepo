# Builds the spp-mcp-server image once and deploys it to every enabled
# account in ai/deploy-targets.ps1.
#   -Only   limits the rollout to the named function(s), e.g. to try a
#           change on one customer before the rest:
#             .\deploy.ps1 -Only sppMcpServer-rbreaux-4781
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

$RepoName = "spp-mcp-server"
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

Publish-ImageToTargets -RepoName $RepoName -Target $Target -Only $Only -PushOnly:$PushOnly

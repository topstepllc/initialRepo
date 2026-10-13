# Stands up a complete, independent copy of the SPP AI tool in another AWS
# account, cloned from the original account's live stacks. The two installs
# run side by side -- nothing here modifies the source account; it is only
# read from.
#
# Usage (from anywhere):
#   .\setup-account.ps1 -DataBucket <globally-unique-name>
#   .\setup-account.ps1 -DataBucket <name> -Steps Stacks,Data   # rerun some
#
# Target account/region/profile come from the "second" entry in
# ai/deploy-targets.ps1, source from "original" -- fill in its AccountId
# and Profile there first.
#
# Steps, in order (each is safe to rerun; Data refuses to overwrite a
# customer whose sync has already started running in the target):
#   Preflight     both profiles reach the expected accounts; Lambda quota
#   Bootstrap     account-bootstrap.yaml + dynamodb-tables.yaml
#   OAuthLambdas  oauth-lambdas.yaml (callback + getAuthorizationUrl + layer)
#   Secrets       SSM /spp/{customer}/* params; base oauth_config rows with
#                 redirect_uri pointed at this account's callback
#   Images        build + push both images to the target's ECR
#   Stacks        every spp-data-sync-infra* / spp-mcp-server* stack, same
#                 names and parameters as the source except account-specific ones
#   Data          sync watermarks, then S3 spp-data/{company}/ + static/,
#                 then aiTerms* rows
#   AuthLinks     prints one SPP authorization link per company-level
#                 integration key -- open each once to give that customer's
#                 sync its own token in this account
param(
  [Parameter(Mandatory)][string]$DataBucket,
  [string]$Target = "second",
  [string]$Source = "original",
  [string[]]$Steps = @("Preflight", "Bootstrap", "OAuthLambdas", "Secrets", "Images", "Stacks", "Data", "AuthLinks"),
  # Cognito hosted-UI prefixes are globally unique, so the source's
  # "topstep-<x>-mcp" can't be reused; "topstep-" becomes "$CognitoPrefix-".
  [string]$CognitoPrefix = "topstep2",
  # Only consumed by reportEngine.js's module-level Anthropic client
  # constructor -- the MCP tools never call it (see mcp-server-infra.yaml).
  [string]$AnthropicApiKey = "unused"
)

$ErrorActionPreference = "Stop"
$env:AWS_PAGER = ""
$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
. "$RepoRoot\ai\deploy-targets.ps1"

$SrcT = $DeployTargets | Where-Object { $_.Name -eq $Source }
$DstT = $DeployTargets | Where-Object { $_.Name -eq $Target }
if (-not $SrcT -or -not $DstT) { throw "Unknown -Source/-Target -- see ai/deploy-targets.ps1." }
$Src = @{ Profile = $SrcT.Profile; Region = $SrcT.Region }
$Dst = @{ Profile = $DstT.Profile; Region = $DstT.Region }

$Work = Join-Path $env:TEMP "spp-account-setup-$Target"
New-Item -ItemType Directory -Force $Work | Out-Null
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

# ---------------------------------------------------------------- helpers

function AwsJson([hashtable]$Ctx, [string[]]$Cmd) {
  $out = & aws @Cmd --profile $Ctx.Profile --region $Ctx.Region --output json
  if ($LASTEXITCODE -ne 0) { throw "aws $($Cmd[0]) $($Cmd[1]) failed (exit $LASTEXITCODE)" }
  $text = ($out -join "`n").Trim()
  if (-not $text) { return $null }
  return $text | ConvertFrom-Json
}

# JSON goes through files, never inline args: Windows PowerShell 5.1 mangles
# embedded quotes on native calls, and CLI shorthand splits values on
# commas (e.g. "spp-med learning group, llc-prod").
function JsonFile($Object, [string]$Name) {
  $path = Join-Path $Work $Name
  [IO.File]::WriteAllText($path, (ConvertTo-Json -InputObject $Object -Depth 40 -Compress), $Utf8NoBom)
  return "file://" + ($path -replace '\\', '/')
}

function Get-StackOutput([hashtable]$Ctx, [string]$Stack, [string]$Key) {
  $s = AwsJson $Ctx @("cloudformation", "describe-stacks", "--stack-name", $Stack)
  return ($s.Stacks[0].Outputs | Where-Object { $_.OutputKey -eq $Key }).OutputValue
}

function Publish-Stack([string]$Template, [string]$Stack, [hashtable]$Params, [string]$Capability = "CAPABILITY_IAM") {
  Write-Host "Deploying stack $Stack..." -ForegroundColor Cyan
  $list = @($Params.GetEnumerator() | ForEach-Object { @{ ParameterKey = $_.Key; ParameterValue = [string]$_.Value } })
  $cmd = @("cloudformation", "deploy", "--template-file", "$RepoRoot\$Template", "--stack-name", $Stack,
    "--capabilities", $Capability, "--no-fail-on-empty-changeset")
  if ($list.Count) { $cmd += @("--parameter-overrides", (JsonFile $list "params-$Stack.json")) }
  & aws @cmd --profile $Dst.Profile --region $Dst.Region
  if ($LASTEXITCODE -ne 0) { throw "Stack $Stack failed -- see its events in the target account's CloudFormation console." }
}

function Copy-DynamoTable([string]$SrcTable, [string]$DstTable) {
  $items = @((AwsJson $Src @("dynamodb", "scan", "--table-name", $SrcTable)).Items | Where-Object { $_ })
  Write-Host "  $SrcTable -> $DstTable ($($items.Count) items)"
  for ($i = 0; $i -lt $items.Count; $i += 25) {
    $batch = $items[$i..([Math]::Min($i + 24, $items.Count - 1))]
    $request = @{ $DstTable = @($batch | ForEach-Object { @{ PutRequest = @{ Item = $_ } } }) }
    for ($attempt = 1; ; $attempt++) {
      $res = AwsJson $Dst @("dynamodb", "batch-write-item", "--request-items", (JsonFile $request "batch.json"))
      $left = @($res.UnprocessedItems.PSObject.Properties)
      if (-not $left.Count) { break }
      if ($attempt -ge 8) { throw "batch-write-item kept returning UnprocessedItems for $DstTable" }
      Start-Sleep -Seconds $attempt
      $request = @{ $DstTable = $res.UnprocessedItems.$DstTable }
    }
  }
}

# Source stacks drive everything below -- whatever customers exist there
# get cloned, with the same stack names and parameter values.
function Get-SourceStacks([string]$Prefix) {
  $all = AwsJson $Src @("cloudformation", "describe-stacks")
  # UPDATE_ROLLBACK_COMPLETE is a healthy, running stack -- only skip ones
  # that never came up or are going away.
  $dead = @("CREATE_FAILED", "ROLLBACK_IN_PROGRESS", "ROLLBACK_FAILED", "ROLLBACK_COMPLETE",
    "DELETE_IN_PROGRESS", "DELETE_FAILED", "DELETE_COMPLETE")
  return @($all.Stacks | Where-Object {
      $_.StackName -like "$Prefix*" -and $dead -notcontains $_.StackStatus
    } | ForEach-Object {
      $p = @{}; foreach ($kv in $_.Parameters) { $p[$kv.ParameterKey] = $kv.ParameterValue }
      [pscustomobject]@{ Name = $_.StackName; Params = $p }
    })
}

function Step([string]$Name) { return $Steps -contains $Name }

# ---------------------------------------------------------------- steps

if (Step "Preflight") {
  Write-Host "=== Preflight ===" -ForegroundColor Magenta
  $srcAcct = (AwsJson $Src @("sts", "get-caller-identity")).Account
  $dstAcct = (AwsJson $Dst @("sts", "get-caller-identity")).Account
  if ($srcAcct -ne $SrcT.AccountId) { throw "Source profile '$($Src.Profile)' is account $srcAcct, expected $($SrcT.AccountId)." }
  if ($dstAcct -ne $DstT.AccountId) { throw "Target profile '$($Dst.Profile)' is account $dstAcct, expected $($DstT.AccountId) -- set AccountId in ai/deploy-targets.ps1." }
  if ($srcAcct -eq $dstAcct) { throw "Source and target are the same account." }

  # Every sync function reserves 1 concurrent execution, and AWS keeps at
  # least 100 unreserved -- new accounts often start at a limit of 10.
  $syncCount = (Get-SourceStacks "spp-data-sync-infra").Count
  $limit = (AwsJson $Dst @("lambda", "get-account-settings")).AccountLimit.ConcurrentExecutions
  if ($limit -lt 100 + $syncCount) {
    throw "Target Lambda concurrency limit is $limit; needs at least $(100 + $syncCount). Request an increase in Service Quotas (Lambda > Concurrent executions) for $($Dst.Region)."
  }
  & docker version --format "{{.Server.Version}}" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Docker isn't running." }
  Write-Host "OK: source $srcAcct, target $dstAcct ($($Dst.Region)), concurrency limit $limit." -ForegroundColor Green
}

if (Step "Bootstrap") {
  Write-Host "=== Bootstrap ===" -ForegroundColor Magenta
  Publish-Stack "account-bootstrap.yaml" "spp-account-bootstrap" @{ DataBucketName = $DataBucket } "CAPABILITY_NAMED_IAM"
  Publish-Stack "dynamodb-tables.yaml" "oauth-tables" @{}
}

$RoleArn = { Get-StackOutput $Dst "spp-account-bootstrap" "ExecutionRoleArn" }

if (Step "OAuthLambdas") {
  Write-Host "=== OAuth Lambdas ===" -ForegroundColor Magenta
  # Windows' bundled bsdtar writes zips with forward-slash paths (PS 5.1's
  # Compress-Archive uses backslashes, which Lambda can't unpack).
  $tar = "$env:SystemRoot\System32\tar.exe"
  $stage = Join-Path $Work "oauth-stage"
  Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force "$stage\layer\nodejs" | Out-Null
  Copy-Item "$RepoRoot\layer\nodejs\*" "$stage\layer\nodejs" -Recurse

  $zips = @{
    LayerKey                 = @{ Dir = "$stage\layer"; Entry = "nodejs"; Name = "sharedUtils-layer" }
    GetAuthorizationUrlKey   = @{ Dir = "$RepoRoot\tslib\tslib-getAuthorizationUrl"; Entry = "getAuthorizationUrl.mjs"; Name = "getAuthorizationUrl" }
    ExchangeCodeForTokensKey = @{ Dir = "$RepoRoot\tslib\tslib-exchangeCodeForTokens"; Entry = "exchangeCodeForTokens.mjs"; Name = "exchangeCodeForTokens" }
  }
  $params = @{ ArtifactBucket = $DataBucket; LambdaExecutionRoleArn = (& $RoleArn) }
  foreach ($k in $zips.Keys) {
    $z = $zips[$k]; $zip = Join-Path $Work "$($z.Name).zip"
    Remove-Item $zip -ErrorAction SilentlyContinue
    & $tar -a -c -f $zip -C $z.Dir $z.Entry
    if ($LASTEXITCODE -ne 0) { throw "zip of $($z.Name) failed" }
    # Content-addressed key, so a changed file actually changes the stack.
    $hash = (Get-FileHash $zip -Algorithm SHA256).Hash.Substring(0, 16).ToLower()
    $key = "_deploy/oauth/$($z.Name)-$hash.zip"
    & aws s3 cp $zip "s3://$DataBucket/$key" --profile $Dst.Profile --region $Dst.Region --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw "upload of $key failed" }
    $params[$k] = $key
  }
  Publish-Stack "oauth-lambdas.yaml" "spp-oauth-lambdas" $params
}

if (Step "Secrets") {
  Write-Host "=== Secrets ===" -ForegroundColor Magenta
  $callback = Get-StackOutput $Dst "spp-oauth-lambdas" "CallbackUrl"
  $sync = Get-SourceStacks "spp-data-sync-infra"
  $mcp = Get-SourceStacks "spp-mcp-server"

  # SSM: every param directly under each stack's SSMParamPrefix. Values are
  # written via a temp file (never printed or put on a command line) and
  # the file is deleted straight after.
  $prefixes = @($sync + $mcp | ForEach-Object { $_.Params.SSMParamPrefix } | Sort-Object -Unique)
  foreach ($prefix in $prefixes) {
    $ps = @((AwsJson $Src @("ssm", "get-parameters-by-path", "--path", $prefix, "--with-decryption")).Parameters)
    Write-Host "  SSM $prefix ($($ps.Count) params)"
    foreach ($p in $ps) {
      $f = JsonFile @{ Name = $p.Name; Value = $p.Value; Type = "SecureString"; Overwrite = $true } "ssm.json"
      try { AwsJson $Dst @("ssm", "put-parameter", "--cli-input-json", $f) | Out-Null }
      finally { Remove-Item (Join-Path $Work "ssm.json") -ErrorAction SilentlyContinue }
    }
  }

  # oauth_config: only the company-level base rows (client id/secret/urls),
  # redirect_uri pointed at THIS account's callback. Per-user rows get
  # cloned from these on first connect; tokens are never copied.
  $keys = @($sync | ForEach-Object { $_.Params.SyncIntegrationKey }) + @($mcp | ForEach-Object { $_.Params.SppBaseOAuthConfigKey })
  foreach ($key in ($keys | Where-Object { $_ } | Sort-Object -Unique)) {
    $item = (AwsJson $Src @("dynamodb", "get-item", "--table-name", "oauth_config", "--key", (JsonFile @{ pk = @{ S = $key } } "key.json"))).Item
    if (-not $item) { Write-Warning "  oauth_config '$key' missing in source -- skipped"; continue }
    $item.PSObject.Properties.Remove("state")
    $item.redirect_uri = @{ S = $callback }
    try { AwsJson $Dst @("dynamodb", "put-item", "--table-name", "oauth_config", "--item", (JsonFile $item "item.json")) | Out-Null }
    finally { Remove-Item (Join-Path $Work "item.json") -ErrorAction SilentlyContinue }
    Write-Host "  oauth_config '$key'"
  }
}

if (Step "Images") {
  Write-Host "=== Images ===" -ForegroundColor Magenta
  & "$RepoRoot\ai\mcpServer\deploy.ps1" -Target $Target -PushOnly
  & "$RepoRoot\ai\sppDataSync\deploy.ps1" -Target $Target -PushOnly
}

function Get-ImageDigestUri([string]$Repo) {
  $d = (AwsJson $Dst @("ecr", "describe-images", "--repository-name", $Repo, "--image-ids", "imageTag=latest")).imageDetails[0].imageDigest
  return "$($DstT.AccountId).dkr.ecr.$($Dst.Region).amazonaws.com/$Repo@$d"
}

if (Step "Stacks") {
  Write-Host "=== Stacks ===" -ForegroundColor Magenta
  $role = & $RoleArn
  $syncImage = Get-ImageDigestUri "spp-data-sync"
  $mcpImage = Get-ImageDigestUri "spp-mcp-server"

  foreach ($s in Get-SourceStacks "spp-data-sync-infra") {
    $p = $s.Params.Clone()
    $p.SppDataSyncImageUri = $syncImage
    $p.LambdaExecutionRoleArn = $role
    $p.DataBucket = $DataBucket
    Publish-Stack "spp-data-sync-infra.yaml" $s.Name $p
  }
  foreach ($s in Get-SourceStacks "spp-mcp-server") {
    $p = $s.Params.Clone()
    $p.McpServerImageUri = $mcpImage
    $p.LambdaExecutionRoleArn = $role
    $p.DataBucket = $DataBucket
    $p.CreateTermsTable = "true"
    $p.AnthropicApiKey = $AnthropicApiKey
    $p.CognitoDomainPrefix = $p.CognitoDomainPrefix -replace '^topstep-', "$CognitoPrefix-"
    Publish-Stack "mcp-server-infra.yaml" $s.Name $p
  }
}

if (Step "Data") {
  Write-Host "=== Data ===" -ForegroundColor Magenta
  foreach ($s in Get-SourceStacks "spp-data-sync-infra") {
    $company = $s.Params.SyncCompany
    $table = "sppSyncWatermarks$($s.Params.ResourceSuffix)"
    # Once the target's own sync has written anything, its data is newer
    # than the source's -- copying over it would roll it back.
    $existing = (AwsJson $Dst @("dynamodb", "scan", "--table-name", $table, "--select", "COUNT", "--max-items", "1")).Count
    if ($existing) { Write-Host "  $company -- target sync already running, skipped" -ForegroundColor Yellow; continue }

    # Watermarks BEFORE data: the copied CSVs are then at least as new as
    # the watermark, and the first sync's overlap is deduplicated by id
    # (mergeIntoS3Csv upserts), so nothing is missed.
    Write-Host "  $company" -ForegroundColor Cyan
    Copy-DynamoTable $table $table
    $local = Join-Path $Work "s3\$company"
    & aws s3 sync "s3://topstep-ai-offering/spp-data/$company/" $local --profile $Src.Profile --region $Src.Region --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw "download of spp-data/$company failed" }
    & aws s3 sync $local "s3://$DataBucket/spp-data/$company/" --profile $Dst.Profile --region $Dst.Region --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw "upload of spp-data/$company failed" }
  }

  $local = Join-Path $Work "s3\static"
  & aws s3 sync "s3://topstep-ai-offering/static/" $local --profile $Src.Profile --region $Src.Region --only-show-errors
  & aws s3 sync $local "s3://$DataBucket/static/" --profile $Dst.Profile --region $Dst.Region --only-show-errors
  if ($LASTEXITCODE -ne 0) { throw "copy of static/ failed" }

  # In the original account only "aiTerms" was ever created by hand -- the
  # other stacks name tables that don't exist there, so nothing to copy.
  $srcTables = @((AwsJson $Src @("dynamodb", "list-tables")).TableNames)
  foreach ($s in Get-SourceStacks "spp-mcp-server") {
    $t = $s.Params.TermsTableName
    if ($srcTables -notcontains $t) { Write-Host "  $t doesn't exist in source -- skipped" -ForegroundColor Yellow; continue }
    Copy-DynamoTable $t $t
  }
}

if (Step "AuthLinks") {
  Write-Host "=== Company-level SPP authorization ===" -ForegroundColor Magenta
  Write-Host "Open each link while logged in to that SPP account as the same user the original account's sync uses:"
  foreach ($s in Get-SourceStacks "spp-data-sync-infra") {
    $key = $s.Params.SyncIntegrationKey
    $out = Join-Path $Work "auth-out.json"
    AwsJson $Dst @("lambda", "invoke", "--function-name", "tslib-getAuthorizationUrl",
      "--cli-binary-format", "raw-in-base64-out", "--payload", (JsonFile @{ integrationKey = $key } "auth-in.json"), $out) | Out-Null
    $body = (Get-Content $out -Raw | ConvertFrom-Json).body | ConvertFrom-Json
    Write-Host ""
    Write-Host "[$($s.Params.SyncCompany)] $key" -ForegroundColor Cyan
    Write-Host $body.authorizationUrl
  }

  Write-Host ""
  Write-Host "=== Endpoints ===" -ForegroundColor Magenta
  Write-Host "SPP OAuth redirect URI (every SPP app): $(Get-StackOutput $Dst 'spp-oauth-lambdas' 'CallbackUrl')"
  foreach ($s in Get-SourceStacks "spp-mcp-server") {
    Write-Host "$($s.Name): MCP $(Get-StackOutput $Dst $s.Name 'McpEndpointUrl')  UserPool $(Get-StackOutput $Dst $s.Name 'UserPoolId')"
  }
}

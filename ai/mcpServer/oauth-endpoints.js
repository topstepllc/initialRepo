// OAuth discovery + Dynamic Client Registration (DCR) shim.
//
// Token issuance itself is handled entirely by Cognito's real Hosted UI
// (authorization_endpoint/token_endpoint below point straight at Cognito,
// and API Gateway's JWT authorizer validates the resulting tokens against
// Cognito directly -- this Lambda never sees a password or issues a token
// itself). The gap this fills is that Cognito has no Dynamic Client
// Registration support (RFC 7591), which MCP clients expect to be able to
// call before starting the OAuth flow. There is only ever one real Cognito
// App Client here, so /register never creates a new one -- it hands back
// that one pre-created client_id in the shape a DCR response is expected to
// have. What it DOES do for real: register the caller's own redirect_uri
// into that App Client's callback allow-list (see registerRedirectUris
// below), which is the actual security boundary Cognito enforces.
//
// Why this exists at all: Claude.ai uses one fixed callback URL
// (https://claude.ai/api/mcp/auth_callback) for every user and every MCP
// server it connects to -- it's the OAuth client, and routes each callback
// internally via `state`. ChatGPT's connectors don't work that way: each
// connector registration gets its own callback URL
// (https://chatgpt.com/connector/oauth/<id>), generated fresh per
// connector. Confirmed hitting this directly onboarding rbreaux-2fb4's
// ChatGPT connector: Cognito rejected the authorize request with
// redirect_mismatch because nothing had told it about that URL. Manually
// adding one URL per connector via the console doesn't scale to the
// hundreds of users/instances this is meant to support -- so /register now
// does the self-service version of exactly that manual step, automatically,
// the moment a new connector's first DCR call comes in.
const COGNITO_ISSUER = process.env.COGNITO_ISSUER;
const COGNITO_AUTHORIZATION_ENDPOINT =
  process.env.COGNITO_AUTHORIZATION_ENDPOINT;
const COGNITO_TOKEN_ENDPOINT = process.env.COGNITO_TOKEN_ENDPOINT;
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const MCP_SERVER_BASE_URL = process.env.MCP_SERVER_BASE_URL;

const {
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
  UpdateUserPoolClientCommand,
} = require("@aws-sdk/client-cognito-identity-provider");

const cognito = new CognitoIdentityProviderClient({});

// /register is unauthenticated by design -- DCR has to be callable before
// a client has any token at all -- so this is the actual guardrail: without
// it, anyone could call /register with an attacker-controlled redirect_uri
// and get it added to Cognito's allow-list, then phish a real user through
// the genuine Cognito login and have the resulting code delivered to that
// attacker's domain instead. Only known, trusted connector platforms go
// in here -- Claude's own callback is unaffected either way (it's already
// in the allow-list from the ClaudeRedirectUri stack parameter), this just
// lets it through the same path too rather than special-casing it.
const TRUSTED_REDIRECT_ORIGINS = ["https://chatgpt.com", "https://claude.ai"];

function isTrustedRedirectUri(uri) {
  try {
    return TRUSTED_REDIRECT_ORIGINS.includes(new URL(uri).origin);
  } catch {
    return false; // not a parseable absolute URL -- never trust it
  }
}

// Adds any new, trusted redirect_uris to the Cognito App Client's allowed
// callback list -- idempotent (a no-op update if every trusted URI is
// already present). Reads the client's live config first and carries its
// other settings forward unchanged: UpdateUserPoolClient replaces the
// whole set of mutable properties it's given, not just CallbackURLs, so
// omitting one (e.g. AllowedOAuthFlows) would silently reset it rather
// than leave it alone.
async function registerRedirectUris(redirectUris) {
  const trusted = redirectUris.filter(isTrustedRedirectUri);
  if (trusted.length === 0) return [];

  const { UserPoolClient: client } = await cognito.send(
    new DescribeUserPoolClientCommand({
      UserPoolId: COGNITO_USER_POOL_ID,
      ClientId: COGNITO_CLIENT_ID,
    }),
  );

  const existing = client.CallbackURLs ?? [];
  const merged = [...new Set([...existing, ...trusted])];
  if (merged.length === existing.length) return trusted; // already all present

  await cognito.send(
    new UpdateUserPoolClientCommand({
      UserPoolId: COGNITO_USER_POOL_ID,
      ClientId: COGNITO_CLIENT_ID,
      ClientName: client.ClientName,
      RefreshTokenValidity: client.RefreshTokenValidity,
      ExplicitAuthFlows: client.ExplicitAuthFlows,
      SupportedIdentityProviders: client.SupportedIdentityProviders,
      AllowedOAuthFlows: client.AllowedOAuthFlows,
      AllowedOAuthScopes: client.AllowedOAuthScopes,
      AllowedOAuthFlowsUserPoolClient: client.AllowedOAuthFlowsUserPoolClient,
      CallbackURLs: merged,
    }),
  );
  console.log(
    `DCR: added redirect_uri(s) to Cognito callback allow-list: ${trusted.join(", ")}`,
  );
  return trusted;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// Discovered first, either directly or via the WWW-Authenticate header on an
// unauthenticated 401 from /mcp. Points clients at the authorization
// server(s) that protect this resource.
function protectedResourceMetadata() {
  return json(200, {
    resource: `${MCP_SERVER_BASE_URL}/mcp`,
    authorization_servers: [MCP_SERVER_BASE_URL],
  });
}

// This is OUR metadata document, not Cognito's -- it re-exports Cognito's
// real authorization/token endpoints (so tokens really are issued by
// Cognito, with Cognito's real "iss" claim) while adding the one field
// Cognito's own metadata lacks: registration_endpoint.
function authorizationServerMetadata() {
  return json(200, {
    issuer: COGNITO_ISSUER,
    authorization_endpoint: COGNITO_AUTHORIZATION_ENDPOINT,
    token_endpoint: COGNITO_TOKEN_ENDPOINT,
    registration_endpoint: `${MCP_SERVER_BASE_URL}/register`,
    jwks_uri: `${COGNITO_ISSUER}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["openid", "email"],
  });
}

async function registerClient(body) {
  let parsed = {};
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    // Tolerate a malformed body -- still return the one real client_id below.
  }

  console.log("DCR request:", JSON.stringify(parsed));

  const requested = Array.isArray(parsed.redirect_uris)
    ? parsed.redirect_uris
    : [];
  let accepted = [];
  try {
    accepted = await registerRedirectUris(requested);
  } catch (error) {
    // Don't fail the whole DCR call over this -- worst case, the caller's
    // later authorize request 400s with redirect_mismatch, same failure
    // mode as before this existed, rather than DCR itself breaking.
    console.log(`DCR: could not register redirect_uri(s): ${error.message}`);
  }

  const now = Math.floor(Date.now() / 1000);

  return json(201, {
    client_id: COGNITO_CLIENT_ID,
    client_id_issued_at: now,
    redirect_uris: accepted,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
}

module.exports = {
  protectedResourceMetadata,
  authorizationServerMetadata,
  registerClient,
};

// Per-user SPP OAuth connections, built entirely on top of the existing
// tslib OAuth machinery (getAuthorizationUrl / exchangeCodeForTokens /
// oauthUtils.mjs, normally attached to other Lambdas via the "sharedUtils"
// layer -- copied into this image directly instead, since container-image
// Lambdas can't attach layers at all; see the Dockerfile) -- none of that
// code is modified or duplicated. Those functions are already fully
// generic, keyed by an arbitrary "integrationKey" string resolved from the
// OAuth "state" param, so a per-user connection is just a matter of using a
// per-user integrationKey instead of the existing per-company one.
//
// The one new piece: an oauth_config row has to exist under that per-user
// key before getAuthorizationUrl can build a URL for it. Rather than
// registering a new application in SPP, this clones the details of the
// already-registered "top-step-prod" app (same client_id/secret, same
// redirect_uri already pointing at tslib-exchangeCodeForTokens, and its
// scope already includes "rest") into a new row keyed per person. SPP's
// OAuth server only cares that the redirect_uri matches what's registered
// for that client_id -- it doesn't know or care that we're reusing the same
// client_id across many logical "integrations" on our side.

const { DynamoDBClient, PutItemCommand, GetItemCommand } = require("@aws-sdk/client-dynamodb");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");

const dynamo = new DynamoDBClient({});
const OAUTH_CONFIG_TABLE = process.env.OAUTH_CONFIG_TABLE || "oauth_config";

// The already-registered SPP application this reuses -- see module comment.
const BASE_SPP_CONFIG_KEY = process.env.SPP_BASE_OAUTH_CONFIG_KEY || "spp-top step-prod";

// Keyed on BASE_SPP_CONFIG_KEY (per-deployment, via SPP_BASE_OAUTH_CONFIG_KEY),
// not a fixed string -- this used to hardcode "spp-top-step-user-" regardless
// of which deployment ran it, so every deployment (TopStep, BGB, any new
// customer) computed the SAME row for the same email. Confirmed happening in
// production: a TopStep staff email that had already connected to TopStep's
// own SPP instance got silently handed TopStep's authorization link when
// connecting through an unrelated demo account's connector instead, because
// ensurePerUserOAuthConfig found that pre-existing row first (it's
// deliberately idempotent) and reused it instead of creating a new one for
// this deployment.
function perUserIntegrationKey(email) {
  return `${BASE_SPP_CONFIG_KEY}-user-${email.toLowerCase().trim()}`;
}

let cachedBaseConfig = null;

// The base app registration's config row (client_id/secret/urls/scope) --
// cached per warm Lambda container since it never changes at runtime.
async function getBaseSppConfig() {
  if (cachedBaseConfig) return cachedBaseConfig;

  const result = await dynamo.send(
    new GetItemCommand({
      TableName: OAUTH_CONFIG_TABLE,
      Key: marshall({ pk: BASE_SPP_CONFIG_KEY }),
    }),
  );
  if (!result.Item) {
    throw new Error(`Base SPP oauth_config "${BASE_SPP_CONFIG_KEY}" not found`);
  }
  cachedBaseConfig = unmarshall(result.Item);
  return cachedBaseConfig;
}

// Ensures an oauth_config row exists for this specific person, cloned from
// the base app registration. Idempotent by design -- a repeat call (e.g.
// someone clicking "connect" again) must not clobber an in-flight "state"
// value or reset an already-connected person's row, so this is a no-op once
// the row exists at all.
async function ensurePerUserOAuthConfig(email) {
  const integrationKey = perUserIntegrationKey(email);

  const existing = await dynamo.send(
    new GetItemCommand({
      TableName: OAUTH_CONFIG_TABLE,
      Key: marshall({ pk: integrationKey }),
    }),
  );
  if (existing.Item) {
    return integrationKey;
  }

  const base = await getBaseSppConfig();

  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: OAUTH_CONFIG_TABLE,
        Item: marshall({
          pk: integrationKey,
          client_id: base.client_id,
          client_secret: base.client_secret,
          redirect_uri: base.redirect_uri,
          scope: base.scope,
          authorization_url: base.authorization_url,
          token_url: base.token_url,
          // Per-row, not a global env var on tslib-exchangeCodeForTokens --
          // that Lambda is shared with other, unrelated company-level SPP
          // integrations, and a global redirect would send THEIR completed
          // logins here too. exchangeCodeForTokens.mjs checks this field
          // before falling back to its global default.
          //
          // A neutral static confirmation page, not claude.ai -- redirecting
          // to a fresh claude.ai tab never actually made sense: the person
          // completing this SPP login already has the real conversation open
          // in whatever tab/app they started this from (Claude, and in the
          // future potentially ChatGPT or any other MCP client), and a bare
          // "https://claude.ai/" redirect just dumped them on a new,
          // unrelated Claude session instead of back where they came from.
          // Per-account via SPP_CONNECTED_URL (that page lives in each
          // account's own data bucket); default is the original account's.
          success_redirect_uri:
            process.env.SPP_CONNECTED_URL ||
            "https://topstep-ai-offering.s3.us-east-2.amazonaws.com/static/spp-connected.html",
        }),
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  } catch (error) {
    // Lost a race with a concurrent request for the same person -- fine,
    // the row exists either way.
    if (error.name !== "ConditionalCheckFailedException") throw error;
  }

  return integrationKey;
}

// Returns a URL the person visits to connect their SPP account, via the
// existing tslib-getAuthorizationUrl Lambda (called unmodified -- it's
// already generic per integrationKey).
async function getSppConnectionUrl(email) {
  const integrationKey = await ensurePerUserOAuthConfig(email);
  const { callSharedUtil } = await import("./sharedUtils.mjs");
  const bodyText = await callSharedUtil("tslib-getAuthorizationUrl", { integrationKey });
  const { authorizationUrl } = JSON.parse(bodyText);
  return authorizationUrl;
}

// Returns a valid (auto-refreshed) access token for this person's SPP
// connection, or null if they haven't connected yet.
async function getSppAccessTokenForUser(email) {
  const integrationKey = perUserIntegrationKey(email);
  const { getValidAccessToken } = await import("./oauthUtils.mjs");
  try {
    return await getValidAccessToken(integrationKey);
  } catch (error) {
    if (/No tokens stored/.test(error.message)) {
      return null;
    }
    throw error;
  }
}

module.exports = {
  perUserIntegrationKey,
  ensurePerUserOAuthConfig,
  getSppConnectionUrl,
  getSppAccessTokenForUser,
  getBaseSppConfig,
};

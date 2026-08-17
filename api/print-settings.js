const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const REQUIRED_SCOPE = 'read_products';

// Cached across warm invocations of the same serverless instance so we don't
// request a new access token on every request.
let tokenCache = { accessToken: null, expiresAt: 0 };

function getEnv() {
  const { SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET } = process.env;
  const missing = ['SHOPIFY_SHOP', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'].filter(
    (key) => !process.env[key]
  );
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }
  return { SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET };
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function fetchNewAccessToken() {
  const { SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET } = getEnv();

  const response = await fetch(`https://${SHOPIFY_SHOP}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
    }),
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
        `Shopify token endpoint returned a non-JSON response ` +
        `(status ${response.status}): ${text.slice(0, 500)}`
    );
  }

  if (!response.ok || !data.access_token) {
    throw new Error(
      `Failed to obtain Shopify access token (status ${response.status}): ${data.error_description || text}`
    );
  }

  if (typeof data.scope === 'string' && data.scope.trim().length > 0) {
    const grantedScopes = data.scope.split(',').map((scope) => scope.trim());
    if (!grantedScopes.includes(REQUIRED_SCOPE)) {
      throw new Error(`Shopify access token is missing required ${REQUIRED_SCOPE} scope`);
    }
  }

  const now = Date.now();
  const expiresInMs = Number(data.expires_in) > 0 ? Number(data.expires_in) * 1000 : 0;

  tokenCache = {
    accessToken: data.access_token,
    // Refresh a little early to avoid edge-of-expiry failures. When Shopify
    // doesn't return a usable expires_in, treat the token as already expired
    // so it's never cached indefinitely (it's still returned for this call).
    expiresAt: expiresInMs > 0 ? now + expiresInMs - 60_000 : now,
  };

  return tokenCache.accessToken;
}

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.accessToken && tokenCache.expiresAt > now) {
    return tokenCache.accessToken;
  }
  return fetchNewAccessToken();
}

function clearAccessToken() {
  tokenCache = { accessToken: null, expiresAt: 0 };
}

const PRODUCT_QUERY = `
  query GetPrintSettings($id: ID!) {
    product(id: $id) {
      id
      title
      printWidth: metafield(namespace: "custom", key: "print_width") { value }
      printHeight: metafield(namespace: "custom", key: "print_height") { value }
      printDpi: metafield(namespace: "custom", key: "print_dpi") { value }
      printBleed: metafield(namespace: "custom", key: "print_bleed") { value }
    }
  }
`;

async function requestProduct(productId, accessToken) {
  const { SHOPIFY_SHOP } = getEnv();

  const response = await fetch(`https://${SHOPIFY_SHOP}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({
      query: PRODUCT_QUERY,
      variables: { id: `gid://shopify/Product/${productId}` },
    }),
  });

  return response;
}

async function fetchProduct(productId, allowRetry = true) {
  const accessToken = await getAccessToken();
  const response = await requestProduct(productId, accessToken);

  if (response.status === 401 && allowRetry) {
    clearAccessToken();
    return fetchProduct(productId, false);
  }

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Shopify GraphQL endpoint returned a non-JSON response (status ${response.status})`);
  }

  if (!response.ok) {
    throw new Error(`Shopify GraphQL request failed (status ${response.status}): ${text}`);
  }

  if (data.errors && data.errors.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(data.errors)}`);
  }

  return data.data && data.data.product;
}

function toNumber(metafield) {
  if (!metafield || metafield.value === undefined || metafield.value === null) return null;
  const num = Number(metafield.value);
  return Number.isNaN(num) ? null : num;
}

module.exports = async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { productId } = req.query;

  if (!productId || Array.isArray(productId) || !/^\d+$/.test(productId)) {
    return res.status(400).json({ error: 'A numeric "productId" query parameter is required' });
  }

  try {
    const product = await fetchProduct(productId);

    if (!product) {
      return res.status(404).json({ error: `Product ${productId} not found` });
    }

    return res.status(200).json({
      productId,
      title: product.title,
      width: toNumber(product.printWidth),
      height: toNumber(product.printHeight),
      dpi: toNumber(product.printDpi),
      bleed: toNumber(product.printBleed),
    });
  } catch (error) {
    console.error(
        'PRINT_SETTINGS_ERROR:',
        error instanceof Error ? error.message : String(error)
    );

    return res.status(502).json({
      error: 'Failed to fetch print settings from Shopify',
    });
  }
};

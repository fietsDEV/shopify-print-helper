const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';

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


async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.accessToken && tokenCache.expiresAt > now) {
    return tokenCache.accessToken;
  }

  const { SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET } = getEnv();

  const response = await fetch(`https://${SHOPIFY_SHOP}/admin/oauth/access_token`, {
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
    throw new Error(`Shopify token endpoint returned a non-JSON response (status ${response.status})`);
  }

  if (!response.ok || !data.access_token) {
    throw new Error(
      `Failed to obtain Shopify access token (status ${response.status}): ${data.error_description || text}`
    );
  }

  tokenCache = {
    accessToken: data.access_token,
    // Refresh a little early to avoid edge-of-expiry failures.
    expiresAt: now + (Number(data.expires_in) || 0) * 1000 - 60_000,
  };

  return tokenCache.accessToken;
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

async function fetchProduct(productId) {
  const { SHOPIFY_SHOP } = getEnv();
  const accessToken = await getAccessToken();

  const response = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
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
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
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
    console.error('print-settings error:', error);
    return res.status(502).json({ error: 'Failed to fetch print settings from Shopify' });
  }
};

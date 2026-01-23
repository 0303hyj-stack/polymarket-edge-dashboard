// Vercel Serverless Function - Proxy for single market status
// Used by paper trading to check if markets are resolved

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ error: 'Market ID is required' });
  }

  try {
    const response = await fetch(`https://gamma-api.polymarket.com/markets/${id}`);

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Market not found' });
    }

    const data = await response.json();

    // Short cache
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');

    return res.status(200).json(data);
  } catch (error) {
    console.error('Market API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}

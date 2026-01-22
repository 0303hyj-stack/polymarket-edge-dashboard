// Vercel Serverless Function - Proxy for Polymarket API
// This avoids CORS issues when fetching from the browser

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

  try {
    const GAMMA_API = 'https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=500';

    // Fetch multiple pages in parallel (up to 5000 markets)
    const offsets = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500];
    const promises = offsets.map(offset =>
      fetch(`${GAMMA_API}&offset=${offset}`).then(r => r.json()).catch(() => [])
    );

    const results = await Promise.all(promises);
    const allMarkets = results.flat();

    // Remove duplicates by id
    const uniqueMarkets = [...new Map(allMarkets.map(m => [m.id, m])).values()];

    // Cache for 30 seconds
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');

    return res.status(200).json(uniqueMarkets);
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}

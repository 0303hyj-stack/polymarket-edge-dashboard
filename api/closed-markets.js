// Vercel Serverless Function - Proxy for closed markets
export default async function handler(req, res) {
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
    const GAMMA_API = 'https://gamma-api.polymarket.com/markets?closed=true&limit=500&end_date_min=2020-01-01';

    // Fetch multiple pages in parallel (up to 10000 markets)
    const offsets = [];
    for (let i = 0; i < 20; i++) offsets.push(i * 500);
    const promises = offsets.map(offset =>
      fetch(`${GAMMA_API}&offset=${offset}`).then(r => r.json()).catch(() => [])
    );

    const results = await Promise.all(promises);
    const allMarkets = results.flat();

    // Remove duplicates by id
    const uniqueMarkets = [...new Map(allMarkets.map(m => [m.id, m])).values()];

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json(uniqueMarkets);
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}

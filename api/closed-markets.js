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
    // Fetch recent data first (2024+), then older data
    // API returns oldest first, so we need multiple date ranges
    const today = new Date().toISOString().split('T')[0];

    // Fetch in date range chunks to get more recent data
    const dateRanges = [
      { min: '2026-01-01', max: today },      // 2026 (current)
      { min: '2025-07-01', max: '2025-12-31' }, // Late 2025
      { min: '2025-01-01', max: '2025-06-30' }, // Early 2025
      { min: '2024-07-01', max: '2024-12-31' }, // Late 2024
      { min: '2024-01-01', max: '2024-06-30' }, // Early 2024
      { min: '2023-01-01', max: '2023-12-31' }, // 2023
      { min: '2022-01-01', max: '2022-12-31' }, // 2022
    ];

    const allPromises = [];
    for (const range of dateRanges) {
      const baseUrl = `https://gamma-api.polymarket.com/markets?closed=true&limit=500&end_date_min=${range.min}&end_date_max=${range.max}`;
      // Fetch 3 pages per range (1500 markets per range)
      for (let offset = 0; offset < 1500; offset += 500) {
        allPromises.push(
          fetch(`${baseUrl}&offset=${offset}`).then(r => r.json()).catch(() => [])
        );
      }
    }

    const results = await Promise.all(allPromises);
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

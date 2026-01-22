// Vercel Serverless Function - Proxy for CLOB price history
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

  const { tokenId } = req.query;

  if (!tokenId) {
    return res.status(400).json({ error: 'tokenId is required' });
  }

  try {
    const CLOB_API = `https://clob.polymarket.com/prices-history?market=${tokenId}&interval=max&fidelity=1440`;
    const response = await fetch(CLOB_API);
    const data = await response.json();

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
    return res.status(200).json(data);
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}

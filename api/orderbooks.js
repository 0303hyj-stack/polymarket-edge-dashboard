// Vercel Serverless Function - Batch fetch CLOB orderbooks for real-time prices

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST required' });
  }

  try {
    const { tokenIds } = req.body;

    if (!Array.isArray(tokenIds)) {
      return res.status(400).json({ error: 'tokenIds array required' });
    }

    // Limit to prevent abuse
    const limitedTokenIds = tokenIds.slice(0, 100);

    // Fetch orderbooks in parallel (batch of 20)
    const results = {};
    const BATCH_SIZE = 20;

    for (let i = 0; i < limitedTokenIds.length; i += BATCH_SIZE) {
      const batch = limitedTokenIds.slice(i, i + BATCH_SIZE);
      const promises = batch.map(async (tokenId) => {
        try {
          const resp = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
          const data = await resp.json();
          return { tokenId, data };
        } catch (e) {
          return { tokenId, data: null };
        }
      });

      const batchResults = await Promise.all(promises);
      batchResults.forEach(r => {
        results[r.tokenId] = r.data;
      });
    }

    // Short cache for real-time data
    res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=10');

    return res.status(200).json(results);
  } catch (error) {
    console.error('Orderbooks API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3001;

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // API proxy endpoint - fetch all active markets with pagination
    if (url.pathname === '/api/markets') {
        try {
            const GAMMA_API = 'https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=500';

            // Fetch multiple pages in parallel (up to 15000 markets)
            const offsets = [];
            for (let i = 0; i < 30; i++) offsets.push(i * 500);
            const promises = offsets.map(offset =>
                fetch(`${GAMMA_API}&offset=${offset}`).then(r => r.json()).catch(() => [])
            );

            const results = await Promise.all(promises);
            const allMarkets = results.flat();

            // Remove duplicates by id
            const uniqueMarkets = [...new Map(allMarkets.map(m => [m.id, m])).values()];

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(uniqueMarkets));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    // API proxy for closed markets (backtest)
    if (url.pathname === '/api/closed-markets') {
        try {
            // Fetch recent data first (2024+), then older data
            const today = new Date().toISOString().split('T')[0];

            const dateRanges = [
                { min: '2024-06-01', max: today },
                { min: '2024-01-01', max: '2024-05-31' },
                { min: '2023-01-01', max: '2023-12-31' },
                { min: '2022-01-01', max: '2022-12-31' },
            ];

            const allPromises = [];
            for (const range of dateRanges) {
                const baseUrl = `https://gamma-api.polymarket.com/markets?closed=true&limit=500&end_date_min=${range.min}&end_date_max=${range.max}`;
                for (let offset = 0; offset < 1500; offset += 500) {
                    allPromises.push(
                        fetch(`${baseUrl}&offset=${offset}`).then(r => r.json()).catch(() => [])
                    );
                }
            }

            const results = await Promise.all(allPromises);
            const allMarkets = results.flat();

            const uniqueMarkets = [...new Map(allMarkets.map(m => [m.id, m])).values()];

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(uniqueMarkets));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    // API proxy for price history (backtest)
    if (url.pathname === '/api/price-history') {
        const tokenId = url.searchParams.get('tokenId');
        if (!tokenId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'tokenId is required' }));
            return;
        }
        try {
            const CLOB_API = `https://clob.polymarket.com/prices-history?market=${tokenId}&interval=max&fidelity=1440`;
            const response = await fetch(CLOB_API);
            const data = await response.json();

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    // Serve static files
    let filePath = req.url === '/' ? '/index.html' : req.url;
    filePath = path.join(__dirname, 'public', filePath);

    const ext = path.extname(filePath);
    const contentTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json'
    };

    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
        res.end(content);
    });
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

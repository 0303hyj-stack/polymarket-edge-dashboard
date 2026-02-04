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

            // Fetch multiple pages in parallel (up to 30000 markets)
            const offsets = [];
            for (let i = 0; i < 60; i++) offsets.push(i * 500);
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

    // API proxy for CLOB orderbook (real-time prices)
    if (url.pathname === '/api/orderbook') {
        const tokenId = url.searchParams.get('tokenId');
        if (!tokenId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'tokenId is required' }));
            return;
        }
        try {
            const response = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
            const data = await response.json();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    // API proxy for batch orderbook (multiple tokens)
    if (url.pathname === '/api/orderbooks') {
        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'POST required' }));
            return;
        }

        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { tokenIds } = JSON.parse(body);
                if (!Array.isArray(tokenIds)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'tokenIds array required' }));
                    return;
                }

                // Fetch orderbooks in parallel (limit to 20 at a time)
                const results = {};
                const BATCH_SIZE = 20;

                for (let i = 0; i < tokenIds.length; i += BATCH_SIZE) {
                    const batch = tokenIds.slice(i, i + BATCH_SIZE);
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

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(results));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            }
        });
        return;
    }

    // API proxy for single market (paper trading)
    if (url.pathname === '/api/market') {
        const marketId = url.searchParams.get('id');
        if (!marketId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Market ID is required' }));
            return;
        }
        try {
            const response = await fetch(`https://gamma-api.polymarket.com/markets/${marketId}`);
            const data = await response.json();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    // API proxy for price history (backtest)
    if (url.pathname === '/api/price-history') {
        const tokenId = url.searchParams.get('tokenId');
        const fidelity = url.searchParams.get('fidelity') || '60'; // Default to hourly
        if (!tokenId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'tokenId is required' }));
            return;
        }
        try {
            const CLOB_API = `https://clob.polymarket.com/prices-history?market=${tokenId}&interval=max&fidelity=${fidelity}`;
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

    // PM2 Paper Trading Data API
    if (url.pathname === '/api/pm2-data') {
        const dataFile = path.join(__dirname, 'paper-trading-data.json');
        try {
            if (fs.existsSync(dataFile)) {
                const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(data));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No PM2 data file found' }));
            }
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    // PM2 Paper Trading Logs API
    if (url.pathname === '/api/pm2-logs') {
        const logFile = path.join(__dirname, 'paper-trading-server.log');
        const lines = parseInt(url.searchParams.get('lines')) || 50;
        try {
            if (fs.existsSync(logFile)) {
                const content = fs.readFileSync(logFile, 'utf8');
                const allLines = content.trim().split('\n');
                const recentLines = allLines.slice(-lines);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ logs: recentLines }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ logs: [] }));
            }
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

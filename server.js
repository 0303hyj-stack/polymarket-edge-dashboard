const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3001;

const server = http.createServer(async (req, res) => {
    // API proxy endpoint - fetch all markets with pagination
    if (req.url === '/api/markets') {
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

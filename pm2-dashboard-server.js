// PM2 Paper Trading Dashboard Server
// 브라우저에서 PM2 봇 상태를 확인할 수 있는 간단한 웹 서버

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3001;
const DATA_FILE = path.join(__dirname, 'paper-trading-data.json');
const LOG_FILE = path.join(__dirname, 'paper-trading-server.log');

// 데이터 읽기
function readData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Error reading data:', e);
    }
    return null;
}

// 최근 로그 읽기
function readLogs(lines = 50) {
    try {
        if (fs.existsSync(LOG_FILE)) {
            const content = fs.readFileSync(LOG_FILE, 'utf8');
            const allLines = content.trim().split('\n');
            return allLines.slice(-lines);
        }
    } catch (e) {
        console.error('Error reading logs:', e);
    }
    return [];
}

// HTML 페이지 생성
function generateHTML(data, logs) {
    const portfolio = data?.portfolio || {};
    const balance = portfolio.balance || 10000;
    const startingBalance = portfolio.startingBalance || 10000;
    const positions = portfolio.positions || [];
    const history = portfolio.history || [];
    const totalScans = data?.totalScans || 0;
    const errors = data?.errors || 0;

    const positionValue = positions.reduce((sum, p) => sum + (p.cost || 0), 0);
    const totalValue = balance + positionValue;
    const pnl = totalValue - startingBalance;
    const pnlClass = pnl >= 0 ? 'profit' : 'loss';
    const pnlSign = pnl >= 0 ? '+' : '';

    const wins = history.filter(h => h.result === 'WIN').length;
    const winRate = history.length > 0 ? ((wins / history.length) * 100).toFixed(1) : '-';

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PM2 Paper Trading Dashboard</title>
    <meta http-equiv="refresh" content="30">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; }
        h1 { font-size: 1.5rem; margin-bottom: 8px; }
        .subtitle { color: #666; margin-bottom: 24px; font-size: 0.9rem; }
        .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; margin-bottom: 24px; }
        .card { background: white; border-radius: 8px; padding: 16px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .card .value { font-size: 1.4rem; font-weight: 700; color: #111; }
        .card .label { font-size: 0.7rem; color: #666; text-transform: uppercase; margin-top: 4px; }
        .card.profit .value { color: #059669; }
        .card.loss .value { color: #dc2626; }
        .section { background: white; border-radius: 8px; padding: 20px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .section h2 { font-size: 1rem; margin-bottom: 16px; color: #333; }
        table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
        th, td { padding: 10px 8px; text-align: left; border-bottom: 1px solid #eee; }
        th { color: #666; font-weight: 600; text-transform: uppercase; font-size: 0.75rem; }
        .yes { color: #059669; font-weight: 600; }
        .no { color: #dc2626; font-weight: 600; }
        .win { color: #059669; }
        .loss { color: #dc2626; }
        .log-box { background: #111; border-radius: 8px; padding: 16px; max-height: 300px; overflow-y: auto; }
        .log-line { color: #888; font-family: 'SF Mono', Monaco, monospace; font-size: 0.75rem; margin-bottom: 4px; white-space: pre-wrap; word-break: break-all; }
        .log-line.buy { color: #34d399; }
        .log-line.info { color: #60a5fa; }
        .log-line.error { color: #f87171; }
        .status { display: inline-flex; align-items: center; gap: 8px; }
        .status-dot { width: 10px; height: 10px; border-radius: 50%; background: #059669; animation: pulse 1.5s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .refresh-note { color: #888; font-size: 0.8rem; margin-top: 8px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>PM2 Paper Trading Dashboard</h1>
        <p class="subtitle">
            <span class="status"><span class="status-dot"></span> Running</span>
            &nbsp;|&nbsp; Total Scans: ${totalScans} &nbsp;|&nbsp; Errors: ${errors}
        </p>

        <div class="cards">
            <div class="card">
                <div class="value">$${balance.toFixed(2)}</div>
                <div class="label">Balance</div>
            </div>
            <div class="card">
                <div class="value">$${positionValue.toFixed(2)}</div>
                <div class="label">Position Value</div>
            </div>
            <div class="card">
                <div class="value">$${totalValue.toFixed(2)}</div>
                <div class="label">Total Value</div>
            </div>
            <div class="card ${pnlClass}">
                <div class="value">${pnlSign}$${pnl.toFixed(2)}</div>
                <div class="label">P/L</div>
            </div>
            <div class="card">
                <div class="value">${winRate}${winRate !== '-' ? '%' : ''}</div>
                <div class="label">Win Rate</div>
            </div>
        </div>

        <div class="section">
            <h2>Open Positions (${positions.length})</h2>
            ${positions.length === 0 ? '<p style="color:#888;text-align:center;padding:20px;">No open positions</p>' : `
            <table>
                <thead>
                    <tr><th>Market</th><th>Side</th><th>Entry</th><th>Cost</th><th>Time Left</th></tr>
                </thead>
                <tbody>
                    ${positions.map(p => {
                        const endDate = new Date(p.endDate);
                        const timeLeft = endDate - new Date();
                        const hoursLeft = Math.max(0, timeLeft / (1000 * 60 * 60));
                        const timeText = hoursLeft < 24 ? hoursLeft.toFixed(1) + 'h' : (hoursLeft / 24).toFixed(1) + 'd';
                        return `<tr>
                            <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${p.question}">${p.question.slice(0, 50)}...</td>
                            <td class="${p.side.toLowerCase()}">${p.side}</td>
                            <td>${p.entryPrice.toFixed(1)}¢</td>
                            <td>$${p.cost}</td>
                            <td>${timeText}</td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>`}
        </div>

        <div class="section">
            <h2>Trade History (${history.length})</h2>
            ${history.length === 0 ? '<p style="color:#888;text-align:center;padding:20px;">No trade history</p>' : `
            <table>
                <thead>
                    <tr><th>Market</th><th>Side</th><th>Entry</th><th>Exit</th><th>P/L</th><th>Result</th></tr>
                </thead>
                <tbody>
                    ${history.slice(0, 20).map(h => `<tr>
                        <td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${h.question}">${h.question.slice(0, 40)}...</td>
                        <td class="${h.side.toLowerCase()}">${h.side}</td>
                        <td>${h.entryPrice.toFixed(1)}¢</td>
                        <td>${h.exitPrice}¢</td>
                        <td class="${h.profit >= 0 ? 'win' : 'loss'}">${h.profit >= 0 ? '+' : ''}$${h.profit.toFixed(2)}</td>
                        <td class="${h.result === 'WIN' ? 'win' : 'loss'}">${h.result}</td>
                    </tr>`).join('')}
                </tbody>
            </table>`}
        </div>

        <div class="section">
            <h2>Recent Logs</h2>
            <div class="log-box">
                ${logs.map(line => {
                    let cls = '';
                    if (line.includes('BUY') || line.includes('WIN')) cls = 'buy';
                    else if (line.includes('INFO')) cls = 'info';
                    else if (line.includes('ERROR')) cls = 'error';
                    return `<div class="log-line ${cls}">${line}</div>`;
                }).join('')}
            </div>
        </div>

        <p class="refresh-note">Auto-refresh every 30 seconds. Last updated: ${new Date().toLocaleString()}</p>
    </div>
</body>
</html>`;
}

// API 응답
function handleAPI(res) {
    const data = readData();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
}

// 서버 시작
const server = http.createServer((req, res) => {
    if (req.url === '/api/data') {
        return handleAPI(res);
    }

    const data = readData();
    const logs = readLogs(50);
    const html = generateHTML(data, logs);

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
});

server.listen(PORT, () => {
    console.log(`PM2 Dashboard running at http://localhost:${PORT}`);
});

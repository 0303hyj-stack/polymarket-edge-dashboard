// Polymarket Paper Trading Server
// 실시간 오더북 폴링 - bid=48, ask=49 조건

const fs = require('fs');
const path = require('path');

const CONFIG = {
    bidTrigger: 48,
    askTrigger: 49,
    startingBalance: 10000,
    positionSize: 100,
    maxPositions: 50,
    cooldownMinutes: 10000000,
    pollIntervalSec: 5,       // 전체 스캔 후 대기
    orderbookBatchSize: 200,  // 한번에 200개씩 orderbook 요청
    dataFile: path.join(__dirname, 'paper-trading-data.json'),
    logFile: path.join(__dirname, 'paper-trading-server.log')
};

let state = {
    portfolio: {
        startingBalance: CONFIG.startingBalance,
        balance: CONFIG.startingBalance,
        positions: [],
        history: [],
        marketCooldowns: {}
    },
    isRunning: false,
    lastScan: null,
    totalScans: 0,
    errors: 0,
    matches: 0
};

function log(message, type = 'INFO') {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${type}] ${message}`;
    console.log(logLine);
    try { fs.appendFileSync(CONFIG.logFile, logLine + '\n'); } catch (e) {}
}

function saveState() {
    try { fs.writeFileSync(CONFIG.dataFile, JSON.stringify(state, null, 2)); } catch (e) {}
}

function loadState() {
    try {
        if (fs.existsSync(CONFIG.dataFile)) {
            const data = JSON.parse(fs.readFileSync(CONFIG.dataFile, 'utf8'));
            state = { ...state, ...data };
            log(`Loaded: Balance=$${state.portfolio.balance.toFixed(2)}, Positions=${state.portfolio.positions.length}`);
        }
    } catch (e) {}
}

async function fetchMarkets() {
    const API = 'https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=500';
    try {
        const all = [];
        for (let i = 0; i < 60; i += 5) {
            const promises = [];
            for (let j = 0; j < 5; j++) {
                promises.push(fetch(`${API}&offset=${(i + j) * 500}`).then(r => r.json()).catch(() => []));
            }
            const results = await Promise.all(promises);
            all.push(...results.flat());
            await new Promise(r => setTimeout(r, 100));
        }
        return [...new Map(all.map(m => [m.id, m])).values()];
    } catch (e) {
        return [];
    }
}

async function fetchOrderbookBatch(tokenIds) {
    const results = {};
    const promises = tokenIds.map(async (tokenId) => {
        try {
            const resp = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
            const data = await resp.json();
            return { tokenId, data };
        } catch (e) {
            return { tokenId, data: null };
        }
    });
    const batch = await Promise.all(promises);
    batch.forEach(r => { results[r.tokenId] = r.data; });
    return results;
}

async function fetchMarketStatus(marketId) {
    try {
        const response = await fetch(`https://gamma-api.polymarket.com/markets/${marketId}`);
        return await response.json();
    } catch (e) {
        return null;
    }
}

async function checkPositions() {
    for (const position of [...state.portfolio.positions]) {
        try {
            const market = await fetchMarketStatus(position.marketId);
            if (!market) continue;
            const prices = JSON.parse(market.outcomePrices || '[]');
            const isClosed = market.closed || prices[0] === '1' || prices[0] === '0';
            if (isClosed) {
                const yesWon = parseFloat(prices[0]) === 1;
                const won = (position.side === 'YES' && yesWon) || (position.side === 'NO' && !yesWon);
                const exitPrice = won ? 100 : 0;
                const proceeds = position.shares * (exitPrice / 100);
                const profit = proceeds - position.cost;

                state.portfolio.balance += proceeds;
                state.portfolio.history.unshift({
                    ...position, exitPrice, exitTime: new Date().toISOString(),
                    profit, profitPercent: (profit / position.cost) * 100, result: won ? 'WIN' : 'LOSS'
                });
                state.portfolio.positions = state.portfolio.positions.filter(p => p.id !== position.id);
                log(`${won ? '✅' : '❌'} CLOSED: ${position.question.slice(0, 40)}... | P/L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`, won ? 'WIN' : 'LOSS');
                saveState();
            }
        } catch (e) {}
    }
}

function executeBuy(market, tokenId, tokenIdNo, side, price) {
    if (state.portfolio.positions.length >= CONFIG.maxPositions) return false;
    if (state.portfolio.balance < CONFIG.positionSize) return false;
    if (state.portfolio.positions.find(p => p.marketId === market.id)) return false;
    if (state.portfolio.marketCooldowns[market.id]) return false;

    const shares = CONFIG.positionSize / (price / 100);
    state.portfolio.balance -= CONFIG.positionSize;

    let url = market.events?.[0]?.slug
        ? `https://polymarket.com/event/${market.events[0].slug}`
        : `https://polymarket.com/market/${market.conditionId}`;

    state.portfolio.positions.push({
        id: Date.now().toString(), marketId: market.id,
        tokenId: side === 'YES' ? tokenId : tokenIdNo,
        question: market.question, side, entryPrice: price,
        shares, cost: CONFIG.positionSize,
        entryTime: new Date().toISOString(), endDate: market.endDate, url
    });
    state.portfolio.marketCooldowns[market.id] = new Date().toISOString();
    saveState();
    log(`🟢 BUY ${side}: ${market.question.slice(0, 50)}... @ ${price.toFixed(1)}¢`, 'BUY');
    return true;
}

async function scan(markets) {
    state.totalScans++;
    state.lastScan = new Date().toISOString();

    // 바이너리 마켓 필터
    const candidates = markets.filter(m => {
        try {
            const outcomes = JSON.parse(m.outcomes || '[]');
            const tokens = JSON.parse(m.clobTokenIds || '[]');
            if (outcomes.length !== 2 || m.negRisk || !tokens[0] || !tokens[1]) return false;
            if (state.portfolio.marketCooldowns[m.id]) return false;
            if (state.portfolio.positions.find(p => p.marketId === m.id)) return false;
            return true;
        } catch { return false; }
    });

    log(`Scanning ${candidates.length} binary markets...`);

    // 모든 토큰 ID 수집
    const tokenIds = [];
    const tokenToMarket = new Map();

    for (const market of candidates) {
        const tokens = JSON.parse(market.clobTokenIds);
        tokenIds.push(tokens[0], tokens[1]);
        tokenToMarket.set(tokens[0], { market, side: 'YES', tokenId: tokens[0], tokenIdNo: tokens[1] });
        tokenToMarket.set(tokens[1], { market, side: 'NO', tokenId: tokens[0], tokenIdNo: tokens[1] });
    }

    // 배치로 나눠서 병렬 orderbook 요청
    const allOrderbooks = {};
    for (let i = 0; i < tokenIds.length; i += CONFIG.orderbookBatchSize) {
        const batch = tokenIds.slice(i, i + CONFIG.orderbookBatchSize);
        const results = await fetchOrderbookBatch(batch);
        Object.assign(allOrderbooks, results);

        // 진행 상황 (1000개마다)
        if (i > 0 && i % 1000 === 0) {
            log(`Progress: ${i}/${tokenIds.length} orderbooks fetched...`);
        }
    }

    let buys = 0;
    for (const [tokenId, info] of tokenToMarket) {
        const ob = allOrderbooks[tokenId];
        if (!ob || !ob.bids?.length || !ob.asks?.length) continue;

        const bid = parseFloat(ob.bids[0].price) * 100;
        const ask = parseFloat(ob.asks[0].price) * 100;

        if (Math.round(bid) === CONFIG.bidTrigger && Math.round(ask) === CONFIG.askTrigger) {
            state.matches++;
            log(`📊 MATCH: ${info.side} bid=${bid.toFixed(2)}¢ ask=${ask.toFixed(2)}¢ - ${info.market.question.slice(0, 40)}...`);
            if (executeBuy(info.market, info.tokenId, info.tokenIdNo, info.side, ask)) {
                buys++;
            }
        }
    }

    return { checked: candidates.length, buys };
}

async function start() {
    console.log('\n' + '='.repeat(60));
    console.log('🤖 POLYMARKET PAPER TRADING BOT');
    console.log('='.repeat(60));
    console.log(`Condition: bid=${CONFIG.bidTrigger}¢, ask=${CONFIG.askTrigger}¢`);
    console.log(`Balance: $${CONFIG.startingBalance} | Position: $${CONFIG.positionSize}`);
    console.log(`Batch: ${CONFIG.batchSize} markets | Poll: ${CONFIG.pollIntervalSec}s`);
    console.log('='.repeat(60) + '\n');

    loadState();
    state.isRunning = true;
    saveState();

    log('Fetching markets...');
    let markets = await fetchMarkets();
    log(`Loaded ${markets.length} markets`);

    // 폴링 루프 (스캔 완료 후 다음 스캔)
    async function runScan() {
        if (!state.isRunning) return;
        const start = Date.now();
        const r = await scan(markets);
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        log(`Scan #${state.totalScans}: ${r.checked} markets, ${r.buys} buys, ${state.matches} matches (${elapsed}s)`);
        setTimeout(runScan, CONFIG.pollIntervalSec * 1000);
    }
    runScan();

    // 5분마다 마켓 갱신
    setInterval(async () => {
        if (!state.isRunning) return;
        markets = await fetchMarkets();
        log(`Refreshed: ${markets.length} markets`);
    }, 5 * 60 * 1000);

    // 1분마다 포지션 체크
    setInterval(() => {
        if (state.isRunning) checkPositions();
    }, 60 * 1000);

    process.on('SIGINT', () => { state.isRunning = false; saveState(); process.exit(0); });
    process.on('SIGTERM', () => { state.isRunning = false; saveState(); process.exit(0); });
}

start().catch(e => { log(`Fatal: ${e.message}`, 'ERROR'); process.exit(1); });

// Polymarket Paper Trading Server
// 서버에서 24/7 자동으로 실행되는 Paper Trading Bot

const fs = require('fs');
const path = require('path');

// ============ 설정 ============
const CONFIG = {
    // 매수 조건
    buyTrigger: 49,            // Ask = 49¢ 일 때 매수 (정확히 49¢)
    buyTriggerExact: true,     // true = 정확히 49¢, false = ≤49¢
    nearExpiryPercent: 1,      // 만료까지 1% 미만 남았을 때

    // 포트폴리오 설정
    startingBalance: 10000,    // 시작 자금 $10,000 USDT
    positionSize: 100,         // 포지션당 $100 USDT
    maxPositions: 50,          // 최대 동시 포지션

    // 안전 장치
    maxSpread: 2,              // 최대 스프레드 2¢
    cooldownMinutes: 10000000, // 마켓당 쿨다운 (사실상 무제한 - 같은 마켓 재매수 안함)

    // 모니터링 간격
    pollIntervalSec: 30,       // 30초마다 체크 (API rate limit 고려)

    // 파일 경로
    dataFile: path.join(__dirname, 'paper-trading-data.json'),
    logFile: path.join(__dirname, 'paper-trading-server.log')
};

// ============ 상태 관리 ============
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
    errors: 0
};

// ============ 로깅 ============
function log(message, type = 'INFO') {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${type}] ${message}`;
    console.log(logLine);

    try {
        fs.appendFileSync(CONFIG.logFile, logLine + '\n');
    } catch (e) {
        // 로그 파일 쓰기 실패 무시
    }
}

// ============ 데이터 저장/로드 ============
function saveState() {
    try {
        fs.writeFileSync(CONFIG.dataFile, JSON.stringify(state, null, 2));
    } catch (e) {
        log(`Failed to save state: ${e.message}`, 'ERROR');
    }
}

function loadState() {
    try {
        if (fs.existsSync(CONFIG.dataFile)) {
            const data = JSON.parse(fs.readFileSync(CONFIG.dataFile, 'utf8'));
            state = { ...state, ...data };
            log(`Loaded state: Balance=$${state.portfolio.balance.toFixed(2)}, Positions=${state.portfolio.positions.length}, History=${state.portfolio.history.length}`);
        }
    } catch (e) {
        log(`Failed to load state: ${e.message}`, 'ERROR');
    }
}

// ============ API 호출 ============
async function fetchMarkets() {
    const GAMMA_API = 'https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=500';

    try {
        // 여러 페이지 가져오기 (최대 15000개)
        const offsets = [0, 500, 1000, 1500, 2000, 2500, 3000];
        const promises = offsets.map(offset =>
            fetch(`${GAMMA_API}&offset=${offset}`)
                .then(r => r.json())
                .catch(() => [])
        );

        const results = await Promise.all(promises);
        const allMarkets = results.flat();

        // 중복 제거
        const uniqueMarkets = [...new Map(allMarkets.map(m => [m.id, m])).values()];
        return uniqueMarkets;
    } catch (e) {
        log(`Failed to fetch markets: ${e.message}`, 'ERROR');
        return [];
    }
}

async function fetchOrderbook(tokenId) {
    try {
        const response = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
        return await response.json();
    } catch (e) {
        return null;
    }
}

async function fetchOrderbooks(tokenIds) {
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

        // Rate limiting
        if (i + BATCH_SIZE < tokenIds.length) {
            await new Promise(r => setTimeout(r, 100));
        }
    }

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

// ============ 트레이딩 로직 ============
async function checkPositions() {
    const positionsToClose = [];

    for (const position of state.portfolio.positions) {
        try {
            const market = await fetchMarketStatus(position.marketId);
            if (!market) continue;

            const prices = JSON.parse(market.outcomePrices || '[]');
            const isClosed = market.closed || (prices[0] === '1' || prices[0] === '0');

            if (isClosed) {
                const yesWon = parseFloat(prices[0]) === 1;
                const won = (position.side === 'YES' && yesWon) || (position.side === 'NO' && !yesWon);
                const exitPrice = won ? 100 : 0;
                const proceeds = position.shares * (exitPrice / 100);
                const profit = proceeds - position.cost;
                const profitPercent = (profit / position.cost) * 100;

                positionsToClose.push({
                    position,
                    exitPrice,
                    profit,
                    profitPercent,
                    won
                });
            }
        } catch (e) {
            // 에러 무시
        }
    }

    // 포지션 종료 처리
    for (const close of positionsToClose) {
        state.portfolio.balance += close.position.shares * (close.exitPrice / 100);

        const historyEntry = {
            ...close.position,
            exitPrice: close.exitPrice,
            exitTime: new Date().toISOString(),
            profit: close.profit,
            profitPercent: close.profitPercent,
            result: close.won ? 'WIN' : 'LOSS'
        };

        state.portfolio.history.unshift(historyEntry);
        state.portfolio.positions = state.portfolio.positions.filter(p => p.id !== close.position.id);

        const emoji = close.won ? '✅' : '❌';
        log(`${emoji} CLOSED: ${close.position.question.slice(0, 50)}... | ${close.won ? 'WIN' : 'LOSS'} | P/L: ${close.profit >= 0 ? '+' : ''}$${close.profit.toFixed(2)}`, close.won ? 'WIN' : 'LOSS');
    }

    if (positionsToClose.length > 0) {
        saveState();
    }

    return positionsToClose.length;
}

function executeBuy(market, tokenId, tokenIdNo, side, price) {
    const shares = CONFIG.positionSize / (price / 100);
    const cost = CONFIG.positionSize;

    state.portfolio.balance -= cost;

    const position = {
        id: Date.now().toString(),
        marketId: market.id,
        tokenId: side === 'YES' ? tokenId : tokenIdNo,
        question: market.question,
        side: side,
        entryPrice: price,
        shares: shares,
        cost: cost,
        entryTime: new Date().toISOString(),
        endDate: market.endDate
    };

    state.portfolio.positions.push(position);
    state.portfolio.marketCooldowns[market.id] = new Date().toISOString();

    saveState();

    log(`🟢 BUY ${side}: ${market.question.slice(0, 50)}... @ ${price.toFixed(1)}¢ ($${cost})`, 'BUY');

    return position;
}

async function scanMarkets() {
    if (!state.isRunning) return;

    state.totalScans++;
    state.lastScan = new Date().toISOString();

    try {
        // 1. 오픈 포지션 체크
        const closedCount = await checkPositions();

        // 2. 새 포지션 열 수 있는지 체크
        if (state.portfolio.positions.length >= CONFIG.maxPositions) {
            log(`Max positions reached (${state.portfolio.positions.length}/${CONFIG.maxPositions})`);
            return;
        }

        if (state.portfolio.balance < CONFIG.positionSize) {
            log(`Insufficient balance: $${state.portfolio.balance.toFixed(2)}`);
            return;
        }

        // 3. 마켓 가져오기
        const markets = await fetchMarkets();
        log(`Fetched ${markets.length} markets`);

        const now = new Date();
        const candidates = [];

        // 4. Near-expiry binary 마켓 필터링
        for (const market of markets) {
            try {
                const outcomes = JSON.parse(market.outcomes || '[]');
                if (outcomes.length !== 2) continue;
                if (market.negRisk === true) continue;

                if (!market.endDate || !market.startDate) continue;

                const startDate = new Date(market.startDate);
                const endDate = new Date(market.endDate);
                const totalDuration = endDate - startDate;
                const timeLeft = endDate - now;

                if (timeLeft <= 0) continue;

                const percentRemaining = (timeLeft / totalDuration) * 100;
                if (percentRemaining > CONFIG.nearExpiryPercent) continue;

                const tokens = JSON.parse(market.clobTokenIds || '[]');
                if (!tokens[0]) continue;

                // 쿨다운 체크
                const lastTrade = state.portfolio.marketCooldowns[market.id];
                if (lastTrade) {
                    const cooldownMs = CONFIG.cooldownMinutes * 60 * 1000;
                    if (now - new Date(lastTrade) < cooldownMs) continue;
                }

                // 이미 포지션 있는지 체크
                if (state.portfolio.positions.find(p => p.marketId === market.id)) continue;

                candidates.push({
                    market,
                    tokenId: tokens[0],
                    tokenIdNo: tokens[1],
                    percentRemaining,
                    timeLeft
                });
            } catch (e) {
                continue;
            }
        }

        if (candidates.length === 0) {
            log(`No candidates found (near-expiry ≤${CONFIG.nearExpiryPercent}%)`);
            return;
        }

        log(`Found ${candidates.length} candidates`);

        // 5. Orderbook 가져오기
        const tokenIds = candidates.flatMap(c => [c.tokenId, c.tokenIdNo].filter(Boolean));
        const orderbooks = await fetchOrderbooks(tokenIds);

        // 6. 매수 신호 체크
        let buysExecuted = 0;

        for (const candidate of candidates) {
            if (state.portfolio.positions.length >= CONFIG.maxPositions) break;
            if (state.portfolio.balance < CONFIG.positionSize) break;

            const yesOB = orderbooks[candidate.tokenId];
            const noOB = candidate.tokenIdNo ? orderbooks[candidate.tokenIdNo] : null;

            if (!yesOB) continue;

            const yesAsks = yesOB.asks || [];
            const yesBids = yesOB.bids || [];
            const noAsks = noOB?.asks || [];

            const yesBestAsk = yesAsks.length > 0 ? parseFloat(yesAsks[0].price) * 100 : null;
            const yesBestBid = yesBids.length > 0 ? parseFloat(yesBids[0].price) * 100 : null;
            const noBestAsk = noAsks.length > 0 ? parseFloat(noAsks[0].price) * 100 : null;

            // 스프레드 체크
            if (yesBestAsk !== null && yesBestBid !== null) {
                const spread = yesBestAsk - yesBestBid;
                if (spread > CONFIG.maxSpread) continue;
            }

            // YES 매수 (정확히 49¢ 또는 ≤49¢)
            if (yesBestAsk !== null) {
                const yesMatch = CONFIG.buyTriggerExact
                    ? (Math.round(yesBestAsk) === CONFIG.buyTrigger)
                    : (yesBestAsk <= CONFIG.buyTrigger);
                if (yesMatch) {
                    executeBuy(candidate.market, candidate.tokenId, candidate.tokenIdNo, 'YES', yesBestAsk);
                    buysExecuted++;
                    continue;
                }
            }

            // NO 매수 (정확히 49¢ 또는 ≤49¢)
            if (noBestAsk !== null) {
                const noMatch = CONFIG.buyTriggerExact
                    ? (Math.round(noBestAsk) === CONFIG.buyTrigger)
                    : (noBestAsk <= CONFIG.buyTrigger);
                if (noMatch) {
                    executeBuy(candidate.market, candidate.tokenId, candidate.tokenIdNo, 'NO', noBestAsk);
                    buysExecuted++;
                    continue;
                }
            }
        }

        if (buysExecuted > 0) {
            log(`Executed ${buysExecuted} buys`);
        }

    } catch (e) {
        state.errors++;
        log(`Scan error: ${e.message}`, 'ERROR');
    }
}

// ============ 통계 출력 ============
function printStats() {
    const closedTrades = state.portfolio.history.length;
    const openTrades = state.portfolio.positions.length;
    const wins = state.portfolio.history.filter(h => h.result === 'WIN').length;
    const totalProfit = state.portfolio.history.reduce((sum, h) => sum + (h.profit || 0), 0);
    const positionValue = state.portfolio.positions.reduce((sum, p) => sum + p.cost, 0);
    const totalValue = state.portfolio.balance + positionValue;
    const pnl = totalValue - state.portfolio.startingBalance;

    console.log('\n' + '='.repeat(60));
    console.log('📊 PAPER TRADING STATISTICS');
    console.log('='.repeat(60));
    console.log(`Balance: $${state.portfolio.balance.toFixed(2)}`);
    console.log(`Position Value: $${positionValue.toFixed(2)}`);
    console.log(`Total Value: $${totalValue.toFixed(2)}`);
    console.log(`P/L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
    console.log('-'.repeat(60));
    console.log(`Open Positions: ${openTrades}`);
    console.log(`Closed Trades: ${closedTrades}`);
    if (closedTrades > 0) {
        console.log(`Win Rate: ${((wins / closedTrades) * 100).toFixed(1)}% (${wins}/${closedTrades})`);
        console.log(`Total Realized P/L: ${totalProfit >= 0 ? '+' : ''}$${totalProfit.toFixed(2)}`);
    }
    console.log('-'.repeat(60));
    console.log(`Total Scans: ${state.totalScans}`);
    console.log(`Errors: ${state.errors}`);
    console.log(`Last Scan: ${state.lastScan || 'Never'}`);
    console.log('='.repeat(60) + '\n');
}

// ============ 메인 ============
async function start() {
    console.log('\n' + '='.repeat(60));
    console.log('🤖 POLYMARKET PAPER TRADING SERVER');
    console.log('='.repeat(60));
    console.log(`Buy Trigger: ${CONFIG.buyTriggerExact ? '=' : '≤'}${CONFIG.buyTrigger}¢`);
    console.log(`Near Expiry: ≤${CONFIG.nearExpiryPercent}%`);
    console.log(`Starting Balance: $${CONFIG.startingBalance}`);
    console.log(`Position Size: $${CONFIG.positionSize}`);
    console.log(`Max Positions: ${CONFIG.maxPositions}`);
    console.log(`Poll Interval: ${CONFIG.pollIntervalSec}s`);
    console.log('='.repeat(60) + '\n');

    loadState();
    printStats();

    state.isRunning = true;

    // 즉시 첫 스캔 실행
    log('Starting first scan...');
    await scanMarkets();

    // 주기적 스캔
    const interval = setInterval(async () => {
        if (!state.isRunning) {
            clearInterval(interval);
            return;
        }
        await scanMarkets();
    }, CONFIG.pollIntervalSec * 1000);

    // 5분마다 통계 출력
    setInterval(() => {
        if (state.isRunning) printStats();
    }, 5 * 60 * 1000);

    // Ctrl+C 처리
    process.on('SIGINT', () => {
        log('\nStopping server...');
        state.isRunning = false;
        saveState();
        printStats();
        process.exit(0);
    });

    // SIGTERM 처리 (Docker/PM2 등)
    process.on('SIGTERM', () => {
        log('\nReceived SIGTERM, stopping server...');
        state.isRunning = false;
        saveState();
        process.exit(0);
    });
}

// 실행
start().catch(e => {
    log(`Fatal error: ${e.message}`, 'ERROR');
    process.exit(1);
});

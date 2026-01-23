// Polymarket Paper Trading Bot
// 실시간으로 마켓 모니터링 후 조건 충족시 가상 매수

const fs = require('fs');

const CONFIG = {
    // 매수 조건 (45-55¢ 범위, 52¢ 이하에서 매수)
    targetAskPrice: 0.52,      // YES ask가 이 가격 이하일 때 매수
    maxAskPrice: 0.55,         // 최대 매수 가격
    minAskPrice: 0.45,         // 최소 매수 가격

    // 만료 조건
    maxDaysToExpiry: 14,       // 14일 이하 남았을 때만

    // 거래 설정
    tradeAmount: 100,          // 각 거래당 $100
    maxOpenPositions: 20,      // 최대 동시 포지션

    // 모니터링 간격 (마켓이 드물어서 5분 간격)
    checkIntervalMs: 300000,   // 5분마다 체크

    // 파일 경로
    tradesFile: './paper-trades.json',
    logFile: './paper-trading.log'
};

// 거래 기록 저장소
let trades = [];
let isRunning = false;

// 로그 함수
function log(message) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}`;
    console.log(logLine);
    fs.appendFileSync(CONFIG.logFile, logLine + '\n');
}

// 거래 기록 로드
function loadTrades() {
    try {
        if (fs.existsSync(CONFIG.tradesFile)) {
            trades = JSON.parse(fs.readFileSync(CONFIG.tradesFile, 'utf8'));
            log(`Loaded ${trades.length} existing trades`);
        }
    } catch (e) {
        log(`Error loading trades: ${e.message}`);
        trades = [];
    }
}

// 거래 기록 저장
function saveTrades() {
    fs.writeFileSync(CONFIG.tradesFile, JSON.stringify(trades, null, 2));
}

// 활성 마켓 가져오기
async function fetchActiveMarkets() {
    const GAMMA_API = 'https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=500';

    try {
        // 여러 페이지 가져오기
        const offsets = [0, 500, 1000, 1500, 2000];
        const promises = offsets.map(offset =>
            fetch(`${GAMMA_API}&offset=${offset}`).then(r => r.json()).catch(() => [])
        );

        const results = await Promise.all(promises);
        const allMarkets = results.flat();

        // 중복 제거
        const uniqueMarkets = [...new Map(allMarkets.map(m => [m.id, m])).values()];
        return uniqueMarkets;
    } catch (e) {
        log(`Error fetching markets: ${e.message}`);
        return [];
    }
}

// 오더북 가져오기 (실시간 bid/ask)
async function fetchOrderbook(tokenId) {
    try {
        const response = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
        const data = await response.json();
        return data;
    } catch (e) {
        return null;
    }
}

// 마켓 필터링 및 매수 신호 확인
async function checkMarketForSignal(market) {
    // 1. Binary 마켓인지 확인
    const outcomes = JSON.parse(market.outcomes || '[]');
    if (outcomes.length !== 2) return null;

    // 2. 만료일 확인
    if (!market.endDate || !market.startDate) return null;

    const now = new Date();
    const endDate = new Date(market.endDate);
    const startDate = new Date(market.startDate);

    if (endDate <= now) return null; // 이미 만료됨

    const timeLeft = endDate - now;
    const daysToExpiry = timeLeft / (1000 * 60 * 60 * 24);

    // 3. 시간 조건 체크 (일 기준)
    if (daysToExpiry > CONFIG.maxDaysToExpiry) return null;

    // 4. 오더북 가져오기
    const tokens = JSON.parse(market.clobTokenIds || '[]');
    if (!tokens[0]) return null;

    const orderbook = await fetchOrderbook(tokens[0]);
    if (!orderbook) return null;

    // 5. 최적 ask 가격 확인 (YES 토큰)
    const asks = orderbook.asks || [];
    if (asks.length === 0) return null;

    // 가장 낮은 ask 가격
    const bestAsk = parseFloat(asks[0]?.price || '1');
    const bestAskSize = parseFloat(asks[0]?.size || '0');

    // 6. 가격 조건 체크
    if (bestAsk < CONFIG.minAskPrice || bestAsk > CONFIG.maxAskPrice) return null;
    if (bestAsk > CONFIG.targetAskPrice) return null;

    // 7. 이미 포지션이 있는지 확인
    const existingTrade = trades.find(t => t.marketId === market.id && t.status === 'open');
    if (existingTrade) return null;

    // 신호 발생!
    return {
        market,
        tokenId: tokens[0],
        bestAsk,
        bestAskSize,
        daysToExpiry
    };
}

// 가상 매수 실행
function executePaperBuy(signal) {
    const { market, tokenId, bestAsk, daysToExpiry } = signal;

    const shares = CONFIG.tradeAmount / bestAsk;

    const trade = {
        id: Date.now().toString(),
        marketId: market.id,
        tokenId: tokenId,
        question: market.question,
        side: 'YES',
        entryPrice: bestAsk,
        shares: shares,
        cost: CONFIG.tradeAmount,
        entryTime: new Date().toISOString(),
        daysToExpiry: daysToExpiry,
        status: 'open',
        exitPrice: null,
        exitTime: null,
        profit: null,
        profitPercent: null
    };

    trades.push(trade);
    saveTrades();

    log(`🟢 BUY: ${market.question.slice(0, 50)}...`);
    log(`   Entry: ${(bestAsk * 100).toFixed(1)}¢ | Shares: ${shares.toFixed(2)} | Cost: $${CONFIG.tradeAmount}`);
    log(`   Time to expiry: ${timeToExpiry.toFixed(2)} days (${percentRemaining.toFixed(2)}% remaining)`);

    return trade;
}

// 오픈 포지션 체크 (결과 확인)
async function checkOpenPositions() {
    const openTrades = trades.filter(t => t.status === 'open');

    for (const trade of openTrades) {
        try {
            // 마켓 정보 가져오기
            const response = await fetch(`https://gamma-api.polymarket.com/markets/${trade.marketId}`);
            const market = await response.json();

            if (!market) continue;

            // 마켓이 종료되었는지 확인
            const prices = JSON.parse(market.outcomePrices || '[]');
            const isClosed = market.closed || (prices[0] === '1' || prices[0] === '0');

            if (isClosed) {
                // 결과 확정
                const yesWon = parseFloat(prices[0]) === 1;
                const exitPrice = yesWon ? 1 : 0;
                const profit = (exitPrice - trade.entryPrice) * trade.shares;
                const profitPercent = ((exitPrice - trade.entryPrice) / trade.entryPrice) * 100;

                trade.status = 'closed';
                trade.exitPrice = exitPrice;
                trade.exitTime = new Date().toISOString();
                trade.profit = profit;
                trade.profitPercent = profitPercent;
                trade.result = yesWon ? 'WIN' : 'LOSS';

                saveTrades();

                const emoji = yesWon ? '✅' : '❌';
                log(`${emoji} CLOSED: ${trade.question.slice(0, 50)}...`);
                log(`   Result: ${trade.result} | Entry: ${(trade.entryPrice * 100).toFixed(1)}¢ → Exit: ${(exitPrice * 100).toFixed(0)}¢`);
                log(`   P/L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)} (${profitPercent >= 0 ? '+' : ''}${profitPercent.toFixed(1)}%)`);
            }
        } catch (e) {
            // 조용히 무시
        }
    }
}

// 통계 출력
function printStats() {
    const closedTrades = trades.filter(t => t.status === 'closed');
    const openTrades = trades.filter(t => t.status === 'open');

    if (closedTrades.length === 0 && openTrades.length === 0) {
        log('No trades yet.');
        return;
    }

    console.log('\n' + '='.repeat(60));
    console.log('📊 PAPER TRADING STATISTICS');
    console.log('='.repeat(60));

    if (closedTrades.length > 0) {
        const wins = closedTrades.filter(t => t.result === 'WIN');
        const totalProfit = closedTrades.reduce((sum, t) => sum + (t.profit || 0), 0);
        const totalInvested = closedTrades.reduce((sum, t) => sum + t.cost, 0);
        const avgProfitPercent = closedTrades.reduce((sum, t) => sum + (t.profitPercent || 0), 0) / closedTrades.length;

        console.log(`\nClosed Trades: ${closedTrades.length}`);
        console.log(`Win Rate: ${(wins.length / closedTrades.length * 100).toFixed(1)}% (${wins.length}/${closedTrades.length})`);
        console.log(`Total P/L: ${totalProfit >= 0 ? '+' : ''}$${totalProfit.toFixed(2)}`);
        console.log(`Total Invested: $${totalInvested.toFixed(2)}`);
        console.log(`ROI: ${(totalProfit / totalInvested * 100).toFixed(1)}%`);
        console.log(`Avg P/L per trade: ${avgProfitPercent >= 0 ? '+' : ''}${avgProfitPercent.toFixed(1)}%`);
    }

    if (openTrades.length > 0) {
        console.log(`\nOpen Positions: ${openTrades.length}`);
        openTrades.forEach(t => {
            console.log(`  - ${t.question.slice(0, 40)}... @ ${(t.entryPrice * 100).toFixed(1)}¢`);
        });
    }

    console.log('='.repeat(60) + '\n');
}

// 메인 모니터링 루프
async function monitorLoop() {
    log('Checking markets...');

    // 1. 오픈 포지션 결과 확인
    await checkOpenPositions();

    // 2. 최대 포지션 수 체크
    const openCount = trades.filter(t => t.status === 'open').length;
    if (openCount >= CONFIG.maxOpenPositions) {
        log(`Max positions reached (${openCount}/${CONFIG.maxOpenPositions}). Skipping new signals.`);
        return;
    }

    // 3. 활성 마켓 가져오기
    const markets = await fetchActiveMarkets();
    log(`Fetched ${markets.length} active markets`);

    // 4. 각 마켓 체크 (병렬로 처리하되 rate limit 고려)
    let signalsFound = 0;
    const BATCH_SIZE = 10;

    for (let i = 0; i < markets.length && signalsFound < 5; i += BATCH_SIZE) {
        const batch = markets.slice(i, i + BATCH_SIZE);
        const signals = await Promise.all(batch.map(m => checkMarketForSignal(m)));

        for (const signal of signals) {
            if (signal && openCount + signalsFound < CONFIG.maxOpenPositions) {
                executePaperBuy(signal);
                signalsFound++;
            }
        }

        // Rate limiting
        if (i + BATCH_SIZE < markets.length) {
            await new Promise(r => setTimeout(r, 100));
        }
    }

    if (signalsFound === 0) {
        log('No new signals found.');
    }
}

// 시작
async function start() {
    console.log('\n' + '='.repeat(60));
    console.log('🤖 POLYMARKET PAPER TRADING BOT');
    console.log('='.repeat(60));
    console.log(`Target Ask Price: ≤${(CONFIG.targetAskPrice * 100).toFixed(0)}¢`);
    console.log(`Price Range: ${(CONFIG.minAskPrice * 100).toFixed(0)}¢ - ${(CONFIG.maxAskPrice * 100).toFixed(0)}¢`);
    console.log(`Max Time Remaining: ${CONFIG.maxTimeRemainingPercent}%`);
    console.log(`Trade Amount: $${CONFIG.tradeAmount}`);
    console.log(`Check Interval: ${CONFIG.checkIntervalMs / 1000}s`);
    console.log('='.repeat(60) + '\n');

    loadTrades();
    printStats();

    isRunning = true;

    // 즉시 첫 체크 실행
    await monitorLoop();

    // 주기적 체크
    const interval = setInterval(async () => {
        if (!isRunning) {
            clearInterval(interval);
            return;
        }
        await monitorLoop();
    }, CONFIG.checkIntervalMs);

    // 1시간마다 통계 출력
    setInterval(() => {
        if (isRunning) printStats();
    }, 60 * 60 * 1000);

    // Ctrl+C 처리
    process.on('SIGINT', () => {
        log('\nStopping bot...');
        isRunning = false;
        printStats();
        process.exit(0);
    });
}

// 실행
start().catch(console.error);

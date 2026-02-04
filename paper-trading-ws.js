// Polymarket Paper Trading - WebSocket Version
// 25개 병렬 WebSocket으로 전체 마켓 실시간 모니터링

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CONFIG = {
    // 매수 조건
    askMin: 45,           // ask 최소 45¢
    askMax: 49,           // ask 최대 49¢
    maxSpread: 5,         // 스프레드 최대 5¢
    buyBeforeExpiry: 60,  // 만기 60초(1분) 전에만 매수

    startingBalance: 10000,
    positionSize: 100,
    maxPositions: 50,
    cooldownMinutes: 10000000,
    wsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
    wsBatchSize: 500,
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
    lastUpdate: null,
    totalUpdates: 0,
    errors: 0,
    matches: 0,
    wsConnections: 0,
    totalTokens: 0
};

// 토큰별 오더북 저장
const orderbooks = new Map();
// 토큰 -> 마켓 매핑
const tokenToMarket = new Map();

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

async function fetchMarketStatus(marketId) {
    try {
        const response = await fetch(`https://gamma-api.polymarket.com/markets/${marketId}`);
        return await response.json();
    } catch (e) {
        return null;
    }
}

// REST API로 오더북 조회 (WebSocket보다 정확함)
async function fetchOrderbook(tokenId) {
    try {
        const response = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
        const data = await response.json();
        if (data.bids?.length) {
            // REST API: bids는 오름차순 (마지막이 최고가)
            const bestBid = parseFloat(data.bids[data.bids.length - 1].price) * 100;
            return { bestBid, data };
        }
        return null;
    } catch (e) {
        return null;
    }
}

// 보유 포지션의 매도 트리거 체크 (REST API 사용)
async function checkPositionSellTriggers() {
    for (const position of [...state.portfolio.positions]) {
        try {
            const ob = await fetchOrderbook(position.tokenId);
            if (!ob) continue;

            const { bestBid } = ob;

            // 매도 트리거: bid >= 50¢
            if (bestBid >= 50) {
                log(`💰 REST API SELL TRIGGER: ${position.question.slice(0, 30)}... | Market Bid: ${bestBid.toFixed(2)}¢`);
                executeSell(position, bestBid);
            }
        } catch (e) {
            state.errors++;
        }
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

    let url = `https://polymarket.com/market/${market.conditionId}`;

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

function executeSell(position, marketBid) {
    // marketBid = 현재 오더북 최고 bid 가격 (실제 매도 가능 가격)
    const proceeds = position.shares * (marketBid / 100);
    const profit = proceeds - position.cost;
    const profitPercent = (profit / position.cost) * 100;

    state.portfolio.balance += proceeds;
    state.portfolio.history.unshift({
        ...position, exitPrice: marketBid, exitTime: new Date().toISOString(),
        profit, profitPercent, result: profit >= 0 ? 'WIN' : 'LOSS'
    });
    state.portfolio.positions = state.portfolio.positions.filter(p => p.id !== position.id);
    log(`🔴 SELL @ Bid ${marketBid.toFixed(1)}¢: ${position.question.slice(0, 35)}... | Entry: ${position.entryPrice}¢ → Exit: ${marketBid.toFixed(1)}¢ | P/L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)} (${profitPercent >= 0 ? '+' : ''}${profitPercent.toFixed(1)}%)`, profit >= 0 ? 'WIN' : 'LOSS');
    saveState();
    return true;
}

function checkOrderbook(tokenId) {
    const ob = orderbooks.get(tokenId);
    if (!ob || !ob.bids?.length || !ob.asks?.length) return;

    const info = tokenToMarket.get(tokenId);
    if (!info) return;

    // WebSocket 데이터: bids는 오름차순(마지막이 최고가), asks는 내림차순(마지막이 최저가)
    const bid = parseFloat(ob.bids[ob.bids.length - 1].price) * 100;
    const ask = parseFloat(ob.asks[ob.asks.length - 1].price) * 100;
    const spread = ask - bid;

    // 매수 조건 체크
    // 1. Ask 45-49¢
    // 2. Spread ≤ 5¢
    // 3. 만기 1분 전
    const askInRange = ask >= CONFIG.askMin && ask <= CONFIG.askMax;
    const spreadOk = spread <= CONFIG.maxSpread;

    if (!askInRange || !spreadOk) return;

    // 만기 체크
    const endDate = info.market.endDate ? new Date(info.market.endDate) : null;
    if (!endDate) return;

    const now = new Date();
    const secondsToExpiry = (endDate.getTime() - now.getTime()) / 1000;

    // 만기 1분(60초) 전에만 매수
    if (secondsToExpiry > CONFIG.buyBeforeExpiry || secondsToExpiry <= 0) return;

    state.matches++;
    const hasCooldown = !!state.portfolio.marketCooldowns[info.market.id];
    const hasPosition = !!state.portfolio.positions.find(p => p.marketId === info.market.id);
    log(`📊 MATCH: ${info.side} bid=${bid.toFixed(1)}¢ ask=${ask.toFixed(1)}¢ spread=${spread.toFixed(1)}¢ expiry=${secondsToExpiry.toFixed(0)}s - ${info.market.question.slice(0, 35)}... [cd:${hasCooldown}, pos:${hasPosition}]`);
    executeBuy(info.market, info.tokenId, info.tokenIdNo, info.side, ask);
}

function processMessage(data) {
    state.totalUpdates++;
    state.lastUpdate = new Date().toISOString();

    try {
        const msg = JSON.parse(data);

        // 첫 메시지: 배열 형태의 전체 오더북
        if (Array.isArray(msg)) {
            for (const item of msg) {
                if (item.asset_id) {
                    orderbooks.set(item.asset_id, {
                        bids: item.bids || [],
                        asks: item.asks || []
                    });
                    checkOrderbook(item.asset_id);
                }
            }
        }
        // 업데이트 메시지: price_changes 배열
        else if (msg.price_changes) {
            for (const change of msg.price_changes) {
                const tokenId = change.asset_id;
                if (!tokenId) continue;

                // best_bid, best_ask가 있으면 직접 사용 (더 정확함)
                if (change.best_bid && change.best_ask) {
                    const existing = orderbooks.get(tokenId) || { bids: [], asks: [] };
                    // best_bid/ask를 오더북에 반영
                    existing.bids = [{ price: change.best_bid, size: '1' }];
                    existing.asks = [{ price: change.best_ask, size: '1' }];
                    orderbooks.set(tokenId, existing);
                    checkOrderbook(tokenId);
                }
            }
        }
    } catch (e) {
        state.errors++;
    }

    if (state.totalUpdates % 10000 === 0) {
        saveState();
        log(`Updates: ${state.totalUpdates}, Matches: ${state.matches}, Tokens: ${state.totalTokens}`);
    }
}

function connectWebSocket(tokenIds, batchIndex) {
    return new Promise((resolve) => {
        const ws = new WebSocket(CONFIG.wsUrl);
        let resolved = false;

        ws.on('open', () => {
            const subscribeMsg = JSON.stringify({
                assets_ids: tokenIds,
                type: 'market'
            });
            ws.send(subscribeMsg);
            state.wsConnections++;
            if (!resolved) {
                resolved = true;
                resolve(ws);
            }
        });

        ws.on('message', (data) => {
            processMessage(data.toString());
        });

        ws.on('error', (err) => {
            state.errors++;
            if (!resolved) {
                resolved = true;
                resolve(null);
            }
        });

        ws.on('close', () => {
            state.wsConnections--;
            log(`WS ${batchIndex} closed, reconnecting...`, 'WARN');
            // 재연결
            setTimeout(() => {
                connectWebSocket(tokenIds, batchIndex).then(newWs => {
                    if (newWs) log(`WS ${batchIndex} reconnected`);
                });
            }, 5000);
        });

        // 타임아웃
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                resolve(null);
            }
        }, 10000);
    });
}

async function start() {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 POLYMARKET PAPER TRADING BOT (WebSocket)');
    console.log('='.repeat(60));
    console.log(`Buy: Ask ${CONFIG.askMin}-${CONFIG.askMax}¢, Spread≤${CONFIG.maxSpread}¢, Expiry≤${CONFIG.buyBeforeExpiry}s`);
    console.log(`Sell: Hold until expiry | Balance: $${CONFIG.startingBalance} | Size: $${CONFIG.positionSize}`);
    console.log('='.repeat(60) + '\n');

    loadState();
    state.isRunning = true;
    saveState();

    log('Fetching markets...');
    const markets = await fetchMarkets();
    log(`Loaded ${markets.length} markets`);

    // 바이너리 마켓 필터링 (멀티마켓만 제외)
    const candidates = markets.filter(m => {
        try {
            const outcomes = JSON.parse(m.outcomes || '[]');
            const tokens = JSON.parse(m.clobTokenIds || '[]');
            if (outcomes.length !== 2 || m.negRisk || !tokens[0] || !tokens[1]) return false;

            // 멀티마켓 이벤트 제외 (groupItemTitle이 있으면 멀티마켓)
            if (m.groupItemTitle) return false;

            return true;
        } catch { return false; }
    });

    log(`Binary markets: ${candidates.length}`);

    // 토큰 매핑 생성
    const allTokenIds = [];
    for (const market of candidates) {
        const tokens = JSON.parse(market.clobTokenIds);
        allTokenIds.push(tokens[0], tokens[1]);
        tokenToMarket.set(tokens[0], { market, side: 'YES', tokenId: tokens[0], tokenIdNo: tokens[1] });
        tokenToMarket.set(tokens[1], { market, side: 'NO', tokenId: tokens[0], tokenIdNo: tokens[1] });
    }

    state.totalTokens = allTokenIds.length;
    log(`Total tokens: ${allTokenIds.length}`);

    // 배치로 나누기
    const batches = [];
    for (let i = 0; i < allTokenIds.length; i += CONFIG.wsBatchSize) {
        batches.push(allTokenIds.slice(i, i + CONFIG.wsBatchSize));
    }

    log(`Connecting ${batches.length} WebSockets...`);

    // 병렬로 모든 WebSocket 연결
    const startTime = Date.now();
    const connections = await Promise.all(
        batches.map((batch, idx) => connectWebSocket(batch, idx))
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    const successCount = connections.filter(c => c !== null).length;
    log(`Connected: ${successCount}/${batches.length} WebSockets in ${elapsed}s`);

    // 30초마다 포지션 체크 (마켓 종료/결과 확인)
    setInterval(() => {
        if (state.isRunning) checkPositions();
    }, 30 * 1000);

    // 30초마다 상태 로그
    setInterval(() => {
        // 오더북 통계
        let validOrderbooks = 0;
        let askInRangeCount = 0;      // ask 45-49
        let buyConditionCount = 0;    // ask 45-49 + spread ≤5
        let readyToBuyCount = 0;      // 모든 조건 충족 (ask + spread + expiry)

        const now = new Date();

        for (const [tokenId, ob] of orderbooks) {
            if (!ob.bids?.length || !ob.asks?.length) continue;
            validOrderbooks++;

            const bid = parseFloat(ob.bids[ob.bids.length - 1].price) * 100;
            const ask = parseFloat(ob.asks[ob.asks.length - 1].price) * 100;
            const spread = ask - bid;

            // ask 45-49 체크
            const askOk = ask >= CONFIG.askMin && ask <= CONFIG.askMax;
            const spreadOk = spread <= CONFIG.maxSpread;

            if (askOk) askInRangeCount++;
            if (askOk && spreadOk) buyConditionCount++;

            // 만기 체크 (모든 조건 충족 시에만 카운트)
            if (askOk && spreadOk) {
                const info = tokenToMarket.get(tokenId);
                if (info?.market?.endDate) {
                    const endDate = new Date(info.market.endDate);
                    const secondsToExpiry = (endDate.getTime() - now.getTime()) / 1000;
                    if (secondsToExpiry > 0 && secondsToExpiry <= CONFIG.buyBeforeExpiry) {
                        readyToBuyCount++;
                    }
                }
            }
        }

        log(`Status: OB=${validOrderbooks}/${orderbooks.size} | Ask45-49:${askInRangeCount} | +Spread≤5:${buyConditionCount} | READY:${readyToBuyCount}`);
        saveState();
    }, 30 * 1000);

    process.on('SIGINT', () => { state.isRunning = false; saveState(); process.exit(0); });
    process.on('SIGTERM', () => { state.isRunning = false; saveState(); process.exit(0); });
}

start().catch(e => { log(`Fatal: ${e.message}`, 'ERROR'); process.exit(1); });

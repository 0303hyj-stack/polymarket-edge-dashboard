// Polymarket 50¢ Strategy Backtest
// 히스토리컬 데이터를 사용해서 50¢ 근처 매수 전략 성과 분석

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

async function fetchClosedMarkets() {
    console.log('Fetching closed markets since 2024...\n');

    const response = await fetch(`${GAMMA_API}/markets?closed=true&limit=500&end_date_min=2024-01-01`);
    const markets = await response.json();

    // Filter for binary markets with significant volume
    const filtered = markets.filter(m => {
        const vol = parseFloat(m.volume) || 0;
        const outcomes = JSON.parse(m.outcomes || '[]');
        const prices = JSON.parse(m.outcomePrices || '[]');
        const hasResolution = prices.length === 2 && (prices[0] === '1' || prices[0] === '0');
        return vol > 10000 && outcomes.length === 2 && hasResolution && !m.negRisk;
    });

    console.log(`Found ${filtered.length} resolved binary markets with volume > $10K\n`);
    return filtered;
}

async function fetchPriceHistory(tokenId) {
    try {
        const response = await fetch(`${CLOB_API}/prices-history?market=${tokenId}&interval=max&fidelity=1440`);
        const data = await response.json();
        return data.history || [];
    } catch (e) {
        return [];
    }
}

async function backtest() {
    const markets = await fetchClosedMarkets();

    const results = [];
    const resultsNearExpiry = []; // Only markets where 50¢ was near expiry
    let processed = 0;

    console.log('Analyzing price history for each market...\n');

    for (const market of markets.slice(0, 200)) { // Analyze more markets
        const tokens = JSON.parse(market.clobTokenIds || '[]');
        if (!tokens[0]) continue;
        if (!market.endDate || !market.startDate) continue;

        const history = await fetchPriceHistory(tokens[0]);
        if (history.length === 0) continue;

        // Get final resolution (YES=1 or YES=0)
        const finalPrices = JSON.parse(market.outcomePrices || '[]');
        const yesResolved = parseFloat(finalPrices[0]) === 1;

        // Calculate market duration
        const startDate = new Date(market.startDate);
        const endDate = new Date(market.endDate);
        const totalDuration = endDate - startDate;

        // Find moments when price was 45-55¢ AND near expiry (≤5% remaining)
        const near50NearExpiry = history.filter(h => {
            if (h.p < 0.45 || h.p > 0.55) return false;
            const timestamp = new Date(h.t * 1000);
            const timeLeft = endDate - timestamp;
            const percentRemaining = (timeLeft / totalDuration) * 100;
            return percentRemaining >= 0 && percentRemaining <= 5; // Within 5% of expiry
        });

        // Also track all 50¢ moments (for comparison)
        const near50All = history.filter(h => h.p >= 0.45 && h.p <= 0.55);

        if (near50All.length > 0) {
            const entryPrice = near50All[0].p;
            const exitPrice = yesResolved ? 1 : 0;
            const profitPercent = ((exitPrice - entryPrice) / entryPrice * 100).toFixed(1);

            results.push({
                question: market.question.slice(0, 60),
                volume: parseFloat(market.volume),
                entryPrice: (entryPrice * 100).toFixed(1),
                resolution: yesResolved ? 'YES' : 'NO',
                profit: profitPercent
            });
        }

        // Near-expiry strategy (THE REAL EDGE TEST)
        if (near50NearExpiry.length > 0) {
            const entryPrice = near50NearExpiry[0].p;
            const exitPrice = yesResolved ? 1 : 0;
            const profitPercent = ((exitPrice - entryPrice) / entryPrice * 100).toFixed(1);

            const entryDate = new Date(near50NearExpiry[0].t * 1000);
            const daysToExpiry = ((endDate - entryDate) / (1000 * 60 * 60 * 24)).toFixed(1);

            resultsNearExpiry.push({
                question: market.question.slice(0, 55),
                volume: parseFloat(market.volume),
                entryPrice: (entryPrice * 100).toFixed(1),
                resolution: yesResolved ? 'YES' : 'NO',
                profit: profitPercent,
                daysToExpiry: daysToExpiry
            });
        }

        processed++;
        if (processed % 10 === 0) {
            process.stdout.write(`Processed ${processed} markets...\r`);
        }

        // Rate limit
        await new Promise(r => setTimeout(r, 100));
    }

    console.log(`\n\n${'='.repeat(80)}`);
    console.log('BACKTEST RESULTS: Buying YES at ~50¢');
    console.log('='.repeat(80) + '\n');

    // Summary stats
    const wins = results.filter(r => parseFloat(r.profit) > 0);
    const losses = results.filter(r => parseFloat(r.profit) < 0);
    const totalProfit = results.reduce((sum, r) => sum + parseFloat(r.profit), 0);

    console.log(`Markets analyzed: ${results.length}`);
    console.log(`Win rate: ${(wins.length / results.length * 100).toFixed(1)}% (${wins.length}/${results.length})`);
    console.log(`Average profit per trade: ${(totalProfit / results.length).toFixed(1)}%`);
    console.log(`Total cumulative return: ${totalProfit.toFixed(1)}%\n`);

    // Breakdown
    console.log('--- WINS (YES resolved to 100¢) ---');
    wins.slice(0, 10).forEach(r => {
        console.log(`  ${r.question}...`);
        console.log(`    Entry: ${r.entryPrice}¢ → 100¢ | Profit: +${r.profit}%`);
    });

    console.log('\n--- LOSSES (YES resolved to 0¢) ---');
    losses.slice(0, 10).forEach(r => {
        console.log(`  ${r.question}...`);
        console.log(`    Entry: ${r.entryPrice}¢ → 0¢ | Loss: ${r.profit}%`);
    });

    // Edge analysis
    console.log('\n--- EDGE ANALYSIS (All 50¢ moments) ---');
    console.log('If market is truly 50/50, expected profit = 0%');
    console.log(`Actual average profit: ${(totalProfit / results.length).toFixed(1)}%`);

    // ===== NEAR-EXPIRY STRATEGY (THE REAL TEST) =====
    console.log('\n' + '='.repeat(80));
    console.log('★★★ NEAR-EXPIRY STRATEGY (50¢ within 5% of expiry) ★★★');
    console.log('='.repeat(80) + '\n');

    if (resultsNearExpiry.length === 0) {
        console.log('No markets found with 50¢ price near expiry.');
    } else {
        const winsNE = resultsNearExpiry.filter(r => parseFloat(r.profit) > 0);
        const lossesNE = resultsNearExpiry.filter(r => parseFloat(r.profit) < 0);
        const totalProfitNE = resultsNearExpiry.reduce((sum, r) => sum + parseFloat(r.profit), 0);

        console.log(`Markets with 50¢ near expiry: ${resultsNearExpiry.length}`);
        console.log(`Win rate: ${(winsNE.length / resultsNearExpiry.length * 100).toFixed(1)}% (${winsNE.length}/${resultsNearExpiry.length})`);
        console.log(`Average profit per trade: ${(totalProfitNE / resultsNearExpiry.length).toFixed(1)}%`);
        console.log(`Total cumulative return: ${totalProfitNE.toFixed(1)}%\n`);

        console.log('--- Details ---');
        resultsNearExpiry.forEach(r => {
            const symbol = parseFloat(r.profit) > 0 ? '✓' : '✗';
            console.log(`${symbol} ${r.question}`);
            console.log(`    Entry: ${r.entryPrice}¢ | Days to expiry: ${r.daysToExpiry} | Result: ${r.resolution} | P/L: ${r.profit}%`);
        });

        console.log('\n--- CONCLUSION ---');
        if (totalProfitNE > 0) {
            console.log('✓ POSITIVE EDGE: Buying at 50¢ near expiry is profitable!');
        } else if (totalProfitNE < 0) {
            console.log('✗ NEGATIVE EDGE: No edge found in this strategy.');
        } else {
            console.log('→ NEUTRAL: Results match random 50/50.');
        }
    }

    return { all: results, nearExpiry: resultsNearExpiry };
}

// Run backtest
backtest().catch(console.error);

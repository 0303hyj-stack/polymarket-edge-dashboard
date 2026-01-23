// Paper Trading 상태 확인 스크립트
const fs = require('fs');

const TRADES_FILE = './paper-trades.json';

function checkStatus() {
    console.log('\n' + '='.repeat(60));
    console.log('📊 PAPER TRADING STATUS');
    console.log('='.repeat(60));

    // 거래 기록 로드
    let trades = [];
    try {
        if (fs.existsSync(TRADES_FILE)) {
            trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
        }
    } catch (e) {
        console.log('Error loading trades:', e.message);
        return;
    }

    if (trades.length === 0) {
        console.log('\nNo trades yet. Bot is waiting for signals...');
        console.log('Conditions: 45-52¢ ask, ≤14 days to expiry');
        return;
    }

    const openTrades = trades.filter(t => t.status === 'open');
    const closedTrades = trades.filter(t => t.status === 'closed');

    // 종료된 거래 통계
    if (closedTrades.length > 0) {
        const wins = closedTrades.filter(t => t.result === 'WIN');
        const totalProfit = closedTrades.reduce((sum, t) => sum + (t.profit || 0), 0);
        const totalInvested = closedTrades.reduce((sum, t) => sum + t.cost, 0);
        const avgProfitPercent = closedTrades.reduce((sum, t) => sum + (t.profitPercent || 0), 0) / closedTrades.length;

        console.log('\n📈 CLOSED POSITIONS');
        console.log('-'.repeat(40));
        console.log(`Total Trades: ${closedTrades.length}`);
        console.log(`Win Rate: ${(wins.length / closedTrades.length * 100).toFixed(1)}% (${wins.length}W / ${closedTrades.length - wins.length}L)`);
        console.log(`Total P/L: ${totalProfit >= 0 ? '+' : ''}$${totalProfit.toFixed(2)}`);
        console.log(`ROI: ${(totalProfit / totalInvested * 100).toFixed(1)}%`);
        console.log(`Avg P/L per trade: ${avgProfitPercent >= 0 ? '+' : ''}${avgProfitPercent.toFixed(1)}%`);

        console.log('\nRecent closed trades:');
        closedTrades.slice(-5).reverse().forEach(t => {
            const emoji = t.result === 'WIN' ? '✅' : '❌';
            console.log(`  ${emoji} ${t.question.slice(0, 40)}...`);
            console.log(`     ${(t.entryPrice * 100).toFixed(1)}¢ → ${(t.exitPrice * 100).toFixed(0)}¢ | P/L: ${t.profit >= 0 ? '+' : ''}$${t.profit.toFixed(2)}`);
        });
    }

    // 오픈 포지션
    if (openTrades.length > 0) {
        const totalCost = openTrades.reduce((sum, t) => sum + t.cost, 0);

        console.log('\n📍 OPEN POSITIONS');
        console.log('-'.repeat(40));
        console.log(`Active Trades: ${openTrades.length}`);
        console.log(`Total at Risk: $${totalCost.toFixed(2)}`);

        openTrades.forEach(t => {
            const entryDate = new Date(t.entryTime);
            const ageHours = (Date.now() - entryDate) / (1000 * 60 * 60);
            console.log(`\n  • ${t.question.slice(0, 45)}...`);
            console.log(`    Entry: ${(t.entryPrice * 100).toFixed(1)}¢ | Cost: $${t.cost} | ${ageHours.toFixed(1)}h ago`);
            console.log(`    Days to expiry at entry: ${t.daysToExpiry.toFixed(1)}d`);
        });
    } else {
        console.log('\n📍 No open positions');
    }

    console.log('\n' + '='.repeat(60));
}

checkStatus();

async function findAllPrices() {
    const response = await fetch("https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=300");
    const markets = await response.json();

    let priceDistribution = {};
    let near50 = [];

    for (const m of markets.slice(0, 150)) {
        const tokens = JSON.parse(m.clobTokenIds || "[]");
        if (!tokens[0]) continue;

        try {
            const ob = await fetch("https://clob.polymarket.com/book?token_id=" + tokens[0]).then(r => r.json());
            if (ob.asks && ob.asks[0]) {
                const price = parseFloat(ob.asks[0].price);
                const bucket = Math.floor(price * 10) / 10;
                priceDistribution[bucket] = (priceDistribution[bucket] || 0) + 1;

                // 20-80¢ 범위의 마켓 저장
                if (price >= 0.20 && price <= 0.80) {
                    near50.push({
                        q: m.question.slice(0, 50),
                        ask: price,
                        endDate: m.endDate
                    });
                }
            }
        } catch(e) {}
    }

    console.log("Price distribution of first 150 markets:");
    Object.keys(priceDistribution).sort((a,b) => parseFloat(a) - parseFloat(b)).forEach(k => {
        console.log((parseFloat(k)*100).toFixed(0) + "-" + (parseFloat(k)*100+10).toFixed(0) + "c: " + priceDistribution[k] + " markets");
    });

    console.log("\nMarkets in 20-80c range (closest to 50c first):");
    near50.sort((a,b) => Math.abs(a.ask - 0.5) - Math.abs(b.ask - 0.5));
    near50.slice(0, 10).forEach(m => {
        const days = m.endDate ? ((new Date(m.endDate) - new Date()) / (1000*60*60*24)).toFixed(0) : '?';
        console.log((m.ask*100).toFixed(1) + "c | " + days + "d | " + m.q);
    });
}
findAllPrices();

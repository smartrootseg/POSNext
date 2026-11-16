/** Pure promotion rules. Prices are expressed in integer currency minor units. */

/** Conditions are grouped by field. Includes are ORed within a field. */
export function matchesPromotionFilters(item, filters) {
    const required = new Map();
    for (const { field, value, exclude } of filters) {
        const actual = item[field];
        const matches = Array.isArray(actual) ? actual.includes(value) : actual === value;
        if (exclude && matches) return false;
        if (!exclude) required.set(field, Boolean(required.get(field)) || matches);
    }
    return [...required.values()].every(Boolean);
}

/** Use the trusted site date, or its offline equivalent, as YYYY-MM-DD. */
export function isPromotionActive(promotion, profile, date) {
    return promotion.enabled && promotion.profiles.includes(profile) &&
        promotion.startDate <= date && date <= promotion.endDate;
}

/** Convert a percentage in basis points to a currency discount, rounded half up. */
export function percentageDiscount(price, basisPoints) {
    if (!Number.isSafeInteger(price) || price < 0 || !Number.isInteger(basisPoints) ||
        basisPoints <= 0 || basisPoints > 10000) {
        throw new Error("Expected a non-negative minor-unit price and a percentage from 0.01 to 100.");
    }
    return Number((BigInt(price) * BigInt(basisPoints) + 5000n) / 10000n);
}

/**
 * Calculate one Buy X Get Y offer in isolation. Each input is a physical unit
 * with a stable identifier, its base price, and the item facts used by filters.
 * A unit that matches both sides can fill only one position.
 */
export function allocateBuyGet(units, promotion) {
    const { buyQuantity, getQuantity, buyFilters, getFilters } = promotion;
    if (![buyQuantity, getQuantity].every(value => Number.isSafeInteger(value) && value > 0)) {
        throw new Error("Buy and Get quantities must be positive whole numbers.");
    }

    const eligible = units.map(unit => ({
        unit,
        buy: matchesPromotionFilters(unit.item, buyFilters),
        get: matchesPromotionFilters(unit.item, getFilters),
    })).filter(row => row.buy || row.get);
    const buyCount = eligible.filter(row => row.buy).length;
    const getCount = eligible.filter(row => row.get).length;
    const applications = Math.min(
        Math.floor(buyCount / buyQuantity),
        Math.floor(getCount / getQuantity),
        Math.floor(eligible.length / (buyQuantity + getQuantity)),
    );
    const paidNeeded = applications * buyQuantity;
    const freeNeeded = applications * getQuantity;

    // Select the cheapest qualifying gifts while reserving enough Buy units.
    const ordered = eligible.sort((left, right) => left.unit.price - right.unit.price ||
        (left.unit.id < right.unit.id ? -1 : Number(left.unit.id > right.unit.id)));
    let remainingBuy = buyCount;
    const free = [];
    const freeIds = new Set();
    for (const { unit, buy, get } of ordered) {
        if (free.length === freeNeeded) break;
        if (!get || (buy && remainingBuy === paidNeeded)) continue;
        if (buy) remainingBuy--;
        free.push(unit);
        freeIds.add(unit.id);
    }

    const paid = ordered.reverse().filter(row => row.buy && !freeIds.has(row.unit.id))
        .slice(0, paidNeeded).map(row => row.unit);
    return { applications, paid, free };
}

/** Returns can include unrelated items, but must include all or none of an offer. */
export function canReturnBuyGet(application, returnedUnitIds) {
    const units = [...application.paid, ...application.free];
    const returned = new Set(returnedUnitIds);
    const count = units.filter(unit => returned.has(unit.id)).length;
    return count === 0 || count === units.length;
}

/**
 * Compare non-overlapping promotion allocations. A Buy/Get application owns
 * both its paid and free units. Other units can take their best percentage.
 */
export function selectBestPromotions(units, promotions, profile, date) {
    const active = promotions.filter(offer => isPromotionActive(offer, profile, date))
        .sort((left, right) => left.id < right.id ? -1 : Number(left.id > right.id));
    const percentageOffers = active.filter(offer => offer.type === "percentage");
    const bundles = active.filter(offer => offer.type === "buy_get");
    const baseline = new Map();
    const pools = bundles.map(() => []);
    const groups = new Map();

    for (const unit of units) {
        let best = { amount: 0 };
        for (const offer of percentageOffers) {
            if (!matchesPromotionFilters(unit.item, offer.filters)) continue;
            const amount = percentageDiscount(unit.price, offer.basisPoints);
            if (amount > best.amount) best = { amount, offerId: offer.id };
        }
        baseline.set(unit.id, best);

        const eligibility = bundles.map(offer => {
            const buy = matchesPromotionFilters(unit.item, offer.buyFilters) ? 1 : 0;
            const get = matchesPromotionFilters(unit.item, offer.getFilters) ? 2 : 0;
            return buy + get;
        });
        const options = eligibility.flatMap((sides, index) => sides ? [index] : []);
        if (!options.length) continue;
        if (options.length === 1 && !best.amount) {
            pools[options[0]].push(unit);
            continue;
        }
        const key = JSON.stringify([unit.price, best.amount, eligibility]);
        if (!groups.has(key)) groups.set(key, { units: [], options: [-1, ...options] });
        groups.get(key).units.push(unit);
    }

    const contested = [...groups.values()];
    let best = { savings: -1, bundles: [], percentages: [] };
    let searchSteps = 0;

    function evaluate() {
        const applications = [];
        const reserved = new Set();
        let savings = 0;
        for (const [index, offer] of bundles.entries()) {
            const result = allocateBuyGet(pools[index], offer);
            if (!result.applications) continue;
            const amount = result.free.reduce((sum, unit) => sum + unit.price, 0);
            if (!amount) continue;
            for (const unit of [...result.paid, ...result.free]) reserved.add(unit.id);
            savings += amount;
            applications.push({ offerId: offer.id, ...result });
        }

        const percentages = [];
        for (const unit of units) {
            const result = baseline.get(unit.id);
            if (!result.amount || reserved.has(unit.id)) continue;
            savings += result.amount;
            percentages.push({ unitId: unit.id, ...result });
        }
        if (savings > best.savings) best = { savings, bundles: applications, percentages };
    }

    function distribute(groupIndex, optionIndex, start) {
        if (++searchSteps > 100000 || optionIndex > 100) {
            throw new Error("Too many overlapping promotion combinations to price this cart.");
        }
        if (groupIndex === contested.length) {
            evaluate();
            return;
        }
        const { units: equivalents, options } = contested[groupIndex];
        const last = optionIndex === options.length - 1;
        for (let end = last ? equivalents.length : start; end <= equivalents.length; end++) {
            const pool = pools[options[optionIndex]];
            const count = end - start;
            if (pool && count) pool.push(...equivalents.slice(start, end));
            if (end === equivalents.length) distribute(groupIndex + 1, 0, 0);
            else distribute(groupIndex, optionIndex + 1, end);
            if (pool && count) pool.length -= count;
        }
    }

    distribute(0, 0, 0);
    return best;
}

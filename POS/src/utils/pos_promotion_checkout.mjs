import { selectBestPromotions } from "./pos_promotion_rules.mjs";

/** Calculate the promotion breakdown before tendering or saving an offline sale. */
export function quotePromotionCart(lines, catalog, configuration, saleDate) {
    const units = [];
    for (const [lineIndex, line] of lines.entries()) {
        const item = catalog[line.item_code];
        if (!item) throw new Error(`Promotion data is missing for ${line.item_code}.`);
        if (!Number.isSafeInteger(line.qty) || line.qty <= 0 ||
            !Number.isSafeInteger(line.basePrice) || line.basePrice < 0) {
            throw new Error(`Invalid promotion quantity or base price for ${line.item_code}.`);
        }
        if (units.length + line.qty > 250) throw new Error("A promotion cart can contain up to 250 units.");
        for (let index = 0; index < line.qty; index++) {
            units.push({ id: `${lineIndex}:${index}`, lineIndex, price: line.basePrice, item });
        }
    }

    const selected = selectBestPromotions(units, configuration.promotions, configuration.profile, saleDate);
    const amounts = new Map();
    for (const percentage of selected.percentages) {
        amounts.set(percentage.unitId, { discount: percentage.amount, offerId: percentage.offerId });
    }
    for (const bundle of selected.bundles) {
        for (const unit of bundle.paid) amounts.set(unit.id, { discount: 0, offerId: bundle.offerId, part: "paid" });
        for (const unit of bundle.free) amounts.set(unit.id, { discount: unit.price, offerId: bundle.offerId, part: "free" });
    }

    // Keep paid and free quantities on separate invoice lines. The original
    // Sales Invoice Item references can then distinguish identical SKUs in returns.
    const invoiceLines = new Map();
    for (const unit of units) {
        const { discount = 0, offerId = null, part = null } = amounts.get(unit.id) ?? {};
        const key = JSON.stringify([unit.lineIndex, discount, offerId, part]);
        if (!invoiceLines.has(key)) {
            invoiceLines.set(key, {
                lineId: String(invoiceLines.size + 1),
                cartLine: unit.lineIndex,
                qty: 0,
                basePrice: unit.price,
                unitDiscount: discount,
                unitNetPrice: unit.price - discount,
                offerId,
                part,
            });
        }
        invoiceLines.get(key).qty++;
    }

    const breakdown = [...invoiceLines.values()];
    return {
        profile: configuration.profile,
        saleDate,
        savings: selected.savings,
        lines: breakdown,
        groups: selected.bundles.map(bundle => ({
            offerId: bundle.offerId,
            lines: breakdown.filter(line => line.part && line.offerId === bundle.offerId)
                .map(({ lineId, qty }) => ({ lineId, qty })),
        })),
    };
}

/** Convert POS cart lines to the same rate and quantity fields used online. */
export function serializeOfflineInvoiceItems(lines, taxInclusive) {
	return lines.map((line) => {
		const qty = line.quantity ?? line.qty
		const baseRate = line.price_list_rate ?? line.rate ?? 0
		const discount = line.discount_amount ?? 0
		const rate = taxInclusive
			? baseRate - discount / qty
			: line.amount != null ? line.amount / qty : baseRate - discount / qty
		return {
			...line,
			qty,
			rate,
			price_list_rate: baseRate,
			conversion_factor: line.conversion_factor || 1,
			discount_percentage: line.discount_percentage || 0,
			discount_amount: discount,
		}
	})
}

/** Preserve separate paid and free lines, with references local to this quote. */
export function serializePromotionInvoiceItems(lines, taxInclusive, quote) {
	const base = serializeOfflineInvoiceItems(lines, taxInclusive)
	return quote.lines.map((row) => {
		const source = base[row.cartLine]
		return {
			...source,
			qty: row.qty,
			quantity: row.qty,
			price_list_rate: row.basePrice / 100,
			rate: row.unitNetPrice / 100,
			discount_percentage: row.basePrice ? 100 * row.unitDiscount / row.basePrice : 0,
			discount_amount: row.unitDiscount / 100,
			custom_avenue88_promotion_line: row.lineId,
		}
	})
}

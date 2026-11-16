import { call } from "@/utils/apiWrapper"
import { db } from "./db"

const methods = "avenue88_custom.api.pos_promotions"
const refreshes = new Map()

function cacheKey(user, profile) {
	if (!user || !profile) throw new Error("A signed-in user and POS profile are required.")
	return JSON.stringify(["avenue88-promotions", user, profile])
}

export async function readPromotionCatalog(user, profile) {
	return (await db.settings.get(cacheKey(user, profile)))?.value ?? null
}

// Serialize writes for a register so overlapping searches and checkout cannot lose item proofs.
export function refreshPromotionCatalog(user, profile, itemCodes, { missingOnly = false } = {}) {
	const key = cacheKey(user, profile)
	const codes = [...new Set(itemCodes)].filter(Boolean)
	const previous = refreshes.get(key) || Promise.resolve()
	const current = previous.catch(() => {}).then(async () => {
		const cached = await readPromotionCatalog(user, profile)
		const date = cached?.configuration?.timeZone
			? new Intl.DateTimeFormat("sv-SE", { timeZone: cached.configuration.timeZone }).format(new Date())
			: null
		if (missingOnly && cached && date === cached.configuration.siteDate &&
			codes.every(code => Object.prototype.hasOwnProperty.call(cached.catalog, code))) return cached

		const configuration = await call(`${methods}.get_profile_promotions`, { pos_profile: profile })
		// Item proofs are signed independently of the rules, but both must match siteDate.
		const sameDay = cached?.configuration?.siteDate === configuration.siteDate
		const catalog = Object.assign(Object.create(null), sameDay ? cached.catalog : null)
		const requested = missingOnly ? codes.filter(code => !Object.prototype.hasOwnProperty.call(catalog, code)) : codes
		for (let offset = 0; offset < requested.length; offset += 200) {
			const batch = requested.slice(offset, offset + 200)
			const facts = await call(`${methods}.get_promotion_item_facts`, {
				pos_profile: profile,
				item_codes: JSON.stringify(batch),
				configuration: JSON.stringify(configuration),
			})
			// A refreshed item omitted by the server no longer has an eligible price.
			for (const code of batch) delete catalog[code]
			Object.assign(catalog, facts)
		}
		const value = { configuration, catalog: { ...catalog } }
		await db.settings.put({ key, value })
		return value
	})
	refreshes.set(key, current)
	const forget = () => { if (refreshes.get(key) === current) refreshes.delete(key) }
	current.then(forget, forget)
	return current
}

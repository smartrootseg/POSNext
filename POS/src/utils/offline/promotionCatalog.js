import { call } from "@/utils/apiWrapper"
import { db } from "./db"

const methods = "avenue88_custom.api.pos_promotions"

function cacheKey(user, profile) {
	if (!user || !profile) throw new Error("A signed-in user and POS profile are required.")
	return JSON.stringify(["avenue88-promotions", user, profile])
}

export async function readPromotionCatalog(user, profile) {
	return (await db.settings.get(cacheKey(user, profile)))?.value ?? null
}

/** Replace the cached rules and item facts together, after all catalog batches finish. */
export async function refreshPromotionCatalog(user, profile, itemCodes) {
	const configuration = await call(`${methods}.get_profile_promotions`, { pos_profile: profile })
	const catalog = Object.create(null)
	const codes = [...new Set(itemCodes)]
	for (let offset = 0; offset < codes.length; offset += 200) {
		const facts = await call(`${methods}.get_promotion_item_facts`, {
			pos_profile: profile,
			item_codes: JSON.stringify(codes.slice(offset, offset + 200)),
		})
		Object.assign(catalog, facts)
	}
	const value = { configuration, catalog: { ...catalog } }
	await db.settings.put({ key: cacheKey(user, profile), value })
	return value
}

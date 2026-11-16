import { call } from "@/utils/apiWrapper"
import { db } from "./db"

const maxAgeMs = 24 * 60 * 60 * 1000
const keyFor = (user, profile) => JSON.stringify(["offline-return-invoices", user, profile])

function usable(entries) {
	return entries.filter(entry => Date.now() - entry.cachedAt < maxAgeMs)
}

export async function readReturnInvoices(user, profile) {
	if (!user || !profile) return []
	const row = await db.settings.get(keyFor(user, profile))
	return usable(row?.value || []).map(entry => entry.invoice)
}

function toSnapshot(invoice) {
	return {
		name: invoice.name,
		docstatus: invoice.docstatus,
		is_return: invoice.is_return,
		status: invoice.status,
		customer: invoice.customer,
		customer_name: invoice.customer_name,
		company: invoice.company,
		posting_date: invoice.posting_date,
		grand_total: invoice.grand_total,
		paid_amount: invoice.paid_amount,
		outstanding_amount: invoice.outstanding_amount,
		custom_avenue88_promotion_groups: invoice.custom_avenue88_promotion_groups,
		items: invoice.items.map(item => ({
			name: item.name,
			item_code: item.item_code,
			item_name: item.item_name,
			qty: item.qty,
			original_qty: item.original_qty,
			already_returned: item.already_returned,
			rate: item.rate,
			warehouse: item.warehouse,
			uom: item.uom,
			conversion_factor: item.conversion_factor,
		})),
		payments: (invoice.payments || []).map(payment => ({
			mode_of_payment: payment.mode_of_payment,
			amount: payment.amount,
		})),
	}
}

const refreshes = new Map()

export function refreshReturnInvoices(user, profile) {
	if (!user || !profile) return
	const key = keyFor(user, profile)
	if (refreshes.has(key)) return refreshes.get(key)
	const startedAt = Date.now()
	const refresh = (async () => {
		const invoices = await call("pos_next.api.invoices.get_offline_return_invoices", { pos_profile: profile })
		const cachedAt = Date.now()
		await db.transaction("rw", db.settings, db.invoice_queue, async () => {
			const queued = await db.invoice_queue.filter(entry => entry.data?.is_return).toArray()
			// Ignore returns posted or queued after the snapshot request started.
			const unavailable = new Set(queued.filter(entry => !entry.synced ||
				entry.timestamp >= startedAt).map(entry => entry.data.return_against))
			const entries = invoices.filter(invoice => invoice.pos_profile === profile &&
				invoice.docstatus === 1 && !invoice.is_return && invoice.items.length &&
				!unavailable.has(invoice.name))
				.map(invoice => ({ cachedAt, invoice: toSnapshot(invoice) }))
			await db.settings.put({ key, value: entries })
		})
	})()
	refreshes.set(key, refresh)
	const clear = () => refreshes.delete(key)
	refresh.then(clear, clear)
	return refresh
}

export async function cacheReturnInvoice(user, profile, invoice) {
	if (!user || !profile || invoice.pos_profile !== profile || invoice.docstatus !== 1 || invoice.is_return) return
	const cacheKey = keyFor(user, profile)
	const snapshot = toSnapshot(invoice)
	await db.transaction("rw", db.settings, async () => {
		const row = await db.settings.get(cacheKey)
		const entries = usable(row?.value || []).filter(entry => entry.invoice.name !== invoice.name)
		if (snapshot.items.length) entries.unshift({ cachedAt: Date.now(), invoice: snapshot })
		await db.settings.put({ key: cacheKey, value: entries.slice(0, 50) })
	})
}

export async function invalidateReturnInvoice(user, profile, name) {
	if (!user || !profile) return
	const key = keyFor(user, profile)
	await db.transaction("rw", db.settings, async () => {
		const row = await db.settings.get(key)
		if (row) {
			await db.settings.put({ key, value: usable(row.value).filter(entry => entry.invoice.name !== name) })
		}
	})
}

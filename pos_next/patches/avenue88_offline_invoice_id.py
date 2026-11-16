import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


def execute():
    if "avenue88_custom" not in frappe.get_installed_apps():
        return

    create_custom_fields({
        "Sales Invoice": [{
            "fieldname": "custom_avenue88_offline_invoice_uuid",
            "label": "Avenue88 Offline Invoice ID",
            "fieldtype": "Data",
            "hidden": 1,
            "read_only": 1,
            "no_copy": 1,
            "unique": 1,
        }],
    })

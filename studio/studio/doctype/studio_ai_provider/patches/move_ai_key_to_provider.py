"""Move the shared OpenRouter key from Studio Settings onto the OpenRouter
provider row, and remove the settings field's stored value.

Keys live on providers now: one key per provider beats one global key the
moment a second provider appears, and every read of the old field is gone.
The password is read straight from __Auth because the field is already
removed from the DocType by the time patches run.
"""

import frappe
from frappe.utils.password import get_decrypted_password, remove_encrypted_password


def execute():
	key = get_decrypted_password("Studio Settings", "Studio Settings", "ai_api_key", raise_exception=False)
	if key and frappe.db.exists("Studio AI Provider", "OpenRouter"):
		provider = frappe.get_doc("Studio AI Provider", "OpenRouter")
		# A key set on the provider itself wins — don't overwrite it with the shared one.
		if not provider.resolved_key():
			provider.api_key = key
			provider.save(ignore_permissions=True)
	remove_encrypted_password("Studio Settings", "Studio Settings", "ai_api_key")

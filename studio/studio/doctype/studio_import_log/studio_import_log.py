# Copyright (c) 2026, Frappe Technologies Pvt Ltd and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class StudioImportLog(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		components_imported: DF.Int
		error: DF.LongText | None
		frappe_app: DF.Data | None
		pages_imported: DF.Int
		status: DF.Literal["Pending", "Running", "Complete", "Failed"]
		studio_app: DF.Link | None
		warnings: DF.LongText | None
	# end: auto-generated types

	def mark_running(self):
		self.status = "Running"
		self.save(ignore_permissions=True)

	def mark_complete(self, pages: int, components: int, warnings: list):
		self.status = "Complete"
		self.pages_imported = pages
		self.components_imported = components
		self.warnings = frappe.as_json(warnings, indent=None) if warnings else None
		self.save(ignore_permissions=True)

	def mark_failed(self, error: str):
		self.status = "Failed"
		self.error = error
		self.save(ignore_permissions=True)

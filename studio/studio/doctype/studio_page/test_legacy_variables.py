from unittest.mock import patch

import frappe
from frappe.tests import UnitTestCase

from studio.studio.doctype.studio_page.studio_page import get_legacy_variable_migration


class TestLegacyVariableMigration(UnitTestCase):
	def get_migration(self, is_standard, variables, permitted=True):
		page = frappe._dict(name="legacy-page", is_standard=is_standard)
		with (
			patch("frappe.get_doc", return_value=page),
			patch("frappe.has_permission", return_value=permitted),
			patch("frappe.get_all", return_value=variables) as get_all,
		):
			result = get_legacy_variable_migration(page.name)
			get_all.assert_called_once_with(
				"Studio Page Variable",
				filters={"parent": page.name, "parenttype": "Studio Page"},
				fields=["variable_name", "variable_type", "initial_value"],
				order_by="idx asc",
			)
			return result

	def test_custom_page_gets_declarations_without_return(self):
		variable = frappe._dict(variable_name="counter", variable_type="Number", initial_value="7")
		self.assertEqual(
			self.get_migration(False, [variable]),
			{"code": "const counter = ref(7)", "variable_names": ["counter"]},
		)

	def test_exported_page_gets_setup_return(self):
		variable = frappe._dict(variable_name="counter", variable_type="Number", initial_value="7")
		self.assertEqual(
			self.get_migration(True, [variable])["code"],
			"const counter = ref(7)\n\nreturn { counter }",
		)

	def test_no_legacy_variables(self):
		self.assertIsNone(self.get_migration(False, []))

	def test_custom_page_requires_read_permission(self):
		with self.assertRaises(frappe.PermissionError):
			self.get_migration(False, [], permitted=False)

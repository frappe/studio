from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import frappe
from frappe.tests import UnitTestCase

from studio.ai.agent.artifact import _available_data_note


class TestPageGeneratorState(UnitTestCase):
	def test_custom_page_without_resources_includes_script_state(self):
		page = frappe._dict(resources=[], script="const showDialog = ref(false)", is_standard=0)
		with patch("frappe.get_doc", return_value=page):
			note = _available_data_note(frappe._dict(page_id="test-page"))
		self.assertIn(page.script, note)
		self.assertIn("Do not invent state names", note)

	def test_exported_page_reads_current_file(self):
		with TemporaryDirectory() as folder:
			script = "export default function setup() { return { title: 'Current title' } }"
			Path(folder, "test_page.ts").write_text(script)
			page = frappe._dict(
				resources=[],
				script="stale DB script",
				is_standard=1,
				get_folder_path=lambda: folder,
				get_export_docname=lambda: "test_page",
			)
			with patch("frappe.get_doc", return_value=page):
				note = _available_data_note(frappe._dict(page_id="test-page"))
		self.assertIn(script, note)
		self.assertNotIn("stale DB script", note)

	def test_empty_page_has_no_data_note(self):
		page = frappe._dict(resources=[], script="", is_standard=0)
		with patch("frappe.get_doc", return_value=page):
			self.assertEqual(_available_data_note(frappe._dict(page_id="test-page")), "")

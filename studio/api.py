import os
import re
from typing import Literal

import frappe
from frappe import _
from frappe.model import display_fieldtypes, no_value_fields, table_fields

from studio.constants import STANDARD_COMPONENT_NAMES
import studio.importer as importer


@frappe.whitelist()
def get_docname(doctype: str, filters: dict | str) -> dict:
	if isinstance(filters, str):
		filters = frappe.parse_json(filters)

	# remove name filter if it is dynamic or empty - for fetching a document while testing
	if "name" in filters and (filters["name"].startswith(":") or not filters["name"]):
		del filters["name"]

	document = frappe.get_list(doctype, filters=filters, pluck="name", limit=1)
	return document[0] if document else None

	return None


@frappe.whitelist()
def get_doctype_fields(doctype: str) -> list[dict]:
	fields = frappe.get_meta(doctype).fields
	# find the name field
	name_field = next((field for field in fields if field.fieldname == "name"), None)
	if not name_field:
		name_field = frappe._dict(
			{
				"fieldname": "name",
				"fieldtype": "Data",
				"label": "ID",
			}
		)
		fields.append(name_field)

	return [
		field
		for field in fields
		if field.fieldtype not in ((set(no_value_fields) | set(display_fieldtypes)) - set(table_fields))
	]


@frappe.whitelist()
def get_whitelisted_methods(doctype: str) -> list[str]:
	from frappe import is_whitelisted
	from frappe.model.base_document import get_controller

	controller = get_controller(doctype)
	whitelisted_methods = []

	for method in controller.__dict__:
		if callable(getattr(controller, method)):
			try:
				is_whitelisted(getattr(controller, method))
				whitelisted_methods.append(method)
			except Exception:
				# not whitelisted
				continue

	return whitelisted_methods


@frappe.whitelist()
def get_sort_fields(doctype: str):
	fields = frappe.get_meta(doctype).fields
	fields = [field for field in fields if field.fieldtype not in no_value_fields]
	fields = [
		{
			"label": _(field.label),
			"value": field.fieldname,
			"fieldname": field.fieldname,
		}
		for field in fields
		if field.label and field.fieldname
	]

	standard_fields = [
		{"label": "Created On", "fieldname": "creation"},
		{"label": "Last Modified", "fieldname": "modified"},
		{"label": "Modified By", "fieldname": "modified_by"},
		{"label": "Owner", "fieldname": "owner"},
	]

	for field in standard_fields:
		field["label"] = _(field["label"])
		field["value"] = field["fieldname"]
		fields.append(field)

	return fields


@frappe.whitelist()
def check_app_permission() -> bool:
	if frappe.session.user == "Administrator":
		return True
	if frappe.has_permission("Studio App", ptype="write") and frappe.has_permission(
		"Studio Page", ptype="write"
	):
		return True
	return False


@frappe.whitelist()
def get_importable_apps() -> list[dict]:
	"""Return installed frappe apps that have a detectable Vue frontend."""
	return importer.get_importable_apps()


@frappe.whitelist()
def preview_import(frappe_app: str) -> dict:
	"""Run the Vue parser and return the manifest without writing to the DB."""
	return importer.preview_import(frappe_app)


@frappe.whitelist()
def start_import(frappe_app: str, selected_pages: list | str | None = None, selected_components: list | str | None = None) -> str:
	"""Trigger a full import and return the Studio Import Log name."""
	if isinstance(selected_pages, str):
		selected_pages = frappe.parse_json(selected_pages)
	if isinstance(selected_components, str):
		selected_components = frappe.parse_json(selected_components)
	return importer.import_app(frappe_app, selected_pages, selected_components)


@frappe.whitelist()
def get_custom_vue_components(frappe_app: str) -> list[dict]:
	"""Discover custom Vue SFC components"""
	components = []
	seen_names = set()

	studio_folder = frappe.get_app_source_path(frappe_app, "studio")
	if not os.path.exists(studio_folder):
		return []

	def has_reserved_name(name: str) -> bool:
		if name in STANDARD_COMPONENT_NAMES:
			frappe.log_error(
				title="Studio: Custom component name conflict",
				message=f"Custom component '{component_name}' in {frappe_app}/{studio_app} "
				f"conflicts with a standard component. Skipping.",
			)
			return True
		return False

	def has_conflicting_name(name: str) -> bool:
		if name in seen_names:
			frappe.log_error(
				title="Studio: Duplicate custom component",
				message=f"Custom component '{component_name}' in {frappe_app}/{studio_app} "
				f"conflicts with another component. Skipping.",
			)
			return True
		return False

	for studio_app in os.listdir(studio_folder):
		studio_app_dir = os.path.join(studio_folder, studio_app)
		if not os.path.isdir(studio_app_dir):
			continue

		for dirpath, _dirnames, filenames in os.walk(studio_app_dir):
			for filename in sorted(filenames):
				if not filename.endswith(".vue"):
					continue

				component_name = filename[:-4]  # remove .vue
				if has_reserved_name(component_name) or has_conflicting_name(component_name):
					continue

				seen_names.add(component_name)
				file_path = os.path.join(dirpath, filename)

				components.append(
					{
						"component_name": component_name,
						"studio_app": studio_app,
						"file_path": file_path,
					}
				)

	return components

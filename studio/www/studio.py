import json
import os

import frappe
from frappe.utils import cint

no_cache = 1


def get_context(context):
	csrf_token = frappe.sessions.get_csrf_token()
	frappe.db.commit()
	context.csrf_token = csrf_token
	context.site_url = get_site_url()
	context.site_name = frappe.local.site
	context.is_developer_mode = cint(frappe.conf.developer_mode)
	context.studio_editor_import_map = json.dumps({"imports": get_editor_runtime_imports()})


@frappe.whitelist(methods=["POST"], allow_guest=True)
def get_context_for_dev():
	if not frappe.conf.developer_mode:
		frappe.throw(frappe._("This method is only meant for developer mode"))
	return frappe._dict(
		{
			"site_url": get_site_url(),
			"site_name": frappe.local.site,
			"is_developer_mode": cint(frappe.conf.developer_mode),
		}
	)


def get_site_url() -> str:
	return frappe.utils.get_site_url(frappe.local.site)


def get_editor_runtime_imports() -> dict[str, str]:
	frontend_path = frappe.get_app_path("studio", "public", "frontend")
	manifest_path = os.path.join(frontend_path, ".vite", "manifest.json")
	entries_path = os.path.join(frontend_path, "editor-runtime.json")
	if not os.path.exists(manifest_path) or not os.path.exists(entries_path):
		return {}

	with open(manifest_path) as manifest_file:
		manifest = json.load(manifest_file)
	with open(entries_path) as entries_file:
		runtime_sources = json.load(entries_file)
	return {
		specifier: f"/assets/studio/frontend/{manifest[source]['file']}"
		for specifier, source in runtime_sources.items()
		if source in manifest
	}

# Copyright (c) 2026, Frappe Technologies Pvt Ltd and contributors
# For license information, please see license.txt

import json
import os
import subprocess
import traceback

import frappe


ROUTER_CANDIDATES = [
	os.path.join("frontend", "src", "router.js"),
	os.path.join("frontend", "src", "router", "index.js"),
	os.path.join("frontend", "src", "router", "index.ts"),
	os.path.join("frontend", "src", "router.ts"),
]


def get_importable_apps() -> list[dict]:
	"""List installed frappe apps that have a detectable Vue frontend."""
	result = []
	for app in frappe.get_installed_apps():
		if app in ("frappe", "studio"):
			continue
		app_root = frappe.get_app_source_path(app)
		router_path = _find_router_file(app_root)
		if router_path:
			result.append({"app": app, "router_file": router_path})
	return result


def preview_import(frappe_app: str) -> dict:
	"""Run the parser and return the manifest without writing anything to the DB."""
	return _run_parser(frappe_app)


def import_app(frappe_app: str, selected_pages: list | None = None, selected_components: list | None = None) -> str:
	"""Run the full import. Creates Studio records and returns the import log name."""
	log = frappe.get_doc({"doctype": "Studio Import Log", "frappe_app": frappe_app})
	log.insert(ignore_permissions=True)
	log.mark_running()

	try:
		manifest = _run_parser(frappe_app)
		studio_app_name = _upsert_studio_app(frappe_app, manifest)
		log.studio_app = studio_app_name

		pages = _filter(manifest.get("pages", []), selected_pages, key="page_name")
		components = _filter(manifest.get("components", []), selected_components, key="component_id")

		n_components = _write_components(studio_app_name, components)
		frappe.db.commit()

		n_pages = _write_pages(studio_app_name, pages)
		frappe.db.commit()

		log.mark_complete(n_pages, n_components, manifest.get("warnings", []))
		frappe.db.commit()
	except Exception:
		frappe.db.rollback()
		log.mark_failed(traceback.format_exc())
		frappe.db.commit()

	return log.name


def _find_router_file(app_root: str) -> str | None:
	for candidate in ROUTER_CANDIDATES:
		path = os.path.join(app_root, candidate)
		if os.path.isfile(path):
			return path
	return None


def _run_parser(frappe_app: str) -> dict:
	"""Invoke the Node.js parser and return the parsed manifest."""
	# frappe.get_app_source_path normalises path segments (hyphens → underscores),
	# so build the tool path from the Python package path instead.
	studio_pkg = frappe.get_app_path("studio")          # …/apps/studio/studio
	app_root = os.path.dirname(studio_pkg)              # …/apps/studio
	tool_dir = os.path.join(app_root, "tools", "vue-importer")
	tool_entry = os.path.join(tool_dir, "index.js")
	app_src = frappe.get_app_source_path(frappe_app, "frontend", "src")

	_ensure_tool_installed(tool_dir)

	result = subprocess.run(
		["node", tool_entry, "--app-name", frappe_app, "--app-path", app_src],
		capture_output=True,
		text=True,
		timeout=120,
	)

	if result.returncode != 0:
		frappe.throw(f"Vue parser failed for '{frappe_app}':\n{result.stderr}")

	return json.loads(result.stdout)


def _ensure_tool_installed(tool_dir: str):
	modules_dir = os.path.join(tool_dir, "node_modules")
	if not os.path.isdir(modules_dir):
		subprocess.run(["npm", "install", "--prefix", tool_dir], check=True, capture_output=True)


def _upsert_studio_app(frappe_app: str, manifest: dict) -> str:
	app_name = manifest.get("app", frappe_app)
	app_title = manifest.get("app_title", app_name.title())
	base_route = manifest.get("base_route", f"/{app_name}")

	existing = frappe.db.get_value("Studio App", {"frappe_app": frappe_app}, "name")
	if existing:
		return existing

	doc = frappe.get_doc({
		"doctype": "Studio App",
		"app_name": app_name,
		"app_title": app_title,
		"route": base_route,
		"frappe_app": frappe_app,
	})
	doc.insert(ignore_permissions=True)
	return doc.name


def _write_components(studio_app: str, components: list) -> int:
	count = 0
	for comp in components:
		existing = frappe.db.get_value("Studio Component", {"component_id": comp["component_id"]}, "name")
		if existing:
			doc = frappe.get_doc("Studio Component", existing)
		else:
			doc = frappe.get_doc({"doctype": "Studio Component"})

		doc.update({
			"component_name": comp["component_name"],
			"component_id": comp["component_id"],
			"block": frappe.as_json(comp.get("block", {}), indent=None),
			"inputs": _build_input_rows(comp.get("inputs", [])),
		})

		if existing:
			doc.save(ignore_permissions=True)
		else:
			doc.insert(ignore_permissions=True)
		count += 1

	return count


def _write_pages(studio_app: str, pages: list) -> int:
	count = 0
	for page in pages:
		route = page.get("route", "")
		if not route.startswith("/"):
			route = f"/{route}"
		existing = frappe.db.get_value(
			"Studio Page", {"route": route, "studio_app": studio_app}, "name"
		)
		if existing:
			doc = frappe.get_doc("Studio Page", existing)
		else:
			doc = frappe.get_doc({"doctype": "Studio Page"})

		doc.update({
			"page_name": page["page_name"],
			"page_title": page["page_title"],
			"studio_app": studio_app,
			"route": page.get("route", ""),
			"draft_blocks": frappe.as_json(page.get("draft_blocks", []), indent=None),
			"resources": _build_resource_rows(page.get("resources", [])),
			"variables": _build_variable_rows(page.get("variables", [])),
			"watchers": _build_watcher_rows(page.get("watchers", [])),
		})
		doc._skip_validate = True

		if existing:
			doc.save(ignore_permissions=True)
		else:
			doc.insert(ignore_permissions=True)
		count += 1

	return count


def _build_input_rows(inputs: list) -> list:
	return [
		{
			"input_name": i.get("input_name", ""),
			"type": i.get("type", "String"),
			"required": i.get("required", 0),
			"default": i.get("default", ""),
			"description": i.get("description", ""),
		}
		for i in inputs
	]


def _build_resource_rows(resources: list) -> list:
	return [
		{
			"resource_name": r.get("resource_name", ""),
			"resource_type": r.get("resource_type", "API Resource"),
			"url": r.get("url", ""),
			"document_type": r.get("document_type", ""),
			"document_name": r.get("document_name", ""),
			"fields": frappe.as_json(r.get("fields", []), indent=None) if r.get("fields") else None,
			"filters": frappe.as_json(r.get("filters", []), indent=None) if r.get("filters") else None,
			"auto": r.get("auto", 1),
		}
		for r in resources
	]


def _build_variable_rows(variables: list) -> list:
	rows = []
	for v in variables:
		vtype = v.get("variable_type", "String")
		initial = v.get("initial_value", "") or ""

		# Studio calls JSON.parse(initial_value) for String and Object types,
		# so the stored value must be valid JSON.
		if vtype == "String":
			initial = json.dumps(initial)  # "list" → '"list"', "" → '""'
		elif vtype == "Object":
			initial = initial if _is_valid_json(initial) else "null"

		rows.append({
			"variable_name": v.get("variable_name", ""),
			"variable_type": vtype,
			"initial_value": initial,
		})
	return rows


def _is_valid_json(s: str) -> bool:
	if not s:
		return False
	try:
		json.loads(s)
		return True
	except (json.JSONDecodeError, TypeError):
		return False


def _build_watcher_rows(watchers: list) -> list:
	return [
		{
			"source": w.get("source", ""),
			"script": w.get("script", ""),
			"immediate": w.get("immediate", 0),
			"deep": w.get("deep", 0),
		}
		for w in watchers
	]


def _filter(items: list, selected: list | None, key: str) -> list:
	if selected is None:
		return items
	selected_set = set(selected)
	return [item for item in items if item.get(key) in selected_set]

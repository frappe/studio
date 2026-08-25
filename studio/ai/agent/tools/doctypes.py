"""DocType schema tools — PROPOSE creating or amending the app's DocTypes.

Reading the data model lives in introspect.py (list_doctypes, get_doctype_fields).
Here the agent proposes schema changes: both tools validate the definition
(doctype_schema.py), then hand the user an Approve/Skip card with the definition
as a diff via the confirm gate (agent/approvals.py) and END the turn. An invalid
proposal returns a FAILED string instead, so the model fixes it in-turn.

Registered for custom pages always (custom=1 DocTypes) and for standard pages
on a developer bench (DocTypes in the app's own modules, exported as files).
"""

import frappe

from studio.ai.agent import approvals, backend_files, doctype_schema
from studio.ai.agent.registry import Tool
from studio.ai.agent.tools.page import load_page, text_arg


def run_create_doctype(ctx, args: dict) -> str | None:
	page = load_page(ctx)
	if page is None:
		return "FAILED: no page in context."
	if reason := doctype_schema.schema_denial(page.is_standard):
		return f"FAILED: {reason}."
	name = text_arg(args.get("name"))
	if error := doctype_schema.name_error(name):
		return f"FAILED: {error}"
	if frappe.db.exists("DocType", name):
		return (
			f"FAILED: DocType '{name}' already exists — read it with get_doctype_fields "
			"and amend it with update_doctype if it belongs to this app."
		)
	module, error = doctype_schema.create_module(page, text_arg(args.get("module")) or None)
	if error:
		return f"FAILED: {error}"

	fields, error, warnings = doctype_schema.validate_fields(args.get("fields"))
	if error:
		return f"FAILED: {error}"
	fieldnames = {f["fieldname"] for f in fields}
	istable = 1 if args.get("is_child_table") else 0
	autoname = text_arg(args.get("autoname"))
	title_field = text_arg(args.get("title_field"))
	roles = args.get("roles") or []
	for check in (
		doctype_schema.autoname_error(autoname, fieldnames),
		doctype_schema.title_field_error(title_field, fieldnames),
		doctype_schema.roles_error(roles),
	):
		if check:
			return f"FAILED: {check}"
	warnings += doctype_schema.definition_warnings(fields, istable=istable, roles=roles)

	definition = doctype_schema.definition_dict(
		name,
		module,
		fields,
		custom=0 if page.is_standard else 1,
		istable=istable,
		autoname=autoname,
		title_field=title_field,
		roles=roles,
	)
	approvals.request_confirmation(
		ctx,
		"create_doctype",
		f"Create DocType `{name}` — {len(fields)} fields{', child table' if istable else ''}. "
		"Approve to create it.",
		payload={
			"name": name,
			"module": module,
			"is_standard": 1 if page.is_standard else 0,
			"frappe_app": page.frappe_app if page.is_standard else None,
			"istable": istable,
			"autoname": autoname,
			"title_field": title_field,
			"roles": roles,
			"fields": fields,
		},
		card={
			"title": f"DocType: {name}",
			"action": "create",
			"diff": backend_files.unified_diff("", doctype_schema.definition_text(definition), name),
			"warnings": warnings,
		},
	)


def run_update_doctype(ctx, args: dict) -> str | None:
	page = load_page(ctx)
	if page is None:
		return "FAILED: no page in context."
	if reason := doctype_schema.schema_denial(page.is_standard):
		return f"FAILED: {reason}."
	doctype = text_arg(args.get("doctype"))
	if not doctype:
		return "FAILED: doctype is required."
	if error := doctype_schema.update_error(doctype, page.is_standard, page.frappe_app):
		return f"FAILED: {error}"

	add_fields, update_fields, error = _validated_changes(args)
	if error:
		return f"FAILED: {error}"

	current = doctype_schema.current_definition(doctype)
	projected, error = doctype_schema.project_update(current, add_fields, update_fields)
	if error:
		return f"FAILED: {error}"
	current_text = doctype_schema.definition_text(current)
	expected_text = doctype_schema.definition_text(projected)
	if current_text == expected_text:
		return "FAILED: this proposal changes nothing — the DocType already matches it."

	warnings = [
		f"'{f['fieldname']}' is required with no default — existing records will fail validation "
		"on their next save until it's filled"
		for f in add_fields
		if f.get("reqd") and not f.get("default")
	]
	approvals.request_confirmation(
		ctx,
		"update_doctype",
		f"Update DocType `{doctype}` — {_change_summary(add_fields, update_fields)}. Approve to apply.",
		payload={
			"doctype": doctype,
			"is_standard": 1 if page.is_standard else 0,
			"frappe_app": page.frappe_app if page.is_standard else None,
			"add_fields": add_fields,
			"update_fields": update_fields,
			"prior_hash": backend_files.file_hash(current_text),
			"expected_text": expected_text,
		},
		card={
			"title": f"DocType: {doctype}",
			"action": "modify",
			"diff": backend_files.unified_diff(current_text, expected_text, doctype),
			"warnings": warnings,
		},
	)


# --- helpers --------------------------------------------------------------


def _validated_changes(args: dict) -> tuple[list[dict], list[dict], str | None]:
	add_fields, update_fields = [], []
	if raw := args.get("add_fields"):
		add_fields, error, _ = doctype_schema.validate_fields(raw)
		if error:
			return [], [], f"add_fields: {error}"
	if raw := args.get("update_fields"):
		update_fields, error, _ = doctype_schema.validate_fields(raw, require_fieldtype=False)
		if error:
			return [], [], f"update_fields: {error}"
	if not add_fields and not update_fields:
		return [], [], "pass add_fields and/or update_fields."
	return add_fields, update_fields, None


def _change_summary(add_fields: list[dict], update_fields: list[dict]) -> str:
	parts = []
	if add_fields:
		parts.append(f"add {', '.join(f['fieldname'] for f in add_fields)}")
	if update_fields:
		parts.append(f"modify {', '.join(f['fieldname'] for f in update_fields)}")
	return "; ".join(parts)


# --- tool definitions -----------------------------------------------------

_FIELD_SCHEMA = {
	"type": "object",
	"properties": {
		"fieldname": {"type": "string", "description": "snake_case identifier, e.g. 'due_date'."},
		"fieldtype": {
			"type": "string",
			"description": (
				"A Frappe fieldtype: Data, Small Text, Text, Text Editor, Int, Float, Currency, "
				"Percent, Check, Date, Datetime, Time, Duration, Select, Link, Dynamic Link, Table, "
				"Table MultiSelect, Attach, Attach Image, Color, Rating, JSON, Section Break, Column Break…"
			),
		},
		"label": {"type": "string", "description": "Defaults to the titleized fieldname."},
		"options": {
			"type": "string",
			"description": (
				"Select → newline-separated choices. Link/Table/Table MultiSelect → the target DocType name."
			),
		},
		"reqd": {"type": "boolean"},
		"default": {"type": "string"},
		"read_only": {"type": "boolean"},
		"hidden": {"type": "boolean"},
		"unique": {"type": "boolean"},
		"in_list_view": {"type": "boolean", "description": "Show as a column in list/child-table views."},
		"in_standard_filter": {"type": "boolean"},
		"description": {"type": "string"},
		"depends_on": {
			"type": "string",
			"description": "Display condition, e.g. 'eval:doc.status==\"Open\"'.",
		},
		"fetch_from": {"type": "string", "description": "e.g. 'customer.customer_name' (via a Link field)."},
	},
	"required": ["fieldname", "fieldtype"],
}

create_doctype = Tool(
	name="create_doctype",
	side="terminal",
	handler=run_create_doctype,
	description=(
		"PROPOSE a new DocType (document model + DB table) for the app. Nothing is created yet: the "
		"user sees the definition as a diff and must Approve; a valid proposal ENDS your turn and you "
		"resume once they decide — so propose the schema BEFORE data sources, backend code or layout "
		"that assume its fields exist, and build those in the resumed turn. First check it doesn't "
		"already exist (list_doctypes). A Table/Table MultiSelect field needs its child DocType "
		"created first (is_child_table). If the user skips, do not re-propose the same change."
	),
	parameters={
		"type": "object",
		"properties": {
			"name": {"type": "string", "description": "Title Case name, e.g. 'Gym Member'."},
			"fields": {"type": "array", "items": _FIELD_SCHEMA},
			"is_child_table": {
				"type": "boolean",
				"description": "Child table rows for a parent's Table field (no permissions of its own).",
			},
			"module": {
				"type": "string",
				"description": "Standard apps only: one of the app's modules; defaults to its main module.",
			},
			"autoname": {
				"type": "string",
				"description": "'field:<fieldname>', 'format:PRE-{####}', 'hash', 'autoincrement' or "
				"'prompt'. Omit for the default (hash).",
			},
			"title_field": {
				"type": "string",
				"description": "Field shown as the record's display title (e.g. 'title', 'full_name').",
			},
			"roles": {
				"type": "array",
				"items": {"type": "string"},
				"description": "Existing roles granted full CRUD besides System Manager — grant the "
				"role(s) the app's users hold, or pages will render no data for them.",
			},
		},
		"required": ["name", "fields"],
	},
)

update_doctype = Tool(
	name="update_doctype",
	side="terminal",
	handler=run_update_doctype,
	description=(
		"PROPOSE amending a DocType the app owns: add_fields appends new fields; update_fields changes "
		"properties of existing ones (restate only fieldname + what changes; an explicit false unsets a "
		"checkbox property). Never invent fields on an existing DocType — read it with "
		"get_doctype_fields, then propose. The user sees the definition diff and must Approve; a valid "
		"proposal ENDS your turn (you resume after they decide), so propose schema changes BEFORE "
		"wiring anything that assumes them. Field deletion/renaming is not supported here — ask the "
		"user to do that in the DocType editor. If the user skips, do not re-propose the same change."
	),
	parameters={
		"type": "object",
		"properties": {
			"doctype": {"type": "string", "description": "The DocType to amend (must belong to this app)."},
			"add_fields": {"type": "array", "items": _FIELD_SCHEMA},
			"update_fields": {"type": "array", "items": _FIELD_SCHEMA},
		},
		"required": ["doctype"],
	},
)

TOOLS = [create_doctype, update_doctype]

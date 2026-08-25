"""DocType definitions as an agent-proposable surface.

A schema change creates/alters a DB table and (standard apps, developer mode)
exports files into the app's package — so like backend writes it is
PROPOSAL-ONLY: tools/doctypes.py validates here, raises an approval card, and
approvals.py re-validates with the same functions before applying in the
approving user's request context.

Ownership jail: a standard page only touches DocTypes in its own app's modules
(custom=0, developer mode); a custom (non-exported) page only touches custom
DocTypes (custom=1, module 'Custom'). Core/framework schemas are never
amendable from the agent.
"""

import json
import re

import frappe
from frappe.model import child_table_fields, default_fields
from frappe.utils import cint

from studio.utils import developer_file_access_denial

# DocField properties the agent may set; everything else is stripped from a proposal.
FIELD_PROPERTIES = (
	"fieldname",
	"fieldtype",
	"label",
	"options",
	"reqd",
	"default",
	"read_only",
	"hidden",
	"unique",
	"in_list_view",
	"in_standard_filter",
	"description",
	"depends_on",
	"fetch_from",
	"precision",
)
CHECK_PROPERTIES = {"reqd", "read_only", "hidden", "unique", "in_list_view", "in_standard_filter"}
DOCTYPE_OPTIONS_TYPES = {"Link", "Table", "Table MultiSelect"}
FIELDNAME_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
NAME_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9 \-]{0,60}$")
RESERVED_FIELDNAMES = set(default_fields) | set(child_table_fields) | {"doctype"}
CUSTOM_MODULE = "Custom"
MAX_FIELDS = 60


def schema_denial(is_standard: bool) -> str | None:
	"""Why the current user/bench may not change the data model, or None."""
	if is_standard:
		return developer_file_access_denial()
	if "System Manager" not in frappe.get_roles():
		return "you need the System Manager role to change the data model"
	return None


def create_module(page, module_arg: str | None) -> tuple[str | None, str | None]:
	"""(module to create the DocType in, error). Standard pages own their app's
	modules; custom pages create custom DocTypes under frappe's 'Custom' module."""
	if not page.is_standard:
		return CUSTOM_MODULE, None
	modules = frappe.get_module_list(page.frappe_app)
	if not modules:
		return None, f"app '{page.frappe_app}' has no modules."
	if module_arg and module_arg not in modules:
		return None, f"module '{module_arg}' is not one of the app's modules ({', '.join(modules)})."
	return module_arg or modules[0], None


def update_error(doctype: str, is_standard: bool, frappe_app: str | None) -> str | None:
	"""Ownership check for amending an existing DocType."""
	if not frappe.db.exists("DocType", doctype):
		return f"DocType '{doctype}' does not exist — use create_doctype."
	row = frappe.db.get_value("DocType", doctype, ["custom", "module"], as_dict=True)
	if is_standard:
		if cint(row.custom) or row.module not in frappe.get_module_list(frappe_app):
			return f"'{doctype}' does not belong to app '{frappe_app}' — only the app's own DocTypes can be amended."
	elif not cint(row.custom):
		return f"'{doctype}' is a standard DocType — only custom DocTypes can be amended here."
	return None


def name_error(name: str) -> str | None:
	if not name or not NAME_PATTERN.match(name):
		return f"invalid DocType name '{name}' — letters/numbers/spaces starting with a letter, max 61 chars."
	return None


def validate_fields(
	raw_fields, *, require_fieldtype: bool = True
) -> tuple[list[dict], str | None, list[str]]:
	"""Normalize proposed fields down to the whitelisted properties.
	Returns (fields, blocking error, warnings). With require_fieldtype=False
	(update_fields) a field may restate only the properties it changes."""
	if not isinstance(raw_fields, list) or not raw_fields:
		return [], "fields must be a non-empty list of field objects.", []
	if len(raw_fields) > MAX_FIELDS:
		return [], f"too many fields ({len(raw_fields)} > {MAX_FIELDS}).", []
	valid_types = fieldtype_options()
	seen: set[str] = set()
	fields: list[dict] = []
	for raw in raw_fields:
		if not isinstance(raw, dict):
			return [], "each field must be an object with at least a fieldname.", []
		field, error = normalize_field(raw, valid_types, require_fieldtype=require_fieldtype)
		if error:
			return [], error, []
		if field["fieldname"] in seen:
			return [], f"duplicate fieldname '{field['fieldname']}'.", []
		seen.add(field["fieldname"])
		fields.append(field)
	return fields, None, []


def autoname_error(autoname: str, fieldnames: set[str]) -> str | None:
	if not autoname:
		return None
	if autoname.startswith("field:"):
		target = autoname.removeprefix("field:")
		return None if target in fieldnames else f"autoname '{autoname}' references an unknown field."
	if autoname.startswith("format:") or autoname in ("hash", "autoincrement", "prompt", "UUID"):
		return None
	return "autoname must be 'field:<fieldname>', 'format:...', 'hash', 'autoincrement', 'prompt' or 'UUID'."


def title_field_error(title_field: str, fieldnames: set[str]) -> str | None:
	if title_field and title_field not in fieldnames:
		return f"title_field '{title_field}' is not one of the proposed fields."
	return None


def roles_error(roles) -> str | None:
	if not isinstance(roles, list) or not all(isinstance(r, str) for r in roles):
		return "roles must be a list of role names."
	missing = [r for r in roles if not frappe.db.exists("Role", r)]
	if missing:
		return f"unknown role(s): {', '.join(missing)}."
	return None


def definition_warnings(fields: list[dict], *, istable: bool, roles: list[str]) -> list[str]:
	if istable:
		if not any(f.get("in_list_view") for f in fields):
			return ["no field has in_list_view — the child-table grid will show no columns"]
		return []
	if not roles:
		return ["no roles granted — only System Manager can read or write records"]
	return []


# --- definition text (diff + drift detection) -----------------------------


def definition_dict(
	name: str,
	module: str,
	fields: list[dict],
	*,
	custom: int = 0,
	istable: int = 0,
	autoname: str | None = None,
	title_field: str | None = None,
	roles=(),
) -> dict:
	d: dict = {"name": name, "module": module}
	if custom:
		d["custom"] = 1
	if istable:
		d["istable"] = 1
	if autoname:
		d["autoname"] = autoname
	if title_field:
		d["title_field"] = title_field
	if roles:
		d["roles"] = sorted(roles)
	d["fields"] = [field_subset(f) for f in fields]
	return d


def current_definition(doctype: str) -> dict:
	doc = frappe.get_doc("DocType", doctype)
	return definition_dict(
		doc.name,
		doc.module,
		[f.as_dict() for f in doc.fields],
		custom=cint(doc.custom),
		istable=cint(doc.istable),
		autoname=doc.autoname,
		title_field=doc.title_field,
		roles={p.role for p in (doc.permissions or [])},
	)


def definition_text(definition: dict) -> str:
	return json.dumps(definition, indent=1, default=str) + "\n"


def project_update(
	current: dict, add_fields: list[dict], update_fields: list[dict]
) -> tuple[dict | None, str | None]:
	"""The definition as it would look after applying the proposal — shown as the
	diff's 'new' side and stored for the apply-time already-applied check."""
	fields = [dict(f) for f in current["fields"]]
	by_name = {f.get("fieldname"): f for f in fields if f.get("fieldname")}
	for field in add_fields:
		if existing := by_name.get(field["fieldname"]):
			merge_field(existing, field)
		else:
			fields.append(field)
	for field in update_fields:
		existing = by_name.get(field["fieldname"])
		if existing is None:
			return None, f"field '{field['fieldname']}' does not exist on this DocType — use add_fields."
		merge_field(existing, field)
	projected = dict(current)
	projected["fields"] = [field_subset(f) for f in fields]
	return projected, None


# --- helpers --------------------------------------------------------------


def normalize_field(raw: dict, valid_types: set[str], *, require_fieldtype: bool) -> tuple[dict, str | None]:
	fieldname = (raw.get("fieldname") or "").strip()
	fieldtype = (raw.get("fieldtype") or "").strip()
	if not FIELDNAME_PATTERN.match(fieldname):
		return {}, f"invalid fieldname '{fieldname}' — lowercase snake_case starting with a letter."
	if fieldname in RESERVED_FIELDNAMES:
		return {}, f"'{fieldname}' is a reserved fieldname."
	if not fieldtype and require_fieldtype:
		return {}, f"field '{fieldname}' needs a fieldtype."
	if fieldtype and fieldtype not in valid_types:
		return {}, f"unknown fieldtype '{fieldtype}' on '{fieldname}'."
	if fieldtype and (error := options_error(fieldname, fieldtype, (raw.get("options") or "").strip())):
		return {}, error

	field = {"fieldname": fieldname}
	if fieldtype:
		field["fieldtype"] = fieldtype
	if label := (raw.get("label") or "").strip() or (require_fieldtype and frappe.unscrub(fieldname)):
		field["label"] = label
	for prop in FIELD_PROPERTIES[3:]:
		value = raw.get(prop)
		if value is None or value == "":
			continue
		# Explicit false/0 survives so update_fields can UNSET a checkbox property.
		field[prop] = cint(bool(value)) if prop in CHECK_PROPERTIES else value
	return field, None


def options_error(fieldname: str, fieldtype: str, options: str) -> str | None:
	if fieldtype in DOCTYPE_OPTIONS_TYPES:
		if not options or not frappe.db.exists("DocType", options):
			return f"'{fieldname}' ({fieldtype}) needs options set to an existing DocType."
		if fieldtype != "Link" and not cint(frappe.db.get_value("DocType", options, "istable")):
			return (
				f"'{fieldname}' ({fieldtype}) must point at a child table DocType — '{options}' is not one."
			)
	if fieldtype == "Select" and not [o for o in options.split("\n") if o.strip()]:
		return f"Select field '{fieldname}' needs newline-separated options."
	return None


def field_subset(field) -> dict:
	"""The whitelisted, noise-free view of a field — 0-valued checkboxes and empty
	values dropped so proposed and persisted definitions compare/diff cleanly."""
	out = {}
	for prop in FIELD_PROPERTIES:
		value = field.get(prop)
		if prop in CHECK_PROPERTIES:
			if cint(value):
				out[prop] = 1
		elif value not in (None, "", 0):
			out[prop] = value
	return out


def merge_field(existing: dict, update: dict) -> None:
	for prop, value in update.items():
		if prop == "fieldname":
			continue
		existing[prop] = value


def fieldtype_options() -> set[str]:
	options = frappe.get_meta("DocField").get_field("fieldtype").options or ""
	return {o.strip() for o in options.split("\n") if o.strip()}


def permission_rows(roles: list[str]) -> list[dict]:
	rows = [{"role": "System Manager", "read": 1, "write": 1, "create": 1, "delete": 1}]
	rows += [
		{"role": r, "read": 1, "write": 1, "create": 1, "delete": 1} for r in roles if r != "System Manager"
	]
	return rows

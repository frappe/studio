"""Confirm-gating for sensitive agent actions.

A sensitive tool NEVER mutates directly. Its handler validates the proposal,
then calls `request_confirmation`, which persists a pending-action message and
emits a clarify event carrying the card, then ends the turn (the tool is
side="terminal"). The panel renders an Approve/Skip card — persisted, so it
survives an editor reload; on Approve the `confirm_pending_action` endpoint
(ai/api.py) loads the stored payload and runs `apply_pending_action` in the
APPROVING USER's request context. The model can only propose.

Action kinds are an explicit whitelist dispatching to ctx-free apply functions:
an unknown or forged kind can never run, and apply re-validates the stored
payload from scratch — it sat in the DB while the disk may have moved on.
"""

import frappe
from frappe import _
from frappe.utils import cint

from studio.ai.agent import backend_files, doctype_schema
from studio.ai.session import AISession
from studio.utils import ensure_developer_file_access

# Kinds the confirm card understands. Explicit so an unknown kind can never be applied.
KINDS = {"write_backend_file", "create_doctype", "update_doctype"}


def request_confirmation(ctx, kind: str, summary: str, payload: dict, card: dict) -> None:
	"""Persist + emit a pending sensitive action, then end the turn without mutating.
	`payload` is what apply needs; `card` is what the approval card shows (path, diff,
	warnings) — kept top-level in metadata so the panel reads one shape."""
	metadata = {"status": "pending_action", "kind": kind, "payload": payload, **card}
	message_id = AISession.try_append_message(
		ctx.session_id,
		"assistant",
		summary,
		message_type="clarification",
		task_type="agent",
		metadata=metadata,
	)
	# Commit BEFORE emitting: the event triggers a session reload on the client,
	# which must find this message (and its pending status) already in the DB.
	frappe.db.commit()
	ctx.emit(
		"clarify",
		question=summary,
		options=[],
		pending_action={"kind": kind, "message_id": message_id, **card},
	)


def apply_pending_action(kind: str, payload: dict) -> str:
	"""Run the real mutation for an approved action. Called ONLY from the confirm
	endpoint (user-triggered). Returns a short human summary of what happened."""
	if kind not in KINDS:
		frappe.throw(_("Unknown pending action: {0}").format(kind))
	applies = {
		"write_backend_file": apply_write_backend_file,
		"create_doctype": apply_create_doctype,
		"update_doctype": apply_update_doctype,
	}
	return applies[kind](payload or {})


def apply_write_backend_file(payload: dict) -> str:
	frappe_app = (payload.get("frappe_app") or "").strip()
	file_path = (payload.get("file_path") or "").strip("/")
	content = payload.get("content")
	if not frappe_app or not file_path or not isinstance(content, str):
		frappe.throw(_("The stored proposal is incomplete."))

	# Re-run EVERY propose-time check: gate, app ownership, jail, protected files,
	# lint — then refuse if the file drifted on disk since the card was shown.
	ensure_developer_file_access()
	if not frappe.db.exists("Studio App", {"frappe_app": frappe_app, "is_standard": 1}):
		frappe.throw(_("{0} is not an exported Studio app.").format(frappe_app))
	if reason := backend_files.app_error(frappe_app) or backend_files.writable_error(file_path):
		frappe.throw(_(reason))
	error, _warnings, whitelisted = backend_files.lint(frappe_app, file_path, content)
	if error:
		frappe.throw(_("The proposed code no longer validates: {0}").format(error))

	current = backend_files.read_current(frappe_app, file_path)
	if current != content:
		# Idempotency: current == content means a previous approve already landed the
		# file but the request died before committing (writing a .py restarts the dev
		# server, which can kill the very request that wrote it) — re-approving must
		# succeed, not trip the drift check against our own write.
		if backend_files.file_hash(current or "") != payload.get("prior_hash"):
			frappe.throw(
				_("{0} changed on disk since this was proposed. Ask the agent to re-propose.").format(
					file_path
				)
			)
		backend_files.write(frappe_app, file_path, content)
	outcome = _("Wrote {0}.").format(file_path)
	if whitelisted:
		module = backend_files.dotted_path(frappe_app, file_path)
		calls = ", ".join(f"call('{module}.{name}')" for name in whitelisted)
		outcome += _(" Pages can call: {0}.").format(calls)
	return outcome + _(
		" The change is live for web requests (the dev server reloads); background workers pick it up on restart."
	)


def apply_create_doctype(payload: dict) -> str:
	name = (payload.get("name") or "").strip()
	module = (payload.get("module") or "").strip()
	if not name or not module or not payload.get("fields"):
		frappe.throw(_("The stored proposal is incomplete."))
	frappe_app = _ensure_schema_access(payload)
	if frappe_app and module not in frappe.get_module_list(frappe_app):
		frappe.throw(_("Module {0} does not belong to app {1}.").format(module, frappe_app))

	fields, error, _warnings = doctype_schema.validate_fields(payload["fields"])
	if error:
		frappe.throw(_("The proposed schema no longer validates: {0}").format(error))

	if frappe.db.exists("DocType", name):
		# Idempotency: a previous approve may have created it but died before the
		# commit — a standard DocType exports a boilerplate controller .py, which
		# restarts the dev server mid-request. Re-approving must succeed.
		existing = {f.fieldname for f in frappe.get_meta(name).fields}
		if {f["fieldname"] for f in fields} <= existing:
			return _("DocType {0} already exists with the proposed fields — nothing to do.").format(name)
		frappe.throw(
			_("A different DocType named {0} already exists. Ask the agent to re-propose.").format(name)
		)

	istable = cint(payload.get("istable"))
	frappe.get_doc(
		{
			"doctype": "DocType",
			"name": name,
			"module": module,
			"custom": 0 if payload.get("is_standard") else 1,
			"istable": istable,
			"autoname": payload.get("autoname") or "",
			"title_field": payload.get("title_field") or "",
			"fields": fields,
			"permissions": [] if istable else doctype_schema.permission_rows(payload.get("roles") or []),
		}
	).insert()
	outcome = _("Created DocType {0} (table synced).").format(name)
	return outcome if istable else outcome + _(" Wire it into pages with a data source.")


def apply_update_doctype(payload: dict) -> str:
	doctype = (payload.get("doctype") or "").strip()
	if not doctype:
		frappe.throw(_("The stored proposal is incomplete."))
	frappe_app = _ensure_schema_access(payload)
	if error := doctype_schema.update_error(doctype, bool(payload.get("is_standard")), frappe_app):
		frappe.throw(_(error))

	if raw_add := payload.get("add_fields"):
		_fields, error, _w = doctype_schema.validate_fields(raw_add)
		if error:
			frappe.throw(_("The proposed schema no longer validates: {0}").format(error))

	current_text = doctype_schema.definition_text(doctype_schema.current_definition(doctype))
	if current_text == payload.get("expected_text"):
		# Idempotency: a previous approve landed the change but its request died
		# before committing — re-approving must succeed, not trip the drift check.
		return _("DocType {0} already matches the proposal — nothing to do.").format(doctype)
	if backend_files.file_hash(current_text) != payload.get("prior_hash"):
		frappe.throw(_("{0} changed since this was proposed. Ask the agent to re-propose.").format(doctype))

	doc = frappe.get_doc("DocType", doctype)
	for field in payload.get("add_fields") or []:
		_set_docfield(doc, field, append_missing=True)
	for field in payload.get("update_fields") or []:
		_set_docfield(doc, field, append_missing=False)
	doc.save()
	return _("Updated DocType {0}.").format(doctype)


def _ensure_schema_access(payload: dict) -> str | None:
	"""Re-run the propose-time gate + app ownership check; returns the frappe_app
	for standard proposals, None for custom ones."""
	is_standard = bool(payload.get("is_standard"))
	if reason := doctype_schema.schema_denial(is_standard):
		frappe.throw(_(reason))
	if not is_standard:
		return None
	frappe_app = (payload.get("frappe_app") or "").strip()
	if not frappe.db.exists("Studio App", {"frappe_app": frappe_app, "is_standard": 1}):
		frappe.throw(_("{0} is not an exported Studio app.").format(frappe_app))
	return frappe_app


def _set_docfield(doc, field: dict, *, append_missing: bool) -> None:
	existing = next((f for f in doc.fields if f.fieldname == field.get("fieldname")), None)
	if existing is None:
		if not append_missing:
			frappe.throw(_("Field {0} no longer exists on {1}.").format(field.get("fieldname"), doc.name))
		doc.append("fields", field)
		return
	for prop, value in field.items():
		if prop != "fieldname":
			existing.set(prop, value)

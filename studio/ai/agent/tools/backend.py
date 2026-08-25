"""Backend code tools — read the exported app's Python package, and PROPOSE writes.

Registered only on a developer-mode bench for standard apps. Reads are free (but
gated: they expose server source). A write never lands directly — write_backend_file
validates the code (syntax + path-aware lint), then hands the user an Approve/Skip
card via the confirm gate (agent/approvals.py) and ENDS the turn. Whitelisted APIs,
DocType controllers and shared helpers are all authored through this one tool; the
lint knows what each path must look like.
"""

import os

from studio.ai.agent import approvals, backend_files
from studio.ai.agent.registry import Tool
from studio.ai.agent.tools.page import load_page, text_arg
from studio.utils import developer_file_access_denial


def run_list_backend_files(ctx, args: dict) -> str:
	app = _backend_app(ctx)
	if app.startswith("FAILED"):
		return app
	paths = backend_files.list_python_files(app)
	if not paths:
		return "The app package has no source files yet."
	return (
		f"Python package of '{app}' (paths relative to the package root; [read-only] files "
		"register code implicitly and can't be written):\n" + "\n".join(paths)
	)


def run_read_backend_file(ctx, args: dict) -> str:
	app = _backend_app(ctx)
	if app.startswith("FAILED"):
		return app
	path = text_arg(args.get("file_path"))
	if not path:
		return "FAILED: file_path is required."
	if os.path.splitext(path)[1].lower() not in backend_files.READABLE_EXTENSIONS:
		return "FAILED: only .py/.txt/.json/.md files can be read here."
	try:
		content = backend_files.read_current(app, path)
	except Exception as error:
		return f"FAILED: {error}"
	if content is None:
		return f"FAILED: {path} does not exist."
	return f"{path}:\n{content}"


def run_write_backend_file(ctx, args: dict) -> str | None:
	"""Terminal when the proposal is valid: raises the approval card and ends the turn.
	An invalid proposal returns a FAILED string instead — the loop feeds it back as the
	tool result and keeps going, so the model fixes its code in the same turn."""
	app = _backend_app(ctx)
	path = text_arg(args.get("file_path")).strip("/")
	content = args.get("content")
	if refusal := _proposal_refusal(app, path, content):
		return f"FAILED: {refusal}"

	error, warnings, whitelisted = backend_files.lint(app, path, content)
	if error:
		return f"FAILED: the code doesn't validate — {error} Fix it and propose again."

	current = backend_files.read_current(app, path)
	summary = _describe(path, exists=current is not None, whitelisted=whitelisted)
	approvals.request_confirmation(
		ctx,
		"write_backend_file",
		summary,
		payload={
			"frappe_app": app,
			"file_path": path,
			"content": content,
			"prior_hash": backend_files.file_hash(current or ""),
		},
		card={
			"file_path": path,
			"action": "modify" if current is not None else "create",
			"diff": backend_files.unified_diff(current or "", content, path),
			"warnings": warnings,
		},
	)


# --- helpers --------------------------------------------------------------


def _backend_app(ctx) -> str:
	"""The exported app's frappe_app for the page in context, or a FAILED string."""
	if reason := developer_file_access_denial():
		return f"FAILED: {reason}."
	page = load_page(ctx)
	if page is None:
		return "FAILED: no page in context."
	if not page.is_standard:
		return "FAILED: this app isn't exported — it has no Python package. Use data sources and page scripts instead."
	if reason := backend_files.app_error(page.frappe_app):
		return f"FAILED: {reason}"
	return page.frappe_app


def _proposal_refusal(app: str, path: str, content) -> str | None:
	if app.startswith("FAILED"):
		return app.removeprefix("FAILED: ")
	if not path or not isinstance(content, str) or not content.strip():
		return "file_path and content (the full file text) are required."
	return backend_files.writable_error(path)


def _describe(path: str, exists: bool, whitelisted: list[str]) -> str:
	action = "Update" if exists else "Create"
	summary = f"{action} `{path}`"
	if whitelisted:
		names = ", ".join(whitelisted)
		summary += f" — whitelists {names} for pages to call"
	return summary + ". Approve to write this file to the app's Python package."


# --- tool definitions -----------------------------------------------------

list_backend_files = Tool(
	name="list_backend_files",
	side="server",
	handler=run_list_backend_files,
	description=(
		"List the exported app's Python package files (DocType controllers, api modules, hooks). "
		"Use before read_backend_file / write_backend_file to see what exists and where things go."
	),
	parameters={"type": "object", "properties": {}},
)

read_backend_file = Tool(
	name="read_backend_file",
	side="server",
	handler=run_read_backend_file,
	description=(
		"Read a file from the exported app's Python package — a DocType controller, an api module, "
		"hooks.py. ALWAYS read a file before proposing a write: write_backend_file replaces the whole file."
	),
	parameters={
		"type": "object",
		"properties": {
			"file_path": {
				"type": "string",
				"description": "Path relative to the package root, e.g. 'api.py' or '<module>/doctype/<name>/<name>.py'.",
			}
		},
		"required": ["file_path"],
	},
)

write_backend_file = Tool(
	name="write_backend_file",
	side="terminal",
	handler=run_write_backend_file,
	description=(
		"PROPOSE creating or replacing one Python file in the exported app's package — a whitelisted "
		"api module pages call via call('<app>.api.<fn>'), a DocType controller with lifecycle hooks, "
		"or a shared helper. Nothing is written yet: the user sees a diff card and must Approve, this "
		"call ENDS your turn, and you resume once they decide — so propose the file BEFORE wiring any "
		"page to its endpoints (a page calling a not-yet-approved endpoint breaks until the write "
		"lands); do the UI wiring in the resumed turn. Pass the ENTIRE file content (it replaces the "
		"file; read_backend_file first). Every endpoint needs @frappe.whitelist() and its own "
		"permission checks — never ignore_permissions. If the user skips, do not re-propose the same "
		"change."
	),
	parameters={
		"type": "object",
		"properties": {
			"file_path": {
				"type": "string",
				"description": (
					"Path relative to the package root. Endpoints → 'api.py' (or 'api/<topic>.py'); a "
					"DocType's server logic → '<module>/doctype/<name>/<name>.py'; shared helpers → a "
					"module-level file. hooks.py / patches.txt / modules.txt / __init__.py are read-only."
				),
			},
			"content": {"type": "string", "description": "The full Python source of the file."},
		},
		"required": ["file_path", "content"],
	},
)

TOOLS = [list_backend_files, read_backend_file, write_backend_file]

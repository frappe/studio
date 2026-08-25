"""The exported app's Python package as an agent-editable surface.

The package (`apps/<frappe_app>/<frappe_app>/`) is a SIBLING of the studio
frontend folder, so it gets its own jail with its own rules. Writing `.py` is
RCE-by-design; the rules are correspondingly strict:

  - developer mode + System Manager (studio.utils.developer_file_access_denial),
  - every write approved by the user before it lands (see approvals.py),
  - paths realpath-jailed to the package, `.py` only,
  - the files that REGISTER code to run implicitly are read-only: one line in
    hooks.py or patches.txt escalates far beyond the file itself.

Shared by the proposer tool (tools/backend.py) and the apply function
(approvals.py) so a proposal is validated identically at propose and apply time.
"""

import ast
import difflib
import hashlib
import os
import re

import frappe

# Manifest/bootstrap files whose edit registers code to run implicitly (every
# request, next migrate, install). __init__.py is scaffolded server-side instead.
PROTECTED_BASENAMES = {"hooks.py", "patches.txt", "modules.txt", "install.py", "__init__.py"}
READABLE_EXTENSIONS = {".py", ".txt", ".json", ".md"}
CONTROLLER_PATH = re.compile(r"(?:^|/)doctype/(?P<slug>[^/]+)/(?P=slug)\.py$")
API_MODULE_PATH = re.compile(r"(?:^|/)api(?:/[^/]+)?\.py$")


def package_root(frappe_app: str) -> str:
	"""Absolute, symlink-resolved path of the app's Python package (the jail root)."""
	return os.path.realpath(frappe.get_app_path(frappe_app))


def resolve(frappe_app: str, file_path: str) -> str:
	"""Resolve a path relative to the package root, refusing anything that escapes the jail."""
	root = package_root(frappe_app)
	target = os.path.realpath(os.path.join(root, file_path))
	if target != root and not target.startswith(root + os.sep):
		frappe.throw(frappe._("Invalid file path: {0}").format(file_path), frappe.PermissionError)
	return target


def app_error(frappe_app: str) -> str | None:
	"""The framework itself is never 'the generated app': a studio app exported into
	frappe would make the entire framework package agent-writable."""
	if frappe_app == "frappe":
		return (
			"this studio app exports into the frappe framework package — backend code "
			"can only be authored in the app's own package."
		)
	return None


def writable_error(file_path: str) -> str | None:
	normalized = file_path.strip("/")
	if os.path.splitext(normalized)[1].lower() != ".py":
		return "only .py files can be written here — frontend code belongs in the app's studio folder."
	if os.path.basename(normalized) in PROTECTED_BASENAMES:
		return f"{os.path.basename(normalized)} is read-only: it registers code to run implicitly."
	return None


def lint(frappe_app: str, file_path: str, content: str) -> tuple[str | None, list[str], list[str]]:
	"""Validate proposed Python by WHERE it lands: (blocking error, warnings for the
	approval card, whitelisted method names found). A controller path must define the
	Document class; an api module should whitelist what pages will call."""
	try:
		module = ast.parse(content)
	except SyntaxError as error:
		return f"line {error.lineno}: {error.msg}", [], []

	warnings: list[str] = []
	whitelisted, guest = scan_whitelisted(module)
	warnings.extend(
		f"@frappe.whitelist(allow_guest=True) on '{name}' — callable by logged-out visitors" for name in guest
	)

	if match := CONTROLLER_PATH.search(file_path.strip("/")):
		if error := controller_error(module, match.group("slug")):
			return error, warnings, whitelisted
		if module_dir := file_path.strip("/").split("/")[0] if "/doctype/" in file_path else None:
			if module_dir not in app_module_dirs(frappe_app):
				warnings.append(
					f"module folder '{module_dir}' isn't in the app's modules.txt (read-only) — "
					"put the DocType under an existing module"
				)
	elif API_MODULE_PATH.search(file_path.strip("/")) and not whitelisted:
		warnings.append(
			"no @frappe.whitelist() functions — pages won't be able to call anything in this file"
		)

	return None, warnings, whitelisted


def unified_diff(old: str, new: str, file_path: str) -> str:
	return "".join(
		difflib.unified_diff(
			old.splitlines(keepends=True),
			new.splitlines(keepends=True),
			fromfile=f"a/{file_path}",
			tofile=f"b/{file_path}",
		)
	)


def file_hash(content: str) -> str:
	return hashlib.sha1(content.encode("utf-8")).hexdigest()


def read_current(frappe_app: str, file_path: str) -> str | None:
	"""The file's on-disk content, or None when it doesn't exist yet."""
	target = resolve(frappe_app, file_path)
	if not os.path.isfile(target):
		return None
	with open(target, encoding="utf-8") as f:
		return f.read()


def write(frappe_app: str, file_path: str, content: str) -> None:
	"""Write the file, making every new parent folder an importable package."""
	target = resolve(frappe_app, file_path)
	ensure_package_dirs(package_root(frappe_app), os.path.dirname(file_path.strip("/")))
	with open(target, "w", encoding="utf-8") as f:
		f.write(content)


def dotted_path(frappe_app: str, file_path: str) -> str:
	"""The importable module path of a package file, e.g. booking/api.py → booking.api."""
	stem = file_path.strip("/").rsplit(".", 1)[0]
	return ".".join([frappe_app, *stem.split("/")])


def list_python_files(frappe_app: str) -> list[str]:
	"""Relative paths of the package's source files, protected ones marked read-only."""
	root = package_root(frappe_app)
	paths = []
	for directory, dirnames, filenames in os.walk(root):
		dirnames[:] = sorted(
			d
			for d in dirnames
			if not d.startswith(".") and d not in ("__pycache__", "node_modules", "public")
		)
		for name in sorted(filenames):
			if os.path.splitext(name)[1].lower() not in READABLE_EXTENSIONS or name == "__init__.py":
				continue
			relative = os.path.relpath(os.path.join(directory, name), root)
			paths.append(f"{relative}  [read-only]" if name in PROTECTED_BASENAMES else relative)
	return paths


# --- lint helpers ---------------------------------------------------------


def scan_whitelisted(module: ast.Module) -> tuple[list[str], list[str]]:
	"""(whitelisted function names, the subset that allows guests)."""
	whitelisted, guest = [], []
	for node in module.body:
		if not isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
			continue
		for decorator in node.decorator_list:
			if not is_whitelist_decorator(decorator):
				continue
			whitelisted.append(node.name)
			if allows_guest(decorator):
				guest.append(node.name)
	return whitelisted, guest


def is_whitelist_decorator(decorator: ast.expr) -> bool:
	target = decorator.func if isinstance(decorator, ast.Call) else decorator
	return isinstance(target, ast.Attribute) and target.attr == "whitelist"


def allows_guest(decorator: ast.expr) -> bool:
	if not isinstance(decorator, ast.Call):
		return False
	return any(
		kw.arg == "allow_guest" and isinstance(kw.value, ast.Constant) and bool(kw.value.value)
		for kw in decorator.keywords
	)


def controller_error(module: ast.Module, doctype_slug: str) -> str | None:
	document_classes = [
		node.name
		for node in module.body
		if isinstance(node, ast.ClassDef) and any(base_is_document(base) for base in node.bases)
	]
	if not document_classes:
		return "a DocType controller must define `class <DocTypeName>(Document)`."
	expected = doctype_slug.replace("_", "").lower()
	if not any(name.lower() == expected for name in document_classes):
		return (
			f"the controller class must be named after its DocType folder '{doctype_slug}' "
			f"(found: {', '.join(document_classes)})."
		)
	return None


def base_is_document(base: ast.expr) -> bool:
	name = base.attr if isinstance(base, ast.Attribute) else getattr(base, "id", "")
	return name in ("Document", "WebsiteGenerator", "NestedSet")


def app_module_dirs(frappe_app: str) -> set[str]:
	try:
		return {frappe.scrub(m) for m in frappe.get_module_list(frappe_app)}
	except Exception:
		return set()


def ensure_package_dirs(root: str, relative_dir: str) -> None:
	"""Create the folder chain and make each level an importable package — the agent
	never writes __init__.py itself (it's protected), so scaffold them here."""
	current = root
	for part in [p for p in relative_dir.split("/") if p]:
		current = os.path.join(current, part)
		os.makedirs(current, exist_ok=True)
		init = os.path.join(current, "__init__.py")
		if not os.path.exists(init):
			with open(init, "w", encoding="utf-8"):
				pass

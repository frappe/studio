import re
from functools import wraps

import frappe


def camel_case_to_kebab_case(text, remove_spaces=False):
	if not text:
		return ""
	text = re.sub(r"(?<!^)(?=[A-Z])", "-", text).lower()
	if remove_spaces:
		text = text.replace(" ", "")
	return text


def developer_file_access_denial() -> str | None:
	"""Why the current user may not edit an app's code files, or None when they may.
	Code files execute on build or on the server, so writes need a developer bench
	AND an operator: both the file explorer and the AI agent gate on this."""
	if not frappe.conf.developer_mode:
		return "developer mode is disabled on this bench"
	if "System Manager" not in frappe.get_roles():
		return "you need the System Manager role"
	return None


def ensure_developer_file_access() -> None:
	if reason := developer_file_access_denial():
		frappe.throw(frappe._("Cannot edit code files: {0}").format(frappe._(reason)), frappe.PermissionError)


def has_page_write_perm(message: str | None = None):
	"""Decorator to check if user has permission to edit Studio Page.

	Args:
	        message: Custom error message to display if permission is denied.
	                 If not provided, defaults to "You do not have permission to modify pages"
	"""

	def decorator(fn):
		@wraps(fn)
		def wrapper(*args, **kwargs):
			if not frappe.has_permission("Studio Page", ptype="write"):
				error_message = message or frappe._("You do not have permission to modify pages")
				frappe.throw(error_message)
			return fn(*args, **kwargs)

		return wrapper

	return decorator

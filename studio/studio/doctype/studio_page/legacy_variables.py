import json

import frappe

TYPE_DEFAULTS = {"String": '""', "Number": "0", "Boolean": "false", "Object": "{}"}


def get_declaration(variable: frappe._dict) -> str:
	return f"const {variable.variable_name} = ref({get_initial_value(variable)})"


def get_initial_value(variable: frappe._dict) -> str:
	default = TYPE_DEFAULTS.get(variable.variable_type, '""')
	value = (variable.initial_value or "").strip()
	if not value:
		return default
	try:
		json.loads(value)
	except ValueError:
		return default
	return value

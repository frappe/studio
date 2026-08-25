"""One source of truth for what components exist and what API they carry.

Names come from the editor's own component registry
(frontend/src/data/components.ts + componentFamilies.ts) — the same map the
component panel renders, so the AI can never disagree with the editor about
what exists. The constants.js arrays only classify names into groups, the
same way the editor's panel groups its tiles.

API facts come from frontend/src/json_types/*/*.json — JSON Schemas generated
from the component types (tsToJSONGenerator with jsDoc carried through), the
same files the editor's props panel consumes. One `<Component>.json` holds
`<Name>Props` (names/types/enums/required + JSDoc descriptions and defaults)
and, when the source exports them, `<Name>Slots` / `<Name>Emits`.

Consumers: the component-families prompt appendix (computed here, so the
prompt can't drift from the registry) and the list_components /
describe_component agent tools.
"""

import json
import re
from functools import lru_cache
from pathlib import Path

# Classification arrays from constants.js — molecules first so the List family
# wins over the general frappe-ui membership.
CLASSIFIER_ARRAYS = {
	"FRAPPE_UI_MOLECULES": "frappe-ui list family",
	"FRAPPE_UI_COMPONENTS": "frappe-ui",
	"FRAMEWORK_UI_COMPONENTS": "@framework/ui",
}
FALLBACK_GROUP = "studio"
CATALOG_LINE_RE = re.compile(r"^- ([A-Za-z]+)[:\s]", re.MULTILINE)
REGISTRY_KEY_RE = re.compile(r"^\t([A-Za-z]+): \{", re.MULTILINE)

# The lucide sprite frappe-ui's <Icon> resolves `name` against at runtime — the same
# file IconPicker scrapes its options from, so the AI's icon vocabulary is exactly the
# editor's. Symbol ids ARE the icon names.
ICON_SPRITE = "frontend/node_modules/lucide-static/sprite.svg"
ICON_SYMBOL_RE = re.compile(r'<symbol[^>]*\bid="([a-z0-9-]+)"')


def registered_components() -> dict[str, list[str]]:
	"""{group label: [component names]} from the editor's component registry."""
	text = _read_repo_file("frontend/src/utils/constants.js")
	membership: dict[str, str] = {}
	for const, label in CLASSIFIER_ARRAYS.items():
		match = re.search(rf"export const {const} = \[(.*?)\]", text, re.DOTALL)
		for name in re.findall(r'"([^"]+)"', match.group(1)) if match else []:
			membership.setdefault(name, label)
	groups: dict[str, list[str]] = {}
	for name in _registry_names():
		groups.setdefault(membership.get(name, FALLBACK_GROUP), []).append(name)
	return groups


def _registry_names() -> list[str]:
	"""Top-level entries of the editor's registry (data/components.ts +
	componentFamilies.ts). In the main file, an entry with only a blockTemplate
	(e.g. Header) is a panel shortcut that drops a template, not a component;
	family parts are real components that also carry templates."""
	names = []
	for relative, skip_templates in (
		("frontend/src/data/components.ts", True),
		("frontend/src/data/componentFamilies.ts", False),
	):
		parts = REGISTRY_KEY_RE.split(_read_repo_file(relative))
		for name, body in zip(parts[1::2], parts[2::2], strict=False):
			if skip_templates and "blockTemplate:" in body:
				continue
			names.append(name)
	return names


def component_api(name: str) -> dict | None:
	"""Props/slots/emits for one component (from the editor's type schemas), or
	None when no schema ships for it."""
	return _schema_data().get(name)


# The rule the editor's column manager enforces — every scaffold consumer repeats it.
LIST_COLUMNS_RULE = (
	"A List column lives in THREE places kept in step positionally: a track in the List's "
	"'columns' prop, a ListHeaderCell, and a ListCell in every row template — add/remove/reorder "
	"all three together. Bind ListRows 'items' to a data source ({{ source.data }}); inside the "
	"row template use {{ item.<field> }} and {{ value }} (the row identity)."
)


def family_scaffold(name: str) -> tuple[dict | None, str | None]:
	"""The editor's canonical composition for a family component (familyTemplates.ts,
	distilled to the compact schema) — (scaffold, family key), or (None, None)."""
	data = _family_data()
	kebab = re.sub(r"(?<!^)(?=[A-Z])", "-", name).lower()
	if kebab in data:
		return data[kebab], kebab
	for prefix, family in (("list", "list"), ("settings", "settings-dialog"), ("sidebar", "sidebar")):
		if kebab.startswith(prefix) and family in data:
			return data[family], family
	return None, None


def catalog_names(catalog_text: str) -> set[str]:
	"""Component names documented in the prompt's curated catalog (its '- Name:' lines)."""
	return set(CATALOG_LINE_RE.findall(catalog_text))


FAMILY_TITLES = {
	"list": "List family",
	"settings-dialog": "Settings dialog family",
	"sidebar": "Sidebar family",
}


def component_families_appendix(catalog_text: str) -> str:
	"""The composed component families (List, Settings dialog, Sidebar) — members'
	props plus the editor's canonical composition for each (familyTemplates.ts).
	Families are separated from the main listing because they only make sense
	assembled, never as lone blocks."""
	families: dict[str, list[str]] = {}
	for name, family in _family_members(catalog_text):
		families.setdefault(family, []).append(_appendix_entry(name))
	if not families:
		return ""
	lines = [
		"COMPONENT FAMILIES (composed structures — start from the canonical composition: "
		"copy the structure, swap the content and bindings):"
	]
	for family, entries in families.items():
		lines.append(f"\n{FAMILY_TITLES.get(family, family)}: " + "; ".join(entries))
		if scaffold := _family_data().get(family):
			note = f" {LIST_COLUMNS_RULE}" if family == "list" else ""
			lines.append(f"Canonical composition:{note}\n{json.dumps(scaffold, separators=(',', ':'))}")
	return "\n".join(lines)


def _family_members(catalog_text: str) -> list[tuple[str, str]]:
	"""(name, family key) for registered family components the curated catalog
	doesn't already document."""
	known = {n.lower() for n in catalog_names(catalog_text)}
	out = []
	for label, names in registered_components().items():
		for name in names:
			if name.lower() in known:
				continue
			if family := _family_key(name, label):
				out.append((name, family))
	return out


def _family_key(name: str, group_label: str) -> str | None:
	if group_label == "frappe-ui list family":
		return "list"
	if group_label == "frappe-ui":
		kebab = re.sub(r"(?<!^)(?=[A-Z])", "-", name).lower()
		if kebab.startswith("settings"):
			return "settings-dialog"
		if kebab.startswith("sidebar"):
			return "sidebar"
	return None


def _appendix_entry(name: str) -> str:
	api = component_api(name)
	if not api or not api.get("props"):
		return name
	props = ", ".join(p["name"] for p in api["props"][:10])
	slots = [s["name"] for s in api.get("slots", []) if s["name"] != "default"]
	suffix = f" | slots: {', '.join(slots[:6])}" if slots else ""
	return f"{name} ({props}{suffix})"


@lru_cache(maxsize=1)
def _schema_data() -> dict:
	"""{component: {props, slots?, emits?}} from the editor's generated type schemas
	(frontend/src/json_types/<library>/<Component>.json)."""
	root = Path(__file__).resolve().parents[2] / "frontend" / "src" / "json_types"
	out: dict[str, dict] = {}
	for file in sorted(root.glob("*/*.json")):
		try:
			definitions = json.loads(file.read_text(encoding="utf-8")).get("definitions") or {}
		except (OSError, json.JSONDecodeError):
			continue
		name = file.stem
		props_def = definitions.get(f"{name}Props") or next(
			(v for k, v in definitions.items() if k.endswith("Props")), None
		)
		if not isinstance(props_def, dict):
			continue
		if props := _definition_rows(props_def, with_types=True):
			out[name] = {"props": props}
		for kind in ("Slots", "Emits"):
			definition = definitions.get(f"{name}{kind}")
			if isinstance(definition, dict) and definition.get("properties"):
				out.setdefault(name, {})[kind.lower()] = _definition_rows(definition, with_types=False)
	return out


def _definition_rows(definition: dict, *, with_types: bool) -> list[dict]:
	required = set(definition.get("required") or [])
	rows = []
	for name, spec in (definition.get("properties") or {}).items():
		spec = spec if isinstance(spec, dict) else {}
		row = {"name": name}
		if with_types:
			row["type"] = _schema_type(spec)
		if name in required and with_types:
			row["required"] = True
		if isinstance(spec.get("description"), str):
			row["description"] = spec["description"]
		if spec.get("default") is not None:
			row["default"] = (
				json.dumps(spec["default"]) if not isinstance(spec["default"], str) else spec["default"]
			)
		rows.append(row)
	return rows


def _schema_type(spec: dict) -> str:
	if "enum" in spec:
		return " | ".join(str(v) for v in spec["enum"])
	if "$ref" in spec:
		return spec["$ref"].rsplit("/", 1)[-1]
	kind = spec.get("type")
	if isinstance(kind, list):
		return " | ".join(kind)
	if kind == "array":
		items = spec.get("items")
		return f"{_schema_type(items)}[]" if isinstance(items, dict) else "array"
	return kind or ("object" if spec.get("properties") else "any")


@lru_cache(maxsize=1)
def icon_names() -> tuple[str, ...]:
	"""Every icon name `getIcon(name)` / a component's `icon` prop can resolve.

	Read from the installed lucide sprite rather than a checked-in copy, so the
	list tracks whatever lucide-static the editor actually renders. Empty when
	node_modules isn't installed (the prompt then falls back to prose)."""
	return tuple(sorted(set(ICON_SYMBOL_RE.findall(_read_repo_file(ICON_SPRITE)))))


def icon_catalog_appendix() -> str:
	"""The full icon vocabulary, inlined. Naming an icon that isn't in the sprite
	renders an empty <svg>, and models reliably invent plausible-but-absent names
	from a prose 'see lucide.dev' pointer — so the names ship in the prompt."""
	if not (names := icon_names()):
		return ""
	return (
		f"VALID ICON NAMES ({len(names)} lucide icons — the COMPLETE set Studio can render).\n"
		"Any `icon` / `iconLeft` / `iconRight` prop and every getIcon('...') call must use a "
		"name from this list, VERBATIM. There are no others: if the icon you want isn't here, "
		"pick the closest name that is. Prefix with `lucide-` only where the catalog entry "
		"shows `lucide-icon-name`; getIcon('...') takes the bare name.\n" + ", ".join(names)
	)


@lru_cache(maxsize=1)
def _family_data() -> dict:
	try:
		return json.loads(_read_repo_file("studio/ai/family_templates.json"))
	except (OSError, json.JSONDecodeError):
		return {}


def _read_repo_file(relative: str) -> str:
	path = Path(__file__).resolve().parents[2] / relative
	try:
		return path.read_text(encoding="utf-8")
	except OSError:
		return ""

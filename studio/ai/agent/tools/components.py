"""Component discovery tools — the registry beyond the prompt's curated catalog.

The catalog in the system prompt documents the common set deeply (with Studio's
contracts baked in); these tools cover the long tail: list_components is the
authoritative registration list, describe_component serves the full API for one
component from the distilled frappe-ui data (component_api.json). Facts learned
here reach the generator through the generate_page BRIEF — the generator itself
has no tools."""

import json

from studio.ai import component_registry as registry
from studio.ai.agent.registry import Tool

STUDIO_CONTRACT_NOTE = (
	"\n\nStudio notes: `modelValue` two-way binds are stored as variable binds (or bound with "
	"{{ }}); emits map to the block's `events` (a `change` emit → events key 'change'); "
	"function-type props (onClick in actions/options) must be arrow-function STRINGS; style "
	"components through their props, containers through `style` with espresso vars."
)


def run_list_components(ctx, args: dict) -> str:
	from studio.ai.prompts import COMPONENT_CATALOG

	known = {n.lower() for n in registry.catalog_names(COMPONENT_CATALOG)}
	lines = [
		"Every registered component (the editor's own list). CATALOG = documented in your "
		"instructions — prefer these. Others: call describe_component before first use; names "
		"with no API data are risky — use only when nothing else fits."
	]
	for label, names in registry.registered_components().items():
		rendered = []
		for name in names:
			if name.lower() in known:
				rendered.append(f"{name} [catalog]")
			elif registry.component_api(name):
				rendered.append(f"{name} [api]")
			else:
				rendered.append(f"{name} [no api data]")
		lines.append(f"{label}: " + ", ".join(rendered))
	return "\n".join(lines)


def run_describe_component(ctx, args: dict) -> str:
	name = (args.get("component") or "").strip()
	if not name:
		return "FAILED: 'component' is required."
	registered = {n for names in registry.registered_components().values() for n in names}
	api = registry.component_api(name)
	if api is None and name not in registered:
		close = [r for r in registered if name.lower() in r.lower() or r.lower() in name.lower()]
		hint = f" Did you mean: {', '.join(sorted(close)[:5])}?" if close else ""
		return f"FAILED: '{name}' is not a registered component.{hint} Call list_components."
	scaffold = _scaffold_section(name)
	if api is None:
		if scaffold:
			return f"── {name} ──{scaffold}{STUDIO_CONTRACT_NOTE}"
		return (
			f"'{name}' is registered but ships no API data. Prefer a catalog component; if you "
			"must use it, keep to props you've seen in this app's existing pages."
		)
	return f"── {name} API ──\n{_format_api(api)}{scaffold}{STUDIO_CONTRACT_NOTE}"


def _scaffold_section(name: str) -> str:
	scaffold, family = registry.family_scaffold(name)
	if not scaffold:
		return ""
	note = f" {registry.LIST_COLUMNS_RULE}" if family and family.startswith("list") else ""
	return (
		f"\n\nCANONICAL STUDIO COMPOSITION ('{family}' — the editor inserts exactly this; copy the "
		f"structure, swap the content and bindings).{note}\n{json.dumps(scaffold, separators=(',', ':'))}"
	)


def _format_api(api: dict) -> str:
	sections = []
	for kind in ("props", "slots", "emits"):
		rows = api.get(kind)
		if not rows:
			continue
		lines = [f"{kind.upper()}:"]
		for row in rows:
			parts = [row["name"]]
			if row.get("type"):
				parts.append(f"({row['type']})")
			if row.get("required"):
				parts.append("REQUIRED")
			if row.get("default"):
				parts.append(f"default {row['default']}")
			if row.get("description"):
				parts.append(f"— {row['description']}")
			lines.append("  " + " ".join(parts))
		sections.append("\n".join(lines))
	return "\n".join(sections)


list_components = Tool(
	name="list_components",
	side="server",
	handler=run_list_components,
	description=(
		"List EVERY registered component — the catalog in your instructions plus the less-"
		"documented long tail (Settings/Sidebar families, the List molecules, @framework/ui, "
		"Studio extras). Check here before saying a component doesn't exist or building a "
		"lookalike out of containers."
	),
	parameters={"type": "object", "properties": {}},
)

describe_component = Tool(
	name="describe_component",
	side="server",
	handler=run_describe_component,
	description=(
		"Full props/slots/emits for ONE component (from the editor's own type schemas). Use it "
		"before first use of a non-catalog component, or when a catalog entry's compressed props "
		"aren't enough (exact prop types, named slots, event names). To use the component in "
		"generate_page, put the exact props you learned into the BRIEF — the generator can't "
		"call tools."
	),
	parameters={
		"type": "object",
		"properties": {
			"component": {"type": "string", "description": "The component name, e.g. 'Dialog'."},
		},
		"required": ["component"],
	},
)

TOOLS = [list_components, describe_component]

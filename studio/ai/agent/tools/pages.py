"""App-wide page tools: browse the app's pages and move the turn's focus.

The agent edits ONE page at a time — its focus. `list_pages`/`read_page` give it
app-level awareness (routes, digests of sibling pages) without moving the focus;
`open_page`/`create_page` move it: the runner re-points its working tree, toolset
and per-page run lock at the target (see AgentRunner.focus_page), and every block
op after that lands on the new page. The editor mirrors only events for the page
it shows, so background pages build quietly and appear from the DB on navigation.
"""

import json
import re

import frappe

from studio.ai.agent.registry import Tool
from studio.ai.block_codec import BlockCodec

# What Studio's auto-titler produces (StudioPage.before_insert): "My Page", "My Page-1", …
# (append_number_if_name_exists, "-" separator) and the route derived from it:
# "/my-page[-N]-<4 alnum>". Any user edit breaks the pattern, so a user-chosen
# title/route is never flagged as default.
DEFAULT_TITLE = re.compile(r"^My Page([ -]\d+)?$")
DEFAULT_ROUTE = re.compile(r"^/my-page(-\d+)?-[0-9a-z]{4}$")

# Matches the editor's "body" block template (frontend/src/utils/blockTemplate).
STARTER_ROOT = {
	"componentId": "root",
	"componentName": "div",
	"blockName": "body",
	"originalElement": "body",
	"children": [],
	"baseStyles": {
		"display": "flex",
		"flexDirection": "row",
		"flexShrink": 0,
		"width": "inherit",
		"overflowX": "hidden",
		"height": "100%",
	},
}


def run_list_pages(ctx, args: dict) -> str:
	if not ctx.app_id:
		return "FAILED: this chat is not attached to an app."
	pages = frappe.get_all(
		"Studio Page",
		filters={"studio_app": ctx.app_id},
		fields=["name", "page_title", "route", "published"],
		order_by="creation asc",
	)
	app_home = frappe.db.get_value("Studio App", ctx.app_id, "app_home")
	for page in pages:
		if page["name"] == ctx.page_id:
			page["focused"] = True
		if page["name"] == app_home:
			page["app_home"] = True
		if DEFAULT_TITLE.match(page["page_title"] or ""):
			page["title_is_default"] = True
		if DEFAULT_ROUTE.match(page["route"] or ""):
			page["route_is_default"] = True
	return f"Pages in this app ('name' is what open_page/read_page take):\n{BlockCodec.to_json(pages)}"


def run_read_page(ctx, args: dict) -> str:
	page, error = _resolve_app_page(ctx, args.get("page_name"))
	if error:
		return error
	if page.name == ctx.page_id:
		return "That's the focused page — its structure is already in your context (or query_blocks it)."
	return f"Page '{page.name}' ({page.page_title}, route {page.route}):\n{_page_digest(page)}"


def run_open_page(ctx, args: dict) -> str:
	page, error = _resolve_app_page(ctx, args.get("page_name"))
	if error:
		return error
	if page.name == ctx.page_id:
		return f"Already focused on '{page.name}'."
	if error := ctx.focus_page(page.name):
		return f"FAILED: {error}"
	_emit_page_event(ctx, "focused", page)
	ctx.emit("progress", message=f"Working on page '{page.page_title}'…")
	return (
		f"Focused on page '{page.name}' ({page.page_title}, route {page.route}). All block "
		f"edits now target THIS page. Current structure:\n{_focused_tree_json(ctx)}"
	)


def run_create_page(ctx, args: dict) -> str:
	if not ctx.app_id:
		return "FAILED: this chat is not attached to an app."
	title = (args.get("title") or "").strip()
	if not title:
		return "FAILED: 'title' is required."
	route = _normalize_route(args.get("route") or "")
	if route and frappe.db.exists("Studio Page", {"studio_app": ctx.app_id, "route": route}):
		return f"FAILED: route '{route}' already exists in this app — pick another or open that page."

	is_standard, frappe_app = frappe.db.get_value("Studio App", ctx.app_id, ["is_standard", "frappe_app"])
	page = frappe.get_doc(
		{
			"doctype": "Studio Page",
			"studio_app": ctx.app_id,
			"page_title": title,
			"route": route or None,
			"draft_blocks": [STARTER_ROOT],
			"is_standard": is_standard,
			"frappe_app": frappe_app if is_standard else None,
		}
	)
	page.insert(ignore_permissions=False)
	frappe.db.commit()

	if error := ctx.focus_page(page.name):
		return f"Created page '{page.name}' ({page.route}), but could not focus it: {error}"
	_emit_page_event(ctx, "created", page)
	ctx.emit("progress", message=f"Created page '{page.page_title}' — building it…")
	return (
		f"Created page '{page.name}' ({page.page_title}, route {page.route}) and focused it. "
		"It's empty (a bare body block) — build it now: all block edits target THIS page."
	)


def run_set_page_meta(ctx, args: dict) -> str:
	if not (ctx.page_id and ctx.app_id):
		return "FAILED: no page in focus."
	title = (args.get("title") or "").strip()
	route = _normalize_route(args.get("route") or "")
	if not title and not route:
		return "FAILED: pass a title and/or a route — nothing to change."
	if route and frappe.db.exists(
		"Studio Page", {"studio_app": ctx.app_id, "route": route, "name": ["!=", ctx.page_id]}
	):
		return f"FAILED: route '{route}' already belongs to another page in this app."

	page = frappe.get_doc("Studio Page", ctx.page_id)
	if title:
		page.page_title = title
	if route:
		page.route = route
	page._skip_validate = True  # meta only — same fast path as the editor's save_page_field
	page.save()
	frappe.db.commit()
	_emit_page_event(ctx, "updated", page)
	return f"Page is now titled '{page.page_title}' with route {page.route}."


def _emit_page_event(ctx, action: str, page) -> None:
	"""Tell the editor the turn's focus moved or its meta changed: it refreshes the pages
	list (an agent-created page is otherwise invisible until reload), shows a "building
	this page" chip linking to the target, and — for the open page — adopts the new
	title/route/modified so its next save doesn't conflict."""
	ctx.emit(
		"page",
		action=action,
		page_name=page.name,
		page_title=page.page_title,
		route=page.route,
		modified=str(page.modified),
	)


def _resolve_app_page(ctx, page_name):
	"""The named page as a doc, verified to exist in this chat's app. Returns
	(page, None) or (None, error_string)."""
	page_name = (page_name or "").strip()
	if not page_name:
		return None, "FAILED: 'page_name' is required — get it from list_pages."
	if not ctx.app_id:
		return None, "FAILED: this chat is not attached to an app."
	if not frappe.db.exists("Studio Page", {"name": page_name, "studio_app": ctx.app_id}):
		return None, f"FAILED: no page '{page_name}' in this app — call list_pages for real names."
	return frappe.get_doc("Studio Page", page_name), None


def _page_digest(page) -> str:
	"""A page's block tree in the same compact schema as the focused page's context."""
	try:
		data = json.loads(page.draft_blocks or page.blocks or "[]")
	except (json.JSONDecodeError, TypeError):
		return "(unreadable page)"
	root = data[0] if isinstance(data, list) and data else data
	if not isinstance(root, dict):
		return "(empty page)"
	return BlockCodec.to_json(BlockCodec.compress(root))


def _focused_tree_json(ctx) -> str:
	root = ctx.page_root()
	return BlockCodec.to_json(BlockCodec.compress(root)) if root else "(empty page)"


def _normalize_route(route: str) -> str:
	route = route.strip()
	if route and not route.startswith("/"):
		route = f"/{route}"
	return route


list_pages = Tool(
	name="list_pages",
	side="server",
	handler=run_list_pages,
	description=(
		"List every page in this app: name (the ref open_page/read_page take), title, route, and "
		"published state. Call this before referencing, linking to, or editing another page."
	),
	parameters={"type": "object", "properties": {}},
)

read_page = Tool(
	name="read_page",
	side="server",
	handler=run_read_page,
	description=(
		"Read another page's block structure (compact schema, same as your page context) WITHOUT "
		"switching to it. Use it to match an existing page's design, reuse its patterns, or check "
		"what a route renders before linking to it."
	),
	parameters={
		"type": "object",
		"properties": {
			"page_name": {"type": "string", "description": "The page's 'name' from list_pages."},
		},
		"required": ["page_name"],
	},
)

open_page = Tool(
	name="open_page",
	side="server",
	handler=run_open_page,
	description=(
		"Switch your working focus to another EXISTING page in this app. After this, ALL block "
		"edits (add/update/move/generate_page/bindings/script) target that page until you switch "
		"again. Work on ONE page at a time, finishing it before moving on. The user's editor is "
		"unaffected — they see the result when they open that page."
	),
	parameters={
		"type": "object",
		"properties": {
			"page_name": {"type": "string", "description": "The page's 'name' from list_pages."},
		},
		"required": ["page_name"],
	},
)

create_page = Tool(
	name="create_page",
	side="server",
	handler=run_create_page,
	description=(
		"Create a NEW page in this app and switch your working focus to it. ONLY for a page that "
		"doesn't exist yet (check list_pages first) — if the focused page or the app home is empty, "
		"build the main content THERE instead of creating a duplicate. Give a clear title and a short "
		"kebab-case route (e.g. '/orders'); the route must be unique within the app. The new page "
		"starts empty — build it right after, and wire navigation to it from other pages if asked."
	),
	parameters={
		"type": "object",
		"properties": {
			"title": {"type": "string", "description": "Human page title, e.g. 'Order History'."},
			"route": {
				"type": "string",
				"description": "URL route within the app, e.g. '/orders'. Optional — derived from the title if omitted.",
			},
		},
		"required": ["title"],
	},
)

set_page_meta = Tool(
	name="set_page_meta",
	side="server",
	handler=run_set_page_meta,
	description=(
		"Rename the FOCUSED page and/or change its route (unique within the app). Use it when "
		"list_pages flags the page's title_is_default / route_is_default (auto-generated, never "
		"touched by the user) after building content on it, and whenever the user asks to rename "
		"or re-route. NEVER replace a title the user chose — if only route_is_default, update just "
		"the route to match the existing title."
	),
	parameters={
		"type": "object",
		"properties": {
			"title": {"type": "string", "description": "New page title, e.g. 'Dashboard'."},
			"route": {"type": "string", "description": "New route, e.g. '/overview'."},
		},
	},
)

TOOLS = [list_pages, read_page, open_page, create_page, set_page_meta]

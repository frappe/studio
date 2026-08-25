---
name: studio-app-building
description: Build Frappe Studio apps and pages — the block JSON schema, data sources, bindings, page scripts (custom vs standard form), the design language, and app structure. Use when creating or editing Studio Page block trees, wiring Frappe data into Studio pages, writing Studio page scripts, deciding how a Studio page should look, or working on a Studio App from any coding agent.
---

# Building Frappe Studio apps

Studio is a visual app builder on the Frappe Framework. An app (`Studio App`) is
a set of pages (`Studio Page`); each page stores a **block tree** (JSON),
optional **data sources** (child table `Studio Page Resource`), and a **page
script**. frappe-ui components render the blocks (the `frappe-ui` skill in
`frappe-ui/skills/` covers the component API for hand-written Vue).

The runtime source of truth for the rules below is `studio/ai/prompts.py`
(BLOCK_SCHEMA, STYLING_RULES, COMPONENT_CATALOG, …) — if this file and that one
disagree, prompts.py wins. How pages should LOOK lives in
[DESIGN.md](DESIGN.md) — read it before building or restyling any page (it is
baked into the runtime AI prompts from this directory).

## Where things live

- Page blocks: `Studio Page.draft_blocks` (JSON array with ONE root block);
  the published copy is in `blocks`.
- The root block (and every `container`/`div` block) must carry
  `originalElement` (`"body"` for the root, `"div"` for containers) — blocks
  without it render nothing, all the way down. Never put `originalElement` on
  a component block.
- Data sources: rows in `Studio Page.resources` — Document List / Document /
  API Resource, with optional `transform`, `on_success`, `on_error` hooks.
- Page script: `Studio Page.script`.
- Standard (exported) apps additionally materialize as files under the linked
  Frappe app; editing those files on disk syncs back to the DB on dev setups.

## Block JSON

Stored blocks use the full keys: `componentName`, `componentProps`,
`baseStyles` / `mobileStyles` / `tabletStyles` (camelCase CSS), `componentSlots`,
`children`, `componentEvents`, `visibilityCondition`, `blockName`, and a
`componentId` unique in the tree. Studio's AI tools speak a compact alias form
(`name`/`props`/`style`/`mstyle`/`tstyle`/`slots`/`c`/`events`/`visibility`/`label`);
the shapes are otherwise identical.

Rules that bite — binding/event/handler-prop/styling-token mechanics — live
in [RULES.md](RULES.md); read them before writing blocks. (That file is
shared verbatim with the in-product AI prompts, so a rule is written once for
both.) Full styling judgment — ink ladder, density, when to round — lives in
[DESIGN.md](DESIGN.md).

## Data sources

Create a Document List source per doctype you render; bind with
`{{ source_name.data }}` (a single Document exposes `{{ source_name.doc }}`).
Filters use Frappe's list-filter JSON: `{"status": "Open"}` or
`{"status": ["!=", "Closed"]}`; multiple values need `["in", [...]]` — a bare
value list crashes the fetch. Point a Repeater at the source and bind its
child blocks via `dataItem`. Never invent doctype or field names — read the
real schema first (`frappe.get_meta`, or the agent's schema tools).

## Page scripts — two forms

- **Custom (non-exported) app**: a bare interpreted script body. Ambient
  context: variables and data sources are auto-exposed by name (variables are
  refs — write via `.value`). No imports, no export.
- **Standard (exported) app**: an ES module —
  `export default function setup(context) { ... }` with explicit imports and
  an explicit return of what the page uses. State lives in code (refs,
  stores), not Studio variables.

Never mix the forms: a module script on a custom page (or a bare script on a
standard page) is rejected.

## Working across an app

Keep sibling pages visually consistent: read an existing page's tree before
building a new one and reuse its palette, spacing rhythm, and section
structure. Routes start with `/` and are unique within the app. Build one
page at a time, completely, before starting the next; wire navigation on the
page that links to a new page, not just the new page itself.

# Migrate legacy variables to page scripts

This is a manual, breaking migration—not an executable patch. Preserve legacy
rows for reference; upgrading does not restore their runtime state.

## Migrate

1. Read the page's existing script, bindings, and resources. Get the old declarations
   using **Copy legacy variables** or `get_legacy_variable_migration(page_name)`.
   Check original values: the generator substitutes defaults for invalid JSON.
2. Keep existing bindings and functions. Reuse already-migrated state; preserve
   variable names unless you update every reference.
3. Place declarations according to the page type:
   - **Custom page:** declare top-level state in the stored script, e.g.
     `const searchTerm = ref("")`. Vue APIs are supplied; no imports or return needed.
   - **Exported page:** import Vue APIs in the companion `.ts` file, declare state
     inside the existing synchronous `setup(context)`, and merge names into its
     existing return. Never paste a bare return at module scope or add an early return.
4. Props use `{{ searchTerm }}`; script handlers use `searchTerm.value`. Existing
   `$type: "variable"` bindings can target the same-named script state.

## Resource-backed state

Resources exist during setup, but data loads asynchronously. Requests wait until
script bindings are exposed; no readiness hook or async setup is needed.

`ref(note.doc?.title)` captures one value and does not track later responses. Use:

- **Derived display:** `computed(() => note.doc?.title ?? "")`.
- **Editable state:** a ref populated by a watcher or fetch callback. Decide when
  to overwrite it so background refreshes do not discard unsaved edits.
- **Dependent resources:** disable auto-fetch and fetch from a guarded watcher
  when the required value becomes available.

Exported scripts import Vue APIs and access resources through `context.note`.

## Verify

Check initial load, request parameters, empty responses, editing/saving, and route
changes. Confirm existing bindings still work and watchers do not accumulate.
Report migrated pages, checks run, and unresolved values. Dismissing the warning
only hides it; it does not verify migration or delete legacy data.

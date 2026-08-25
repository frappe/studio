"""The authoritative page tree for one agent turn.

The loop loads the target page's draft blocks into a `WorkingTree`, applies every
block op HERE, and persists the tree after each round — the server is the writer,
the editor canvas only mirrors accepted ops (see toolDispatch.ts). Because the op
is applied before it is emitted, the tool result handed back to the model is the
truth — "applied to block X", "3 of 12 not found", "parent not found" — and a
rejected op (result starting with "FAILED") is never emitted, so canvas and draft
cannot diverge.

Ids are assigned server-side at apply time (`BlockCodec.ensure_ids`): a block
added this turn gets its id stamped into the op args (`block_json`) before the op
reaches the canvas, and into the tool result so the model can target it in later
rounds.
"""

from studio.ai.agent.selectors import child_blocks, find_block, walk_blocks
from studio.ai.block_codec import BlockCodec


class WorkingTree:
	def __init__(self, root: dict | None):
		self.root = root

	def apply(self, tool_name: str, args: dict) -> str:
		args = args or {}
		if tool_name == "update_block":
			return self.apply_update(args)
		if tool_name == "update_blocks":
			return self.apply_update_blocks(args)
		if tool_name == "remove_block":
			return self.apply_remove(args.get("component_id"))
		if tool_name == "move_block":
			return self.apply_move(args)
		if tool_name == "add_block":
			return self.apply_add(args)
		if tool_name == "set_slot":
			return self.apply_set_slot(args)
		if tool_name == "remove_slot":
			return self.apply_remove_slot(args)
		if tool_name in ("bind_prop", "set_repeater_data", "sync_variable"):
			return self.apply_bind(tool_name, args)
		if tool_name in ("set_event_handler", "set_visibility"):
			return self.apply_interactivity(tool_name, args)
		return f"FAILED: unknown tool '{tool_name}'."

	# --- block edits ------------------------------------------------------

	def apply_update(self, args: dict) -> str:
		component_id = args.get("component_id")
		block = self.resolve(component_id)
		if block is None:
			return f"FAILED: component_id '{component_id}' not found{self.id_hint(component_id)}"
		self.merge_patch(block, args)
		return f"Applied to block {component_id} (<{block.get('componentName') or 'div'}>)."

	def apply_update_blocks(self, args: dict) -> str:
		"""Apply per-block patches (or one uniform patch) to every target that exists.
		Missing refs are reported AND filtered out of `args`, so the emitted op only
		carries the edits that were actually applied."""
		patches = args.get("patches")
		if isinstance(patches, list):
			found, missing = [], []
			for patch in (p for p in patches if isinstance(p, dict)):
				block = self.resolve(patch.get("component_id"))
				if block is None:
					missing.append(patch.get("component_id"))
					continue
				self.merge_patch(block, patch)
				found.append(patch)
			args["patches"] = found
			applied = len(found)
			total = applied + len(missing)
		else:
			ids = args.get("component_ids") or []
			if not ids:
				return "FAILED: no component_ids or patches supplied — nothing to update."
			missing = [i for i in ids if self.resolve(i) is None]
			found_ids = [i for i in ids if i not in missing]
			for component_id in found_ids:
				self.merge_patch(self.resolve(component_id), args)
			args["component_ids"] = found_ids
			applied = len(found_ids)
			total = len(ids)
		if not applied:
			return f"FAILED: none of the supplied refs exist. NOT FOUND: {missing}."
		if missing:
			return (
				f"Applied to {applied} of {total} blocks. NOT FOUND: {missing}. "
				"Those refs don't exist — recheck them, don't reissue the same ids."
			)
		return f"Applied to all {applied} block(s)."

	def merge_patch(self, block: dict, args: dict) -> None:
		"""Merge one block's worth of changes — the same shallow merges the editor's
		dispatcher performs, so mirror and draft stay identical."""
		if props := args.get("props"):
			block.setdefault("componentProps", {}).update(props)
		if style := args.get("style"):
			block.setdefault("baseStyles", {}).update(style)
		if mstyle := args.get("mstyle"):
			block.setdefault("mobileStyles", {}).update(mstyle)
		if tstyle := args.get("tstyle"):
			block.setdefault("tabletStyles", {}).update(tstyle)
		if (label := args.get("label")) is not None:
			block["blockName"] = label

	def apply_add(self, args: dict) -> str:
		parent_id = args.get("parent_component_id")
		parent = self.resolve(parent_id)
		if parent is None:
			return f"FAILED: parent_component_id '{parent_id}' not found{self.id_hint(parent_id)}"
		block = BlockCodec.ensure_ids(BlockCodec.expand(args.get("block") or {}))
		self.insert_child(parent, block, args.get("after_component_id"), args.get("index"))
		# Ship the expanded block (assigned ids included) so the canvas keys the same refs.
		args["block_json"] = block
		args["component_id"] = block["componentId"]
		name = block.get("componentName") or "block"
		return f"Added the {name} block under {parent_id} with id '{block['componentId']}'."

	def apply_remove(self, component_id: str | None) -> str:
		block = self.resolve(component_id)
		if block is None:
			return f"FAILED: component_id '{component_id}' not found{self.id_hint(component_id)}"
		self.detach(component_id)
		return f"Removed block {component_id}."

	def apply_move(self, args: dict) -> str:
		component_id = args.get("component_id")
		new_parent_id = args.get("new_parent_component_id")
		block = self.resolve(component_id)
		if block is None:
			return f"FAILED: component_id '{component_id}' not found{self.id_hint(component_id)}"
		new_parent = self.resolve(new_parent_id)
		if new_parent is None:
			return f"FAILED: new_parent_component_id '{new_parent_id}' not found{self.id_hint(new_parent_id)}"
		# A block can't become a child of itself or its own descendant — that would
		# cycle the tree (and infinite-loop a later walk). Reject it like an invalid ref.
		if find_block(block, new_parent_id) is not None:
			return f"FAILED: can't move {component_id} into itself or its own descendant ({new_parent_id})."
		self.detach(component_id)
		self.insert_child(new_parent, block, args.get("after_component_id"), args.get("index"))
		return f"Moved block {component_id} under {new_parent_id}."

	def apply_set_slot(self, args: dict) -> str:
		component_id = args.get("component_id")
		block = self.resolve(component_id)
		if block is None:
			return f"FAILED: component_id '{component_id}' not found{self.id_hint(component_id)}"
		slot_name = args.get("slot_name")
		blocks = [
			BlockCodec.ensure_ids(BlockCodec.expand(b))
			for b in args.get("blocks") or []
			if isinstance(b, dict)
		]
		block.setdefault("componentSlots", {})[slot_name] = {"slotName": slot_name, "slotContent": blocks}
		# Ship the expanded slot content (assigned ids included) to the canvas.
		args["blocks_json"] = blocks
		return f"Set the '{slot_name}' slot of block {component_id} ({len(blocks)} block(s))."

	def apply_remove_slot(self, args: dict) -> str:
		component_id = args.get("component_id")
		block = self.resolve(component_id)
		if block is None:
			return f"FAILED: component_id '{component_id}' not found{self.id_hint(component_id)}"
		slot_name = args.get("slot_name")
		if isinstance(block.get("componentSlots"), dict):
			block["componentSlots"].pop(slot_name, None)
		return f"Removed the '{slot_name}' slot from block {component_id}."

	# --- bindings & interactivity ----------------------------------------

	def apply_bind(self, tool_name: str, args: dict) -> str:
		component_id = args.get("component_id")
		block = self.resolve(component_id)
		if block is None:
			return f"FAILED: component_id '{component_id}' not found{self.id_hint(component_id)}"
		props = block.setdefault("componentProps", {})
		if tool_name == "set_repeater_data":
			source = args.get("data_source_name")
			props["data"] = f"{{{{ {source}.data }}}}"
			if data_key := args.get("data_key"):
				props["dataKey"] = data_key
			return f"Bound block {component_id} to repeat over {{{{ {source}.data }}}}."
		if tool_name == "sync_variable":
			prop = args.get("prop") or "modelValue"
			props[prop] = {"$type": "variable", "name": args.get("variable_name")}
			return (
				f"Synced {prop} of block {component_id} two-way with variable '{args.get('variable_name')}'."
			)
		props[args.get("prop")] = wrap_expression(args.get("expression"))
		return (
			f"Bound prop '{args.get('prop')}' of block {component_id} to {{{{ {args.get('expression')} }}}}."
		)

	def apply_interactivity(self, tool_name: str, args: dict) -> str:
		component_id = args.get("component_id")
		block = self.resolve(component_id)
		if block is None:
			return f"FAILED: component_id '{component_id}' not found{self.id_hint(component_id)}"
		if tool_name == "set_event_handler":
			event = args.get("event")
			block.setdefault("componentEvents", {})[event] = {
				"event": event,
				"action": "Run Script",
				"script": args.get("script") or "",
			}
			return f"Wired {event} handler on block {component_id}."
		block["visibilityCondition"] = wrap_expression(args.get("expression"))
		return f"Set visibility of block {component_id} to {{{{ {args.get('expression')} }}}}."

	# --- tree primitives --------------------------------------------------

	def resolve(self, component_id: str | None) -> dict | None:
		return find_block(self.root, component_id) if (self.root and component_id) else None

	def parent_of(self, component_id: str) -> dict | None:
		for block, _ in walk_blocks(self.root):
			for child in child_blocks(block):
				if child.get("componentId") == component_id:
					return block
		return None

	def detach(self, component_id: str) -> None:
		"""Remove the block from its parent — whether it sits in `children` or in a named slot."""
		parent = self.parent_of(component_id)
		if parent is None:
			return
		if parent.get("children"):
			parent["children"] = [c for c in parent["children"] if c.get("componentId") != component_id]
		for slot in (parent.get("componentSlots") or {}).values():
			content = slot.get("slotContent") if isinstance(slot, dict) else None
			if isinstance(content, list):
				slot["slotContent"] = [c for c in content if c.get("componentId") != component_id]

	def insert_child(self, parent: dict, block: dict, after_id: str | None, index: int | None) -> None:
		"""Place `block` in the parent's children: after the named sibling, at the index,
		or appended — the same precedence the editor's dispatcher uses."""
		children = parent.setdefault("children", [])
		if after_id:
			for position, sibling in enumerate(children):
				if sibling.get("componentId") == after_id:
					children.insert(position + 1, block)
					return
		if isinstance(index, int) and 0 <= index <= len(children):
			children.insert(index, block)
			return
		children.append(block)

	def id_hint(self, component_id: str | None) -> str:
		"""The model often passes a block's HTML id (attributes.id) instead of its
		editor ref — the most common miss. When the id matches a real block, name its
		ref."""
		for block, _ in walk_blocks(self.root or {}):
			attrs = block.get("attributes") or {}
			if component_id and attrs.get("id") == component_id:
				return (
					f" — that's the HTML id; this block's ref is '{block.get('componentId')}'. Use the ref."
				)
		return " — not a valid ref. Call query_blocks or re-read the page outline for real refs."


def wrap_expression(expression) -> str:
	"""Wrap a raw expression in `{{ }}` unless the model already included braces —
	mirrors the editor's wrapExpression."""
	expr = str(expression or "").strip()
	return expr if "{{" in expr else f"{{{{ {expr} }}}}"

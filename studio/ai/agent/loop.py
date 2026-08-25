"""The single agentic loop for Studio AI.

`AgentRunner` holds the per-request state, builds the message list, and drives
one tool-calling loop until the model stops requesting server/terminal tools.
Tool *behaviour* lives in the registry; this file only orchestrates.

The server is authoritative for every turn: the page is loaded from the DB into a
mutating `WorkingTree`, ops are applied there first and persisted after each round,
and only the accepted ops are mirrored to the editor canvas (a live view, not a
second writer). Ops the tree rejects are never emitted, so canvas and draft can't
diverge.

Realtime event contract (consumed by the frontend). Every event name is
suffixed with the SESSION id, e.g. `ai_chat_stream_<session_id>` — the chat
follows the conversation, not the page, so the panel keeps receiving a running
turn across navigation:

    ai_chat_progress    {message}
    ai_chat_stream      {chunk}      append to the chat reply text
    ai_chat_tool_batch  {operations: [{tool_name, args}], modified}   mirror on the canvas
    ai_chat_page        {action: created|focused|updated, page_name, page_title, route, modified}
    ai_chat_complete    {message}
    ai_chat_error       {message}

All events also carry {target_page_id} — the page this turn is editing. The
editor mirrors canvas events only when that page is the one it shows. `modified`
is the draft's timestamp after the server persisted the batch — the editor
adopts it so its next manual save doesn't raise a stale-write conflict.
"""

import json
import logging
import time

import frappe

from studio.ai import llm
from studio.ai.agent import locks
from studio.ai.agent.registry import get_tool_registry_for_mode
from studio.ai.agent.tree import WorkingTree
from studio.ai.block_codec import BlockCodec
from studio.ai.models import ModelRegistry
from studio.ai.prompts import get_system_prompt_for_mode
from studio.ai.session import AISession

logger = frappe.logger("studio.ai.agent.loop")
logger.setLevel(logging.INFO)

# One turn may span several rounds: server-tool reads plus a model that applies a
# change in batches. High enough to finish a big multi-block edit, bounded so a runaway
# loop can't spin.
MAX_ROUNDS = 40
EVENT_PREFIX = "ai_chat"

# A streaming round is retried on transient failure (litellm can't fall back mid-stream).
# Backoff is STREAM_BACKOFF_BASE * 2**attempt → ~1s, 2s before the final give-up.
STREAM_MAX_ATTEMPTS = 3
STREAM_BACKOFF_BASE = 1.0


class CancelledError(Exception):
	"""Raised inside the stream loop when the user cancels the turn."""


class AgentRunner:
	def __init__(
		self,
		prompt: str,
		model: str,
		api_key: str,
		*,
		user: str | None = None,
		page_id: str | None = None,
		app_id: str | None = None,
		session_id: str | None = None,
		selected_block_ids: list[str] | None = None,
		image_url: str | None = None,
	):
		self.prompt = prompt
		self.model = model
		self.api_key = api_key
		self.user = user or frappe.session.user
		self.page_id = page_id
		self.app_id = app_id or (
			frappe.db.get_value("Studio Page", page_id, "studio_app") if page_id else None
		)
		self.session_id = session_id
		self.locked_pages: set[str] = set()
		self.selected_block_ids = selected_block_ids or []
		# An optional screenshot/design (base64 data URL) to reproduce; attached to this turn's
		# user message so the model can see it (see build_messages).
		self.image_url = image_url
		is_standard = self.is_standard()
		self.registry = get_tool_registry_for_mode(is_standard)
		self.system_prompt = get_system_prompt_for_mode(is_standard)
		self.tree: WorkingTree | None = None
		# Screenshots queued by preview_page this round — flushed as a follow-up user
		# message after the tool results (tool results can't carry image parts).
		self.pending_images: list[dict] = []
		self.preview_counts: dict[str, int] = {}  # previews taken per page this turn

	def is_standard(self) -> bool:
		if not self.page_id:
			return False
		return bool(frappe.db.get_value("Studio Page", self.page_id, "is_standard"))

	# --- cancellation -----------------------------------------------------

	def _cancel_key(self) -> str | None:
		return f"studio_ai_cancel:{self.session_id}" if self.session_id else None

	def is_cancelled(self) -> bool:
		key = self._cancel_key()
		# use_local_cache=False is critical: the cancel is set by a DIFFERENT web worker,
		# and Frappe's per-request local cache would otherwise pin the first (miss) result.
		return bool(frappe.cache.get_value(key, use_local_cache=False)) if key else False

	def clear_cancel_flag(self) -> None:
		if key := self._cancel_key():
			frappe.cache.delete_value(key)

	def interruptible_sleep(self, seconds: float) -> None:
		"""Sleep in small steps so a cancel during retry backoff is honored within ~0.25s."""
		waited = 0.0
		while waited < seconds:
			if self.is_cancelled():
				raise CancelledError
			step = min(0.25, seconds - waited)
			time.sleep(step)
			waited += step

	# --- realtime ---------------------------------------------------------

	def emit(self, suffix: str, **kwargs):
		event = f"{EVENT_PREFIX}_{suffix}"
		if self.session_id:
			event = f"{event}_{self.session_id}"
		frappe.publish_realtime(event, {"target_page_id": self.page_id, **kwargs}, user=self.user)

	# --- page state -------------------------------------------------------

	def load_page_root(self) -> dict | None:
		"""The page's current working tree from the DB (draft wins over published). The
		editor flushes unsaved canvas changes before the turn starts, so this is exactly
		what the user sees."""
		if not self.page_id:
			return None
		draft, published = frappe.db.get_value("Studio Page", self.page_id, ["draft_blocks", "blocks"])
		try:
			data = json.loads(draft or published or "[]")
		except (json.JSONDecodeError, TypeError):
			return None
		if isinstance(data, list):
			data = data[0] if data else None
		return data if isinstance(data, dict) else None

	def persist_tree(self) -> str | None:
		"""Write the working tree as the page's draft and checkpoint-commit, so a cancelled
		or crashed turn keeps every applied round. `set_value`, not doc.save: the server owns
		the draft during a turn; the editor's own saves are stamp-guarded against it (see
		StudioPage.reject_if_stale). Returns the new modified stamp for the editor to adopt."""
		if not (self.page_id and self.tree and self.tree.root):
			return None
		# End the read transaction first: a generation stream keeps this worker's snapshot
		# open for minutes, and any concurrent save of the page (editor autosave, disk sync)
		# makes the UPDATE fail with 1020 "record has changed since last read". A fresh
		# transaction sees the current row; retry once more if a writer still races us —
		# the tree is authoritative and must land regardless.
		frappe.db.commit()
		try:
			frappe.db.set_value(
				"Studio Page", self.page_id, "draft_blocks", BlockCodec.to_json([self.tree.root])
			)
		except frappe.QueryDeadlockError:
			frappe.db.rollback()
			frappe.db.set_value(
				"Studio Page", self.page_id, "draft_blocks", BlockCodec.to_json([self.tree.root])
			)
		frappe.db.commit()
		return str(frappe.db.get_value("Studio Page", self.page_id, "modified"))

	def page_root(self) -> dict | None:
		"""The LIVE root of this turn's working tree — server tools read page state through
		this, so they see edits already applied earlier in the turn."""
		return self.tree.root if self.tree else None

	def focus_page(self, page_id: str) -> str | None:
		"""Re-point the turn at another page: take its run lock, release the old one, load
		its tree, and re-resolve the toolset + system prompt for its mode (custom pages and
		standard pages carry different tools). Returns an error string when another chat
		holds the page, None on success."""
		if page_id == self.page_id:
			return None
		if self.session_id and locks.acquire_page_lock(page_id, self.session_id):
			return (
				f"page '{page_id}' is being edited by another AI chat right now — "
				"finish or cancel that chat first, or work on a different page."
			)
		if self.page_id and self.session_id:
			locks.release_page_lock(self.page_id, self.session_id)
			self.locked_pages.discard(self.page_id)
		self.locked_pages.add(page_id)
		self.page_id = page_id
		self.tree = WorkingTree(self.load_page_root())
		is_standard = self.is_standard()
		self.registry = get_tool_registry_for_mode(is_standard)
		self.system_prompt = get_system_prompt_for_mode(is_standard)
		if self.session_id:
			frappe.db.set_value(AISession.DOCTYPE, self.session_id, "page", page_id, update_modified=False)
			# Commit NOW, not at the next persist: an editor that (re)loads mid-turn reads
			# this pointer (get_ai_session.page) to decide whose autosave stands down and
			# which page to show as building — the next persist can be a generation away.
			frappe.db.commit()
		return None

	def release_locks(self) -> None:
		if not self.session_id:
			return
		for page_id in self.locked_pages:
			locks.release_page_lock(page_id, self.session_id)
		self.locked_pages.clear()

	def flush_pending_images(self, messages: list[dict]) -> None:
		"""Screenshots queued by preview_page ride a follow-up USER message after the
		round's tool results — the OpenAI tool-result shape can't carry image parts."""
		if not self.pending_images:
			return
		content: list[dict] = []
		for image in self.pending_images:
			content.append({"type": "text", "text": image["caption"]})
			content.append({"type": "image_url", "image_url": {"url": image["data_url"]}})
		messages.append({"role": "user", "content": content})
		self.pending_images = []

	# --- message construction --------------------------------------------

	def build_page_context(self) -> str:
		root = self.page_root()
		if root is None:
			return ""
		structure = BlockCodec.to_json(BlockCodec.compress(root))
		return f"Current page structure (JSON — pass a block's 'id' value as component_id to edit it):\n{structure}"

	def build_messages(self) -> list[dict]:
		messages: list[dict] = [
			{"role": "system", "content": self.system_prompt, "cache_control": {"type": "ephemeral"}},
		]
		if page_context_message := self.build_page_context():
			# Cache the page structure too (the system prompt is the other breakpoint): it's
			# the largest stable block, resent every round of a multi-round edit, so caching
			# it cuts both latency and input cost across the loop.
			messages.append(
				{"role": "user", "content": page_context_message, "cache_control": {"type": "ephemeral"}}
			)
			messages.append(
				{
					"role": "assistant",
					"content": "Understood. I have the current page structure. What would you like me to change?",
				}
			)
		# Prior conversation as proper role-tagged turns (the model handles dialogue better
		# and we save the "User:"/"Assistant:" prefix tokens on every call).
		messages.extend(AISession.build_context_messages_from_id(self.session_id))
		user_text = self.prompt
		if self.selected_block_ids:
			user_text += f"\n\n(User has selected: {', '.join(self.selected_block_ids)})"
		if self.image_url and ModelRegistry.is_vision_capable(self.model):
			# Multimodal message: the model sees the attached screenshot alongside the prompt.
			messages.append(
				{
					"role": "user",
					"content": [
						{"type": "text", "text": user_text},
						{"type": "image_url", "image_url": {"url": self.image_url}},
					],
				}
			)
		else:
			messages.append({"role": "user", "content": user_text})
		return messages

	# --- LLM call ---------------------------------------------------------

	def call_tool_llm(self, messages: list[dict]) -> tuple[list[dict], str, list[dict]]:
		"""Stream one tool-calling round, retrying the WHOLE round on a transient stream
		failure. Safe because a round applies nothing until it returns — ops are emitted and
		`messages` mutated by the caller only after this returns, so a failed attempt leaves
		no partial state; we just re-issue the identical completion (the cached prefix makes
		the retry cheap). litellm can't fall back mid-stream, so this is the retry layer."""
		for attempt in range(STREAM_MAX_ATTEMPTS):
			try:
				return self.stream_tool_round(messages)
			except CancelledError:
				raise
			except Exception as exc:
				if attempt == STREAM_MAX_ATTEMPTS - 1 or not llm.is_retryable(exc):
					raise
				backoff = STREAM_BACKOFF_BASE * (2**attempt)
				logger.warning(
					"Stream round failed (attempt %d/%d): %s — retrying in %.1fs",
					attempt + 1,
					STREAM_MAX_ATTEMPTS,
					exc,
					backoff,
				)
				self.interruptible_sleep(backoff)

	def stream_tool_round(self, messages: list[dict]) -> tuple[list[dict], str, list[dict]]:
		"""Stream one tool-calling completion. Returns (tool_operations, text_content,
		raw_tool_calls). Side-effect-free until it returns (see call_tool_llm) — accumulates
		into locals only, so it is safe to re-run. Tool-call arguments are accumulated by
		index across chunks."""
		stream = llm.complete_with_tools(
			self.model,
			messages,
			self.registry.schemas(),
			llm.TASK_PARAMS["agent"],
			api_key=self.api_key,
			stream=True,
		)

		content_parts: list[str] = []
		# index -> {"id", "name", "args"}; preserves call order across chunks.
		acc: dict[int, dict] = {}
		finish_reason = None

		for chunk in stream:
			if self.is_cancelled():
				try:
					stream.close()
				except Exception:
					pass
				raise CancelledError
			# The final include_usage chunk carries usage but no choices.
			if not chunk.choices:
				continue
			if fr := chunk.choices[0].finish_reason:
				finish_reason = fr
			delta = chunk.choices[0].delta
			if getattr(delta, "content", None):
				content_parts.append(delta.content)
			for tc in getattr(delta, "tool_calls", None) or []:
				idx = tc.index if tc.index is not None else 0
				entry = acc.setdefault(idx, {"id": None, "name": None, "args": ""})
				if tc.id:
					entry["id"] = tc.id
				fn = getattr(tc, "function", None)
				if fn and fn.name:
					entry["name"] = fn.name
				if fn and fn.arguments:
					entry["args"] += fn.arguments

		tool_operations: list[dict] = []
		raw_tool_calls: list[dict] = []
		for idx in sorted(acc):
			entry = acc[idx]
			if not entry["name"]:
				continue
			raw_arguments = entry["args"] or ""
			parsed, repaired = llm.loads_tolerant(raw_arguments)
			args = parsed if isinstance(parsed, dict) else {}
			if parsed is None:
				logger.warning("AI tool args UNPARSEABLE (tool=%s): %s", entry["name"], raw_arguments[:2000])
			elif repaired:
				logger.warning("AI tool args recovered via json_repair (tool=%s)", entry["name"])
			tool_operations.append({"tool_name": entry["name"], "args": args})
			raw_tool_calls.append(
				{
					"id": entry["id"],
					"type": "function",
					"function": {"name": entry["name"], "arguments": raw_arguments},
				}
			)

		content = "".join(content_parts)
		if finish_reason == "length":
			logger.warning("Agent LLM hit max_tokens (finish_reason=length) — tool args may be truncated")
		logger.info(
			"Agent LLM responded: tool_calls=%d, has_text=%s, finish_reason=%s",
			len(tool_operations),
			bool(content),
			finish_reason,
		)
		return tool_operations, content, raw_tool_calls

	@staticmethod
	def describe_operations(operations: list[dict]) -> str:
		"""A deterministic one-line summary of applied ops — used when the model didn't
		return its own summary text, so we avoid a second LLM round trip."""
		from collections import Counter

		counts = Counter(op.get("tool_name") for op in operations)

		def blk(n: int) -> str:
			return "block" if n == 1 else "blocks"

		if counts.get("generate_page"):
			return (
				"Created the page. Ask me to refine it — adjust styles, add sections, or change the layout."
			)

		# update_blocks edits many blocks in one op — count the blocks it touched.
		batched = 0
		for op in operations:
			if op.get("tool_name") != "update_blocks":
				continue
			args = op.get("args") or {}
			patches = args.get("patches")
			batched += len(patches) if isinstance(patches, list) else len(args.get("component_ids") or [])

		parts: list[str] = []
		if n := (counts.get("update_block", 0) + batched):
			parts.append(f"updated {n} {blk(n)}")
		if n := counts.get("add_block"):
			parts.append(f"added {n} {blk(n)}")
		if n := counts.get("remove_block"):
			parts.append(f"removed {n} {blk(n)}")
		if n := counts.get("move_block"):
			parts.append(f"moved {n} {blk(n)}")
		if n := (counts.get("bind_prop", 0) + counts.get("set_repeater_data", 0)):
			parts.append(f"wired {n} binding{'s' if n != 1 else ''}")

		if not parts:
			n = len(operations)
			return f"Applied {n} change{'s' if n != 1 else ''} to the page."
		sentence = parts[0] if len(parts) == 1 else f"{', '.join(parts[:-1])} and {parts[-1]}"
		return sentence[0].upper() + sentence[1:] + "."

	# --- orchestration ----------------------------------------------------

	def run(self):
		# Clear any stale cancel flag from a previous turn before starting.
		self.clear_cancel_flag()
		label = ModelRegistry.get_label(self.model)
		self.emit("progress", message=f"Thinking with {label}…" if label else "Thinking…")

		if self.session_id and AISession.is_session_running(self.session_id):
			logger.warning("AgentRunner.run: session %s already running, rejecting", self.session_id)
			self.emit(
				"error", message="Another AI request is still processing. Please wait for it to finish."
			)
			return
		self._set_running(True)

		# One page has one AI writer: take the focus page's run lock before touching it.
		# Another chat holding it gets a clear refusal, not a corrupted draft.
		if self.page_id and self.session_id:
			if locks.acquire_page_lock(self.page_id, self.session_id):
				self._set_running(False)
				msg = "Another AI chat is editing this page right now. Wait for it to finish or cancel it."
				AISession.try_append_message(
					self.session_id, "assistant", msg, message_type="status", metadata={"status": "error"}
				)
				frappe.db.commit()
				self.emit("error", message=msg)
				return
			self.locked_pages.add(self.page_id)

		# The authoritative page tree this turn: loaded from the DB, mutated by block ops,
		# persisted after every round (see WorkingTree).
		self.tree = WorkingTree(self.load_page_root())
		messages = self.build_messages()
		client_operations: list[dict] = []
		summary_text = ""

		try:
			for _round in range(MAX_ROUNDS):
				# focus_page may have swapped the mode's system prompt mid-turn.
				messages[0]["content"] = self.system_prompt
				tool_operations, summary_text, raw_tool_calls = self.call_tool_llm(messages)

				# A terminal tool ends the turn and hands control back to the user. If the
				# model emits more than one, the first wins (the turn is over). A terminal
				# handler may instead RETURN a string to refuse the call (e.g. an invalid
				# write proposal) — feed it back as the tool result and keep looping so the
				# model can fix and retry within the turn. Other ops in the refused round
				# are dropped (terminal tools must be called alone), so respond to just
				# the one tool call.
				if terminal_ops := self._terminal_ops(tool_operations):
					refusal = self.handle_terminal(terminal_ops[0])
					if refusal is None:
						return
					index = tool_operations.index(terminal_ops[0])
					messages.append(
						{
							"role": "assistant",
							"content": summary_text or None,
							"tool_calls": [raw_tool_calls[index]],
						}
					)
					messages.append(
						{"role": "tool", "tool_call_id": raw_tool_calls[index]["id"], "content": refusal}
					)
					continue

				# Apply this round in call order: server tools run their handler, block ops
				# mutate the working tree, generation streams + replaces it (the loop keeps
				# going after — a multi-page turn generates, refocuses, generates again).
				# Only accepted ops (no "FAILED" result) reach the canvas; every result
				# feeds back so the model can continue or self-correct.
				accepted, results = self.apply_round(tool_operations, client_operations)
				if accepted:
					client_operations.extend(accepted)
					self.emit("tool_batch", operations=accepted, modified=self.persist_tree())

				# Live narration: surface what the model said / did THIS round.
				if tool_operations:
					note = (summary_text or "").strip() or (
						self.describe_operations(accepted) if accepted else ""
					)
					if note:
						self.emit("progress", message=note)

				# The model ENDS the turn by replying with a final summary and NO tool calls.
				if not tool_operations:
					break

				messages.append(
					{"role": "assistant", "content": summary_text or None, "tool_calls": raw_tool_calls}
				)
				for tc_dict, content in zip(raw_tool_calls, results, strict=True):
					messages.append({"role": "tool", "tool_call_id": tc_dict["id"], "content": content})
				self.flush_pending_images(messages)

		except CancelledError:
			self._emit_cancelled()
			return
		except Exception as e:
			logger.error(f"Agent LLM call failed: {e!s}", exc_info=True)
			frappe.log_error(f"Agent LLM call failed: {e}", "AgentRunner.run")
			# Show a generic message — raw provider/exception strings can leak internals.
			user_msg = "Something went wrong while building your changes. Please try again."
			AISession.try_append_message(
				self.session_id, "assistant", user_msg, message_type="status", metadata={"status": "error"}
			)
			frappe.db.commit()  # commit before emit so the client's reload sees it
			self.emit("error", message=user_msg)
			return
		finally:
			self.clear_cancel_flag()
			self._set_running(False)
			self.release_locks()

		if not client_operations and not summary_text:
			logger.warning("Agent returned empty response (no tools, no text)")
			self.emit("error", message="The AI returned an empty response. Please try rephrasing.")
			return

		# The block edits were already emitted incrementally inside the loop. If the model
		# wrote no summary, synthesise one from the ops rather than making a second LLM call.
		if not summary_text:
			summary_text = self.describe_operations(client_operations)
		self.emit("stream", chunk=summary_text)

		AISession.try_append_message(
			self.session_id,
			"assistant",
			summary_text or "Done",
			message_type="chat",
			task_type="agent",
			metadata={"status": "complete", "model": self.model, "operations": len(client_operations)},
		)
		frappe.db.commit()  # commit before emit so the client's reload sees the final turn
		self.emit("complete", message=summary_text or "Done")

	def _terminal_ops(self, tool_operations: list[dict]) -> list[dict]:
		return [op for op in tool_operations if self.registry.side(op["tool_name"]) == "terminal"]

	def apply_round(
		self, tool_operations: list[dict], applied_log: list[dict]
	) -> tuple[list[dict], list[str]]:
		"""Run one round's ops in call order against the server state. An artifact op
		(generate_page) streams on the heavy model, replaces + persists the working tree
		(adopt_generated emits its own batch) and is recorded in `applied_log`. Returns
		(accepted block ops for the round's canvas batch, one tool result per op)."""
		accepted: list[dict] = []
		results: list[str] = []
		for op in tool_operations:
			tool = self.registry.get(op["tool_name"])
			if tool and tool.artifact and tool.generator:
				generated = self.adopt_generated(tool.generator(self, op["args"]))
				applied_log.extend(generated)
				results.append(
					"Generated and persisted the page — it replaces the previous structure. "
					"Continue with any remaining work, or finish with a one-line summary."
					if generated
					else "FAILED: generation produced no usable page. Retry with a clearer brief."
				)
				continue
			if tool and tool.side == "server" and tool.handler:
				results.append(tool.handler(self, op["args"]))
				continue
			content = self.tree.apply(op["tool_name"], op["args"])
			if content.startswith("FAILED"):
				# A correction the model is now being asked to make. Log so it's not invisible.
				logger.warning("Block op rejected — %s: %s", op["tool_name"], content)
			else:
				accepted.append(op)
				if "NOT FOUND" in content:
					logger.warning("Block op partially applied — %s: %s", op["tool_name"], content)
			results.append(content)
		return accepted, results

	def adopt_generated(self, ops: list[dict]) -> list[dict]:
		"""Make a generator's output the page: stamp ids on the generated tree, point the
		working tree at it (so later rounds could edit it), persist, and mirror the op —
		the authoritative apply that replaces the client's throwaway streamed preview."""
		for op in ops:
			if isinstance(op.get("args", {}).get("block"), dict):
				self.tree = WorkingTree(BlockCodec.ensure_ids(op["args"]["block"]))
		if ops:
			self.emit("tool_batch", operations=ops, modified=self.persist_tree())
		return ops

	def _set_running(self, running: bool) -> None:
		if not self.session_id:
			return
		try:
			session = AISession(frappe.get_doc(AISession.DOCTYPE, self.session_id))
			session.set_running() if running else session.clear_running()
			frappe.db.commit()  # visible to other workers' concurrency guard
		except Exception:
			pass

	def _emit_cancelled(self) -> None:
		msg = "Cancelled."
		AISession.try_append_message(
			self.session_id, "assistant", msg, message_type="status", metadata={"status": "cancelled"}
		)
		frappe.db.commit()
		self.emit("complete", message=msg)

	def handle_terminal(self, op: dict) -> str | None:
		"""Run a terminal tool's handler (which emits the appropriate event and persists
		the message). Terminal tools register a handler. None means the turn is over; a
		string is a refusal the caller feeds back to the model (see run)."""
		tool = self.registry.get(op["tool_name"])
		if tool and tool.handler:
			return tool.handler(self, op["args"])
		return None


def run_agent_job(prompt: str, model: str, **kwargs):
	# The key is resolved HERE, not passed through enqueue kwargs — those sit in
	# Redis and get dumped verbatim into worker logs when a job fails.
	from studio.ai.api import resolve_api_key

	api_key = resolve_api_key(model)
	AgentRunner(prompt, model, api_key, **kwargs).run()

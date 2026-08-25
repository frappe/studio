"""Whitelisted endpoints for the Studio AI agent.

A single conversational entry point — `run` — drives the unified agent loop for
one user turn (generation and editing alike). `cancel` requests that a running turn
abort at its next stream chunk. Sessions are APP-scoped: a chat follows the user
across the app's pages, with the open page as the turn's target (the session's
`page` records the current focus). An app holds several parallel chat sessions per
user: `get_ai_session` loads one, `new_ai_session` starts one, `list_app_ai_sessions`
powers the switcher and `delete_ai_session` removes one for good.
"""

import json
import logging

import frappe
from frappe import _

from studio.ai.agent.loop import run_agent_job
from studio.ai.block_codec import BlockCodec
from studio.ai.models import ModelRegistry
from studio.ai.session import AISession
from studio.utils import has_page_write_perm

logger = frappe.logger("studio.ai.api")
logger.setLevel(logging.INFO)


def resolve_app(page_id: str) -> str:
	"""The Studio App a page belongs to — the scope its AI sessions live under."""
	app_id = frappe.db.get_value("Studio Page", page_id, "studio_app")
	if not app_id:
		frappe.throw(_("Page {0} does not belong to a Studio app").format(page_id))
	return str(app_id)


def resolve_api_key(model: str | None = None) -> str:
	"""The key to call `model` with: the one stored on its provider. OAuth
	providers (codex) carry their own credential and need no key here. A local
	gateway with no key at all is fine too — litellm sends what it gets."""
	if model:
		from studio.ai.llm import codex_route, provider_api_key

		if codex_route(model):
			return ""
		info = ModelRegistry.find(model)
		if info:
			if key := provider_api_key(info):
				return key
			# A self-hosted gateway (api_base set) often needs no key at all;
			# a hosted provider without one can't be called.
			if info.get("api_base"):
				return ""
			frappe.throw(_("Add an API key for {0} in the AI providers dialog").format(info["provider"]))
	frappe.throw(_("Connect an AI provider to use the assistant"))


@frappe.whitelist()
@has_page_write_perm()
def run(
	prompt: str,
	page_id: str,
	model: str | None = None,
	session_id: str | None = None,
	selected_block_ids: list | str | None = None,
	image_data: str | None = None,
):
	"""Single entry point: run the agent for one user turn. The page state is read from the
	DB (the editor flushes unsaved canvas changes before calling this), edited server-side,
	and mirrored to the canvas — the client sends no page context. `image_data` is an
	optional base64 image data URL (a screenshot/design) the model should reproduce."""
	logger.info(f"run: page_id={page_id}, model={model}")

	resolved_model = ModelRegistry.get_default(model)
	# Fail fast when nothing is configured — but the key itself is re-resolved
	# INSIDE the job: enqueue kwargs sit in Redis and get dumped verbatim into
	# worker logs on failure, which is no place for a secret.
	resolve_api_key(resolved_model)

	image_url = BlockCodec.validate_image_data(image_data) if image_data else None

	app_id = resolve_app(page_id)
	# The panel says which of the app's sessions this turn belongs to; a stale id
	# (session deleted elsewhere) falls back to the app's current session.
	if session_id and frappe.db.exists(AISession.DOCTYPE, session_id):
		session = AISession.get(session_id, app_id=app_id)
	else:
		session = AISession.get_or_create(app_id, resolved_model, page_id=page_id)
	if AISession.is_session_running(session.name):
		frappe.local.response.http_status_code = 429
		return {"status": "busy", "message": _("Another AI request is still processing. Please wait.")}
	# The open page becomes this turn's target; record it so a reloaded editor knows
	# where a running turn's edits are landing. The model choice sticks to the chat too.
	session.set_focus_page(page_id)
	session.set_selected_model(resolved_model)
	# Typing a new message instead of answering an approval card supersedes it.
	session.expire_pending_actions()

	# Store the image on the user message so the chat thread can show a thumbnail on reload.
	msg_meta = {"attachedImageUrl": image_url} if image_url else None
	session.append_message("user", prompt, message_type="chat", task_type="agent", metadata=msg_meta)

	# Background queue (not now=True): a streaming turn can run for tens of seconds, and
	# now=True would hold this web worker open for the whole stream — exhausting the worker
	# pool under concurrency. Realtime events flow over Redis pub/sub regardless of process.
	frappe.enqueue(
		run_agent_job,
		queue="long",
		timeout=600,
		prompt=prompt,
		model=resolved_model,
		user=frappe.session.user,
		page_id=page_id,
		app_id=app_id,
		session_id=session.name,
		selected_block_ids=_parse_block_ids(selected_block_ids),
		image_url=image_url,
	)
	frappe.local.response.http_status_code = 202
	return {"status": "accepted", "session_id": session.name}


@frappe.whitelist()
@has_page_write_perm()
def cancel(session_id: str):
	"""Request that the currently-running turn for this session abort at its next stream
	chunk. The loop closes the LLM stream — Anthropic / OpenRouter stop billing for further
	tokens once the connection drops."""
	if session_id:
		frappe.cache.set_value(f"studio_ai_cancel:{session_id}", "1", expires_in_sec=300)
	return {"status": "ok"}


@frappe.whitelist()
@has_page_write_perm()
def confirm_pending_action(session_id: str, message_id: str, decision: str = "approve"):
	"""Apply (or skip) a sensitive action the agent proposed. The privileged write runs
	HERE, on this user-triggered request — never inside the model's turn. Reads the
	stored payload off the pending-action message and dispatches by its whitelisted
	kind (agent/approvals.py), then resumes the agent so it carries on with the plan."""
	from studio.ai.agent.approvals import apply_pending_action

	session = AISession.get(session_id)  # asserts ownership
	row = frappe.db.get_value(
		AISession.MESSAGE_DOCTYPE, message_id, ["session", "status", "metadata_json"], as_dict=True
	)
	if not row or row.session != session.name:
		frappe.throw(_("Pending action not found"))
	if row.status != "pending_action":
		frappe.throw(_("This action was already resolved"))

	if decision != "approve":
		frappe.db.set_value(
			AISession.MESSAGE_DOCTYPE, message_id, "status", "action_skipped", update_modified=False
		)
		outcome = _("Skipped — nothing was changed.")
	else:
		meta = frappe.parse_json(row.metadata_json or "{}") or {}
		outcome = apply_pending_action(meta.get("kind"), meta.get("payload") or {})
		frappe.db.set_value(
			AISession.MESSAGE_DOCTYPE, message_id, "status", "action_applied", update_modified=False
		)
	# The outcome joins the conversation: visible in the chat after a reload, and
	# context for the agent's later turns (it knows what was applied or declined).
	session.append_message("assistant", outcome, message_type="chat", task_type="agent")
	# Commit NOW, not at request end: applying a backend write restarts the dev server,
	# which can kill this request before the auto-commit — leaving the file on disk but
	# the card still pending. (apply is idempotent, so a re-approve after that heals.)
	frappe.db.commit()
	resumed = resume_after_action(session, outcome)
	return {
		"status": "applied" if decision == "approve" else "skipped",
		"message": outcome,
		"resumed": resumed,
	}


def resume_after_action(session: AISession, outcome: str) -> bool:
	"""Carry on once a confirm-gated action has been decided. A card authorises one
	step, it doesn't change the plan — ending there would leave the user typing
	"continue" to re-trigger the job. Best effort: the decision is already recorded
	and must not be undone by a queue failure."""
	if AISession.is_session_running(session.name) or not session.page:
		return False
	try:
		model = ModelRegistry.get_default(session.selected_model or None)
		resolve_api_key(model)
		frappe.enqueue(
			run_agent_job,
			queue="long",
			timeout=600,
			# run_agent_job doesn't persist its prompt, so no phantom "continue" in the chat.
			prompt=f"{outcome}\n\nContinue with what you were doing. Do not repeat this step.",
			model=model,
			user=frappe.session.user,
			page_id=session.page,
			app_id=session.app,
			session_id=session.name,
		)
		return True
	except Exception:
		logger.warning(f"could not resume session {session.name} after a confirmed action", exc_info=True)
		return False


@frappe.whitelist()
@has_page_write_perm()
def get_ai_session(app_id: str, model: str | None = None, session_id: str | None = None) -> dict:
	"""With `session_id`, that specific chat; without, the app's most recently
	used one (creating the first if none exist)."""
	if session_id and frappe.db.exists(AISession.DOCTYPE, session_id):
		session = AISession.get(session_id, app_id=app_id)
	else:
		session = AISession.get_or_create(app_id, model)
	# Return the session id so the client can cancel a turn it didn't start itself — e.g. when a
	# page is opened while a previously-launched turn is still running in the background.
	# `is_running` + `page` (the running turn's target) let a freshly-(re)loaded editor stand
	# its autosave down when the build is landing on the page it shows: the server owns that
	# draft while the turn runs, and a reload wipes the client-side flag.
	return {
		"session_id": session.name,
		"messages": session.get_messages(),
		"selected_model": session.selected_model or "",
		"is_running": AISession.is_session_running(session.name),
		"page": session.page or "",
	}


@frappe.whitelist()
@has_page_write_perm()
def get_active_build(session_id: str) -> dict | None:
	"""The in-flight generate_page stream for this session (see artifact.save_stream_buffer),
	so an editor that loads or refreshes mid-build replays the live preview. None when the
	session isn't mid-generation."""
	from studio.ai.agent.artifact import stream_buffer_key

	AISession.get(session_id)  # asserts ownership
	raw = frappe.cache.get_value(stream_buffer_key(session_id), use_local_cache=False)
	return frappe.parse_json(raw) if raw else None


@frappe.whitelist()
@has_page_write_perm()
def new_ai_session(app_id: str, model: str | None = None) -> dict:
	"""Start a fresh chat on this app — existing sessions stay untouched and
	switchable. An empty session the user never used IS a fresh chat, so hand that
	back rather than stacking up another: a few taps of New chat would otherwise
	fill the switcher with identical blank entries."""
	for name in frappe.get_all(
		AISession.DOCTYPE, filters={"app": app_id, "user": frappe.session.user}, pluck="name"
	):
		if not frappe.db.count(AISession.MESSAGE_DOCTYPE, {"session": name}):
			return {"session_id": name, "messages": []}
	session = AISession.create(app_id, model)
	return {"session_id": session.name, "messages": []}


@frappe.whitelist()
@has_page_write_perm()
def list_app_ai_sessions(app_id: str, limit: int = 20) -> list:
	"""This app's chats for the current user — powers the session switcher.
	A chat is titled by its first user message."""
	rows = frappe.get_all(
		AISession.DOCTYPE,
		filters={"app": app_id, "user": frappe.session.user},
		fields=["name", "last_interaction_on"],
		order_by="last_interaction_on desc",
		limit=min(int(limit), 50),
	)
	for row in rows:
		row["title"] = frappe.db.get_value(
			AISession.MESSAGE_DOCTYPE,
			{"session": row["name"], "role": "user"},
			"content",
			order_by="creation asc",
		)
	return rows


@frappe.whitelist()
@has_page_write_perm()
def delete_ai_session(session_id: str) -> dict:
	AISession.get(session_id)  # asserts ownership
	# The session's on_trash takes its messages with it.
	frappe.delete_doc(AISession.DOCTYPE, session_id, ignore_permissions=True)
	return {"status": "ok"}


def _parse_block_ids(selected_block_ids: list | str | None) -> list[str]:
	if isinstance(selected_block_ids, str):
		try:
			selected_block_ids = json.loads(selected_block_ids)
		except (json.JSONDecodeError, TypeError):
			return []
	return selected_block_ids if isinstance(selected_block_ids, list) else []

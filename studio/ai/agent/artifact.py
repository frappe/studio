"""Artifact generators — produce a large streamed artifact for a tool.

An *artifact tool* (one that sets `artifact=` on its `Tool`) delegates its
execution to a generator here. The generator runs on the user's selected *heavy*
model and streams the artifact to the client as plain content — reliable, unlike
tool-call argument streaming, which providers buffer (the canvas would stay blank
for the whole completion). After streaming, it returns the canonical client op for
the loop to emit so the frontend applies the authoritative, fully-parsed result.

The agent calling the tool is the only trigger: when the fast conversational model
decides to build the page, it calls `generate_page(brief=…)` and the loop hands off
here. No DB status or out-of-band heuristic gates generation.
"""

import logging

import frappe

from studio.ai import llm
from studio.ai.agent.tools.introspect import describe_page_data
from studio.ai.block_codec import BlockCodec
from studio.ai.models import ModelRegistry
from studio.ai.prompts import GENERATION
from studio.ai.session import AISession

logger = frappe.logger("studio.ai.agent.artifact")
logger.setLevel(logging.INFO)


def generate_page_json(ctx, args: dict) -> list[dict]:
	"""Stream a complete page of block JSON on the heavy model, then return a
	`generate_page` client op carrying the authoritative parsed block tree.

	`ctx` is the AgentRunner. `args["brief"]` is the concise spec the conversational
	model assembled from the approved plan / conversation. Streams `kind="page_json"`
	chunks to the canvas as the model writes them. Returns [] if the model produced
	nothing.
	"""
	brief = (args.get("brief") or "").strip()

	messages: list[dict] = [
		{"role": "system", "content": GENERATION, "cache_control": {"type": "ephemeral"}},
	]
	# Prior conversation (incl. the approved plan) as proper role-tagged turns.
	messages.extend(AISession.build_context_messages_from_id(ctx.session_id))
	# The generator builds its own prompt, so it won't see data sources created earlier this
	# turn unless told — hand it the page's data state so it binds to real, existing sources.
	if data_note := _available_data_note(ctx):
		messages.append({"role": "user", "content": data_note})
	messages.append(_build_message(ctx, brief))

	ctx.emit("progress", message="Building the page…")

	# The stream is also snapshotted to Redis as it grows: an editor that (re)loads
	# mid-build pulls it via api.get_active_build and replays the preview. Everything
	# else about a running turn is already durable (messages + draft in the DB).
	page_title = frappe.db.get_value("Studio Page", ctx.page_id, "page_title") or ""
	content = ""
	buffered_at = 0
	finish_reason = None
	stream = llm.complete(ctx.model, messages, llm.TASK_PARAMS["complex"], stream=True, api_key=ctx.api_key)
	try:
		for chunk in stream:
			if ctx.is_cancelled():
				try:
					stream.close()
				except Exception:
					pass
				from studio.ai.agent.loop import CancelledError

				raise CancelledError
			if not chunk.choices:
				continue
			if fr := chunk.choices[0].finish_reason:
				finish_reason = fr
			delta = chunk.choices[0].delta.content
			if delta:
				# offset = position of this chunk in the artifact. The client resets its
				# preview buffer at 0 (a multi-page turn streams several generations) and
				# refills from the Redis snapshot when a chunk doesn't append cleanly.
				ctx.emit("stream", chunk=delta, kind="page_json", offset=len(content))
				content += delta
				if len(content) - buffered_at >= 512:
					buffered_at = len(content)
					save_stream_buffer(ctx, content, page_title)
	finally:
		# The buffer only serves mid-build (re)loads; once streaming ends, the
		# authoritative parsed op — or the turn's next generation — supersedes it.
		clear_stream_buffer(ctx.session_id)

	if finish_reason == "length":
		logger.warning("generate_page hit max_tokens — the page may be truncated")
	try:
		block = BlockCodec.parse_blocks(content)
	except Exception as e:
		logger.warning("generate_page_json: could not parse model output (model=%s): %s", ctx.model, e)
		return []

	return [{"tool_name": "generate_page", "args": {"block": block}}]


def stream_buffer_key(session_id: str) -> str:
	return f"studio_ai_build_stream:{session_id}"


def save_stream_buffer(ctx, content: str, page_title: str) -> None:
	"""Snapshot the in-flight generation stream (every ~512 chars) so an editor that
	loads or refreshes mid-build can replay the preview instead of a stale draft."""
	frappe.cache.set_value(
		stream_buffer_key(ctx.session_id),
		frappe.as_json({"content": content, "page_id": ctx.page_id, "page_title": page_title}),
		expires_in_sec=600,  # matches the job timeout — a dead run's buffer expires with it
	)


def clear_stream_buffer(session_id: str | None) -> None:
	if session_id:
		frappe.cache.delete_value(stream_buffer_key(session_id))


def _build_message(ctx, brief: str) -> dict:
	"""The final 'build' turn. When a screenshot is attached and the model can see it, send the
	image to the GENERATOR itself (not just the conversational model) so the block tree is produced
	from the actual pixels — far higher fidelity than reproducing the model's textual brief."""
	text = f"Build this page now:\n{brief}" if brief else "Build the page now."
	image_url = getattr(ctx, "image_url", None)
	if not image_url or not ModelRegistry.is_vision_capable(ctx.model):
		return {"role": "user", "content": text}
	text += (
		"\n\nReproduce the ATTACHED design faithfully: match its layout structure, section order, "
		"component choices, spacing, alignment, typography and colors (approximated with espresso tokens). "
		"The brief above is a summary — the image is the source of truth."
	)
	return {
		"role": "user",
		"content": [
			{"type": "text", "text": text},
			{"type": "image_url", "image_url": {"url": image_url}},
		],
	}


def _available_data_note(ctx) -> str:
	"""A message listing the data sources + variables already on the page, so the
	generator binds the layout to real, existing sources (per the DATA BINDING rules).
	Empty when the page has no data layer yet."""
	page = frappe.get_doc("Studio Page", ctx.page_id) if ctx.page_id else None
	if page is None:
		return ""
	state = describe_page_data(page)
	if not state["data_sources"] and not state["variables"]:
		return ""
	return (
		"Data sources and variables already created on this page — bind the layout to THESE "
		"(and only these), per the DATA BINDING rules:\n" + BlockCodec.to_json(state)
	)

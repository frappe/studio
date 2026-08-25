"""Whitelisted endpoints for the AI provider setup flow.

The setup wizard walks: pick a preset → verify the key with one real call →
save the provider and switch on models. The ChatGPT (Codex) preset signs in
with a browser round-trip instead of a key.
"""

import json
import logging

import frappe
from frappe import _

from studio.ai.models import ModelRegistry
from studio.utils import has_page_write_perm

logger = frappe.logger("studio.ai.setup")
logger.setLevel(logging.INFO)

NON_CHAT_MARKERS = ("embed", "embedding", "rerank", "reranker", "whisper", "tts", "moderation")


@frappe.whitelist()
@has_page_write_perm()
def ai_setup_state():
	"""What the setup flow needs to decide whether to run: the provider catalogue,
	and whether anything usable is already configured. Never returns a key."""
	from studio.ai import presets

	# An install that hasn't migrated has no provider table at all. Say so plainly
	# rather than raising behind a screen that then renders empty.
	if not frappe.db.exists("DocType", "Studio AI Provider"):
		return {"configured": False, "models": 0, "providers": 0, "needs_migrate": True, "presets": []}

	providers = frappe.get_all(
		"Studio AI Provider", filters={"enabled": 1}, fields=["name", "api_key", "api_base"]
	)
	# A key on any provider will do — and a self-hosted gateway (api_base set)
	# often needs none at all.
	has_key = any(p.api_key or p.api_base for p in providers)
	return {
		"configured": has_key and bool(frappe.db.count("Studio AI Model", {"enabled": 1})),
		"models": frappe.db.count("Studio AI Model", {"enabled": 1}),
		"providers": len(providers),
		"presets": [presets.public_preset(p) for p in presets.PRESETS],
	}


@frappe.whitelist()
@has_page_write_perm()
def verify_ai_key(preset: str, api_key: str = "", api_base: str = "", model_id: str = ""):
	"""Make one small real call so a bad key fails here, not on the first build."""
	from studio.ai import presets

	found = presets.find_preset(preset)
	if not found:
		frappe.throw(_("Unknown provider: {0}").format(preset))
	model = model_id or next((m[0] for m in found["models"] if m[2]), "")
	if not model:
		return {"success": False, "severity": "error", "message": _("Enter a model id to test with")}
	# Re-entering setup for a provider that's already connected shows an empty key
	# box, because a stored key is never sent back. Test the stored one rather than
	# making someone dig out a key the site already has.
	if not api_key and found["name"] and frappe.db.exists("Studio AI Provider", found["name"]):
		api_key = frappe.get_cached_doc("Studio AI Provider", found["name"]).resolved_key() or ""
	return presets.verify_key(found, api_key, api_base, model)


@frappe.whitelist()
@has_page_write_perm()
def setup_ai_provider(
	preset: str,
	api_key: str = "",
	api_base: str = "",
	models: list | str | None = None,
	provider_name: str = "",
):
	"""Finish setup: save the provider and switch on the chosen models."""
	from studio.ai import presets

	found = presets.find_preset(preset)
	if not found:
		frappe.throw(_("Unknown provider: {0}").format(preset))
	chosen = parse_model_ids(models)
	if not chosen:
		frappe.throw(_("Pick at least one model"))
	name = presets.install_preset(found, api_key, api_base, chosen, provider_name)
	# `installed` is what THIS call switched on, not the site total: when the two
	# disagree with what was ticked, the client can say so instead of reporting
	# success over a selection that never arrived.
	return {
		"provider": name,
		"installed": chosen,
		"models": frappe.db.count("Studio AI Model", {"enabled": 1}),
	}


@frappe.whitelist()
@has_page_write_perm()
def add_provider_model(provider: str, model_id: str, label: str = "") -> dict:
	"""Add one model to a connected provider by its exact id, without leaving the
	chat panel. Metadata (context window, vision) auto-fills on insert; an id no
	catalog knows still saves — it keeps the defaults and is proven at call time,
	so `known` lets the client warn about a probable typo."""
	from studio.ai import presets
	from studio.ai.models import lookup_metadata

	if not frappe.has_permission("Studio AI Model", "create"):
		frappe.throw(_("You are not permitted to manage AI models"), frappe.PermissionError)

	doc = frappe.get_doc("Studio AI Provider", provider)
	model_id = (model_id or "").strip().strip("/")
	# Pasting the fully-qualified name is natural — don't double the prefix.
	if model_id.startswith(f"{doc.route_prefix}/"):
		model_id = model_id[len(doc.route_prefix) + 1 :]
	if not model_id:
		frappe.throw(_("Enter a model id"))

	# If this is the provider's very first row (say, right after an OAuth sign-in),
	# bring the preset shortlist along as disabled rows so it stays on offer.
	presets.materialize_shortlist(doc)
	presets.add_model(doc.name, doc.route_prefix, model_id, (label or "").strip())
	ModelRegistry.clear_cache()

	qualified = f"{doc.route_prefix}/{model_id}"
	return {"name": qualified, "known": bool(lookup_metadata(qualified, model_id))}


@frappe.whitelist()
@has_page_write_perm()
def delete_provider_model(provider: str, model_id: str) -> dict:
	"""Remove a model row entirely (vs. just disabling it), from the dialog's list."""
	if not frappe.has_permission("Studio AI Model", "delete"):
		frappe.throw(_("You are not permitted to manage AI models"), frappe.PermissionError)

	prefix = frappe.db.get_value("Studio AI Provider", provider, "route_prefix")
	name = f"{prefix}/{(model_id or '').strip().strip('/')}"
	if frappe.db.exists("Studio AI Model", name):
		frappe.delete_doc("Studio AI Model", name, ignore_permissions=True)
		ModelRegistry.clear_cache()
	return {"deleted": name}


@frappe.whitelist()
@has_page_write_perm()
def import_provider_models(provider: str) -> dict:
	"""Add every chat model an OpenAI-compatible provider advertises at /models.

	Saves typing model ids by hand, and is the only way to discover what a private
	or self-hosted gateway actually serves. Existing rows are left alone, so this
	is safe to re-run when a provider adds a model."""
	import requests

	if not frappe.has_permission("Studio AI Model", "create"):
		frappe.throw(_("You are not permitted to manage AI models"), frappe.PermissionError)

	doc = frappe.get_doc("Studio AI Provider", provider)
	if not doc.api_base:
		frappe.throw(_("This provider has no API Base to ask"))

	url = f"{doc.api_base.rstrip('/')}/models"
	headers = {"Content-Type": "application/json"}
	if key := doc.resolved_key():
		headers["Authorization"] = f"Bearer {key}"
	try:
		response = requests.get(url, headers=headers, timeout=20)
		response.raise_for_status()
		listed = response.json().get("data") or []
	except Exception as e:
		logger.warning(f"import_provider_models failed for {provider}: {e}")
		frappe.throw(_("Could not reach {0}: {1}").format(url, str(e)[:200]))

	added, skipped = [], []
	for entry in listed:
		model_id = (entry or {}).get("id")
		if not model_id:
			continue
		if any(marker in model_id.lower() for marker in NON_CHAT_MARKERS):
			skipped.append(model_id)
			continue
		if frappe.db.exists("Studio AI Model", f"{doc.route_prefix}/{model_id}"):
			continue
		frappe.get_doc(
			{"doctype": "Studio AI Model", "provider": provider, "model_id": model_id, "enabled": 1}
		).insert()
		added.append(model_id)

	ModelRegistry.clear_cache()
	return {"added": added, "skipped": skipped, "found": len(listed)}


@frappe.whitelist()
@has_page_write_perm()
def start_codex_login():
	"""Begin a ChatGPT browser sign-in: the URL to open, the state to poll on,
	and whether the localhost redirect can be captured from here."""
	from studio.ai import codex_login

	return codex_login.start()


@frappe.whitelist()
@has_page_write_perm()
def poll_codex_login(state: str):
	"""Where a started sign-in stands: pending, connected, failed or expired.
	Connecting installs the ChatGPT provider; models come from setup_ai_provider."""
	from studio.ai import codex_login

	return codex_login.poll(state)


@frappe.whitelist()
@has_page_write_perm()
def finish_codex_login(redirect_url: str):
	"""Complete a sign-in from the pasted redirect URL, for when the localhost
	listener couldn't see it (remote server, port in use)."""
	from studio.ai import codex_login
	from studio.ai.codex import CodexError

	try:
		return codex_login.finish(redirect_url)
	except CodexError as e:
		return {"status": "failed", "message": str(e)}


def parse_model_ids(models) -> list[str]:
	"""Take the selected ids in whatever shape they survived the request in.

	A list does not cross the wire intact: form encoding collapses it to its first
	value, and a JSON body can hand back the raw string. Both used to be iterated
	as-is, so three ticked models became one, and a JSON string became one model
	per CHARACTER ('anthropic/[', 'anthropic/"', …)."""
	if not models:
		return []
	if isinstance(models, str):
		try:
			models = json.loads(models)
		except (json.JSONDecodeError, TypeError):
			models = [models]
	if not isinstance(models, list):
		return []
	return [m for m in models if isinstance(m, str) and m.strip()]

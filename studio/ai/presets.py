"""The provider catalogue the setup flow offers.

Adding a provider by hand means knowing its route prefix, its litellm name, its
api_base and which of its models are worth enabling — none of which a user
should have to look up to get started. Each preset carries that, plus where the
key comes from and a shortlist of models to switch on.

A preset is only a starting point: everything it creates is an ordinary Studio
AI Provider / Studio AI Model row, editable afterwards like any other.
"""

import frappe
from frappe import _

from studio.ai.models import ModelRegistry

PRESETS = [
	{
		"id": "openrouter",
		"name": "OpenRouter",
		"tagline": "One key, every major model",
		"blurb": "Claude, GPT, Gemini and hundreds more behind a single key. The easiest way to start, and the only one where you can switch model without a new account.",
		"route_prefix": "openrouter",
		"litellm_provider": "openrouter",
		"api_base": None,
		"key_url": "https://openrouter.ai/keys",
		"key_prefix": "sk-or-",
		"key_steps": [
			"Sign in at openrouter.ai",
			"Open Keys and create a new key",
			"Add some credits",
		],
		"models": [
			("anthropic/claude-sonnet-4-6", "Claude Sonnet 4.6", True),
			("openai/gpt-5-mini", "GPT-5 Mini", True),
			("google/gemini-3.1-pro-preview", "Gemini 3.1 Pro", False),
			("google/gemini-3-flash-preview", "Gemini 3 Flash", False),
			("moonshotai/kimi-k2.6", "Kimi K2.6", False),
		],
	},
	{
		"id": "anthropic",
		"name": "Anthropic",
		"tagline": "Claude, direct",
		"blurb": "Straight to Anthropic with your own account. Claude is the strongest model for app building, and this is the cheapest way to reach it if you already have credit.",
		"route_prefix": "anthropic",
		"litellm_provider": "anthropic",
		"api_base": None,
		"key_url": "https://console.anthropic.com/settings/keys",
		"key_prefix": "sk-ant-",
		"key_steps": [
			"Sign in to the Anthropic Console",
			"Open Settings, then API keys",
			"Create a key and copy it",
		],
		"models": [
			("claude-sonnet-4-6", "Claude Sonnet 4.6", True),
			("claude-haiku-4-6", "Claude Haiku 4.6", False),
		],
	},
	{
		"id": "openai",
		"name": "OpenAI",
		"tagline": "GPT, direct",
		"blurb": "Straight to OpenAI with your own account.",
		"route_prefix": "openai",
		"litellm_provider": "openai",
		"api_base": None,
		"key_url": "https://platform.openai.com/api-keys",
		"key_prefix": "sk-",
		"key_steps": [
			"Sign in at platform.openai.com",
			"Open API keys and create a secret key",
			"Copy it before closing the dialog",
		],
		"models": [
			("gpt-5-mini", "GPT-5 Mini", True),
			("gpt-5", "GPT-5", False),
		],
	},
	{
		"id": "codex",
		"name": "ChatGPT",
		"tagline": "Included with ChatGPT Plus/Pro",
		"blurb": "OpenAI's models through the ChatGPT subscription you already pay for. No API credits or per-token billing, just sign in with your ChatGPT account.",
		"route_prefix": "codex",
		"litellm_provider": "codex",
		"api_base": None,
		"oauth": True,
		"key_url": "",
		"key_prefix": "",
		"key_steps": [
			"Click Sign in with ChatGPT and approve in the tab that opens",
			"You'll be connected automatically when the sign-in completes",
		],
		"models": [
			("gpt-5.6-terra", "GPT-5.6 Terra", True),
			("gpt-5.6-luna", "GPT-5.6 Luna", False),
			("gpt-5.3-codex", "GPT-5.3 Codex", False),
			("gpt-5.5", "GPT-5.5", False),
		],
	},
	{
		"id": "google",
		"name": "Google Gemini",
		"tagline": "Gemini, direct",
		"blurb": "Straight to Google AI Studio. Generous free tier to try things out.",
		"route_prefix": "gemini",
		"litellm_provider": "gemini",
		"api_base": None,
		"key_url": "https://aistudio.google.com/apikey",
		"key_prefix": "",
		"key_steps": [
			"Open Google AI Studio",
			"Click Get API key",
			"Create a key in a new or existing project",
		],
		"models": [
			("gemini-3-flash-preview", "Gemini 3 Flash", True),
			("gemini-3.1-pro-preview", "Gemini 3.1 Pro", False),
		],
	},
	{
		"id": "custom",
		"name": "",  # the user names it
		"tagline": "Any OpenAI-compatible endpoint",
		"blurb": "A gateway of your own: an internal proxy, a hosted endpoint not listed here, or Ollama / LM Studio / vLLM on your own machine. You name it and point it at a base URL.",
		"route_prefix": "",  # slugged from the name by the provider doctype
		"litellm_provider": "",  # derived from whether an api_base is set
		"api_base": "",
		"custom": True,
		"key_url": "",
		"key_prefix": "",
		"key_steps": [],
		"models": [],
	},
]


def find_preset(preset_id: str) -> dict | None:
	return next((p for p in PRESETS if p["id"] == preset_id), None)


def public_preset(preset: dict) -> dict:
	"""The shape the setup flow renders — routing internals stay server-side."""
	custom = preset.get("custom", False)
	existing = preset["name"] and frappe.db.exists("Studio AI Provider", preset["name"])
	return {
		# A stored key is never sent back, so the flow has to be told one exists —
		# otherwise re-entering setup looks identical to having no key at all.
		"has_key": bool(existing and frappe.get_cached_doc("Studio AI Provider", existing).resolved_key()),
		"id": preset["id"],
		"name": preset["name"],
		"tagline": preset["tagline"],
		"blurb": preset["blurb"],
		"key_url": preset["key_url"],
		"key_prefix": preset["key_prefix"],
		"key_steps": preset["key_steps"],
		"api_base": preset["api_base"],
		"custom": custom,
		# OAuth providers sign in with a browser round-trip instead of a key.
		"oauth": preset.get("oauth", False),
		# A custom endpoint is named and addressed by the user; a known one only
		# ever needs the key, and often already exists from a previous setup.
		"needs_name": custom,
		"needs_api_base": custom,
		"configured": bool(existing),
		# The actual prefix once connected (derive_routing may have deduped it),
		# so the client can show each model's qualified name.
		"route_prefix": (
			frappe.db.get_value("Studio AI Provider", existing, "route_prefix")
			if existing
			else preset["route_prefix"]
		),
		"models": preset_models(preset, existing),
	}


def preset_models(preset: dict, existing: str | None) -> list[dict]:
	"""What the dialog's model list shows. Once the provider has rows, the rows
	ARE the list — deleting one really removes it (Builder's behaviour), instead
	of the shortlist re-offering it as an unticked ghost. The curated shortlist
	only appears while there are no rows yet: a first-time setup, a provider
	fresh from an OAuth sign-in, or one whose every model was deleted."""
	rows = (
		frappe.get_all(
			"Studio AI Model",
			filters={"provider": existing},
			fields=["model_id", "label", "enabled", "supports_vision"],
			order_by="creation asc",
		)
		if existing
		else []
	)
	if not rows:
		return [
			{
				"model_id": mid,
				"label": label,
				"recommended": rec,
				"enabled": False,
				"vision": False,
				# A shortlist entry is just an offer — there is no row to delete.
				"exists": False,
			}
			for mid, label, rec in preset["models"]
		]
	return [
		{
			"model_id": r.model_id,
			"label": r.label or r.model_id,
			"recommended": False,
			"enabled": bool(r.enabled),
			"vision": bool(r.supports_vision),
			"exists": True,
		}
		for r in rows
	]


def install_preset(
	preset: dict, api_key: str, api_base: str, model_ids: list[str], provider_name: str = ""
) -> str:
	"""Create (or update) the provider and switch on the chosen models.

	route_prefix and litellm_provider are deliberately left unset for a custom
	endpoint: Studio AI Provider slugs the prefix from the name and infers the
	litellm side from whether a base URL is present, so there is one place that
	decides routing rather than two that can disagree."""
	name = (provider_name or preset["name"]).strip()
	if not name:
		frappe.throw(_("Give this provider a name"))
	fields = {
		"provider_name": name,
		"api_base": (api_base or preset["api_base"] or "") or None,
		"enabled": 1,
	}
	if preset["route_prefix"]:
		fields["route_prefix"] = preset["route_prefix"]
	if preset["litellm_provider"]:
		fields["litellm_provider"] = preset["litellm_provider"]
	if api_key:
		fields["api_key"] = api_key

	if frappe.db.exists("Studio AI Provider", name):
		doc = frappe.get_doc("Studio AI Provider", name)
		doc.update(fields)
		doc.save(ignore_permissions=True)
	else:
		doc = frappe.get_doc({"doctype": "Studio AI Provider", **fields}).insert(ignore_permissions=True)

	known = {m[0]: m[1] for m in preset["models"]}
	if model_ids:
		materialize_shortlist(doc, model_ids)
	for model_id in model_ids:
		add_model(doc.name, doc.route_prefix, model_id, known.get(model_id, model_id))
	# For a known preset the ticks are the whole truth: every enabled row the
	# dialog offered and the user left unticked is switched off, so the picker
	# matches the dialog. A custom endpoint's textarea is additive — reconfiguring
	# it must not silently disable models imported earlier. An empty selection is
	# never "disable all": it only happens on flows that don't pick models at
	# all, like a Codex re-login.
	if model_ids and not preset.get("custom"):
		for row in frappe.get_all(
			"Studio AI Model",
			filters={"provider": doc.name, "enabled": 1},
			fields=["name", "model_id"],
		):
			if row.model_id not in model_ids:
				frappe.db.set_value("Studio AI Model", row.name, "enabled", 0)
	ModelRegistry.clear_cache()
	return doc.name


def materialize_shortlist(doc, chosen: list[str] | None = None) -> None:
	"""Turn a preset's unchosen shortlist entries into disabled rows the first time
	a provider gains any row. The dialog lists rows only (so delete can be real),
	which means an offer that never becomes a row would silently vanish — as a
	disabled row it stays visible until explicitly deleted."""
	preset = next((p for p in PRESETS if p["name"] == doc.name), None)
	if not preset or frappe.db.exists("Studio AI Model", {"provider": doc.name}):
		return
	for model_id, label, _recommended in preset["models"]:
		if model_id not in (chosen or []):
			add_model(doc.name, doc.route_prefix, model_id, label, enabled=0)


def add_model(provider: str, route_prefix: str, model_id: str, label: str, enabled: int = 1) -> None:
	full_name = f"{route_prefix}/{model_id}"
	if frappe.db.exists("Studio AI Model", full_name):
		frappe.db.set_value("Studio AI Model", full_name, "enabled", enabled)
		return
	frappe.get_doc(
		{
			"doctype": "Studio AI Model",
			"provider": provider,
			"model_id": model_id,
			"label": label,
			"enabled": enabled,
		}
	).insert(ignore_permissions=True)


def verify_key(preset: dict, api_key: str, api_base: str, model_id: str) -> dict:
	"""Make the smallest real call this provider will accept, so a key that looks
	right but is revoked, out of credit or scoped wrong fails HERE rather than
	three screens later on the user's first build."""
	if preset["id"] == "codex":
		from studio.ai import codex

		return codex.verify_credential(api_key)
	import litellm

	base = api_base or preset["api_base"]
	# Mirrors StudioAIProvider.derive_routing, so the test call routes exactly the
	# way the saved provider will.
	llm_provider = preset["litellm_provider"] or ("openai" if base else "openrouter")
	qualified = f"{llm_provider}/{model_id}"
	overrides = {"api_base": base} if base else {}
	try:
		litellm.completion(
			model=qualified,
			**overrides,
			messages=[{"role": "user", "content": "Reply with OK"}],
			max_tokens=5,
			api_key=api_key or "not-needed",
		)
		return {"success": True, "severity": "ok", "message": _("Connected")}
	except Exception as e:
		message, severity = readable_error(str(e))
		return {"success": False, "severity": severity, "message": message}


def readable_error(raw: str) -> tuple[str, str]:
	"""Provider errors arrive as a wall of JSON. Say what to actually do about it,
	and how much it matters.

	"warn" means the credentials are FINE and something else is in the way — an
	empty balance, a rate limit, a model this account can't see. Setup should not
	dead-end on those: the key is right, and topping up an account is a thing you
	go and do elsewhere, later. Only "error" means it cannot work as entered."""
	low = raw.lower()
	if "authentication" in low or ("invalid" in low and "key" in low) or "401" in low:
		return (
			_("That key was rejected. Check you copied all of it, and that it hasn't been revoked."),
			"error",
		)
	if "credit" in low or "quota" in low or "billing" in low or "429" in low:
		return (
			_("The key is valid, but the account has no credit or is rate limited right now."),
			"warn",
		)
	if "not found" in low or "404" in low or "does not exist" in low:
		return (_("The key is valid, but that model isn't available on this account."), "warn")
	if "connection" in low or "timeout" in low or "refused" in low:
		return (_("Couldn't reach the server. Check the address is right and that it's running."), "error")
	return (raw[:300], "error")

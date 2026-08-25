"""Seed the OpenRouter provider and the model shortlist that was previously
hardcoded in studio.ai.models.ModelRegistry, so existing installs keep exactly
the models they had before providers became configuration."""

import frappe

MODELS = [
	("anthropic/claude-sonnet-4-6", "Claude Sonnet 4.6", True),
	("anthropic/claude-opus-4.6", "Claude Opus 4.6", True),
	("anthropic/claude-haiku-4-6", "Claude Haiku 4.6", True),
	("google/gemini-3.1-pro-preview", "Gemini 3.1 Pro", True),
	("google/gemini-3-flash-preview", "Gemini 3 Flash", True),
	("openai/gpt-5-mini", "GPT-5 Mini", True),
	("z-ai/glm-5.2", "GLM 5.2", False),
	("qwen/qwen3.7-max", "Qwen 3.7 Max", False),
	("moonshotai/kimi-k2.6", "Kimi K2.6", True),
]


def execute():
	provider = ensure_openrouter_provider()
	for model_id, label, vision in MODELS:
		ensure_model(provider, model_id, label, vision)


def ensure_openrouter_provider() -> str:
	if frappe.db.exists("Studio AI Provider", "OpenRouter"):
		return "OpenRouter"
	doc = frappe.get_doc(
		{
			"doctype": "Studio AI Provider",
			"provider_name": "OpenRouter",
			"route_prefix": "openrouter",
			"litellm_provider": "openrouter",
			"enabled": 1,
		}
	)
	doc.insert(ignore_permissions=True)
	return doc.name


def ensure_model(provider: str, model_id: str, label: str, vision: bool) -> None:
	name = f"openrouter/{model_id}"
	if frappe.db.exists("Studio AI Model", name):
		return
	frappe.get_doc(
		{
			"doctype": "Studio AI Model",
			"provider": provider,
			"model_id": model_id,
			"label": label,
			"supports_vision": int(vision),
			"enabled": 1,
		}
	).insert(ignore_permissions=True)

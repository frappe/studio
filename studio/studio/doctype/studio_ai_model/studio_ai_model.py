# Copyright (c) 2026, Frappe Technologies Pvt Ltd and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class StudioAIModel(Document):
	def autoname(self):
		self.name = self.qualified_name()

	def qualified_name(self) -> str:
		"""`<route prefix>/<model id>`, the name the agent and every stored session
		use. Keeping it as the docname means a session's selected_model is a link
		to this row, not a duplicated string."""
		prefix = frappe.db.get_value("Studio AI Provider", self.provider, "route_prefix")
		return f"{prefix}/{(self.model_id or '').strip().strip('/')}"

	def validate(self):
		self.model_id = (self.model_id or "").strip().strip("/")
		if not self.model_id:
			frappe.throw(_("Model ID is required"))
		self.label = (self.label or "").strip() or self.model_id
		self.detect_metadata()
		if not self.is_new() and self.name != self.qualified_name():
			frappe.rename_doc(self.doctype, self.name, self.qualified_name(), force=True)

	def detect_metadata(self) -> None:
		"""Fill in what can be looked up — label, context window, vision — so adding
		a model only asks for its id. OpenRouter answers for its own models, litellm's
		model map for the rest. Anything already filled in is left alone, so an edit
		(or a model nobody knows) stands."""
		from studio.ai.models import lookup_metadata

		found = lookup_metadata(self.qualified_name(), self.model_id)
		if self.label == self.model_id:
			# The raw id is a poor display name; take the catalog's, else prettify.
			self.label = found.get("label") or prettify_model_id(self.model_id)
		if not found:
			return
		if not self.max_tokens and found.get("max_tokens"):
			self.max_tokens = found["max_tokens"]
		if not self.supports_vision and found.get("vision"):
			self.supports_vision = 1

	def on_update(self):
		self.clear_registry_cache()

	def on_trash(self):
		self.clear_registry_cache()

	def clear_registry_cache(self) -> None:
		from studio.ai.models import ModelRegistry

		ModelRegistry.clear_cache()


def prettify_model_id(model_id: str) -> str:
	"""'google/gemini-3.1-pro-preview' -> 'Gemini 3.1 Pro Preview'."""
	tail = model_id.split("/")[-1]
	return " ".join(word.capitalize() if word.islower() else word for word in tail.replace("-", " ").split())

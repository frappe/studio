"""Revenue Recommendations engine for Studio AI.

Analyzes the current page structure, components, copy, layout, and purpose
to generate contextual monetization opportunities using OpenRouter free model.
"""

import json
import logging

import frappe
from frappe import _

from studio.ai import llm
from studio.ai.block_codec import BlockCodec
from studio.utils import has_page_write_perm

logger = frappe.logger("studio.ai.revenue")
logger.setLevel(logging.INFO)

REVENUE_MODEL = "openrouter/openai/gpt-oss-120b:free"

REVENUE_SYSTEM_PROMPT = """You are a business strategist and product monetization expert specializing in web applications and websites.

Your task is to analyze the structure, copy, component layout, CTAs, forms, and purpose of a page built in Frappe Studio, and generate tailored, contextual REVENUE RECOMMENDATIONS for how this specific page/website can generate revenue.

CRITICAL RULES:
1. Do NOT return a generic list of monetization strategies. Recommendations MUST be directly tailored to what is actually present or implied on this specific page.
2. Inspect headings, text copy, forms, buttons, cards, list views, products/services mentioned, and layout structure.
3. For each recommendation, provide:
   - strategy: Title of the monetization strategy (e.g., "Freelance Consultation Booking", "Tiered SaaS Subscription", "Paid Video Courses", "Affiliate Lead Generation", "Product Bundling & Upsells")
   - category: One of ["Services & Consultation", "Subscriptions & Membership", "Digital Products & Courses", "Sponsorships & Ads", "Ecommerce & Upsells", "Lead Generation & Affiliates"]
   - why_fits: Clear, specific justification referencing elements actually present on the page.
   - how_it_works: Step-by-step description of how the monetization mechanism operates for this website.
   - potential: "High", "Medium", or "Low"
   - difficulty: "Low", "Medium", or "High"
   - priority: "High", "Medium", or "Low"
   - studio_implementation: A list of 2-4 concrete, actionable steps to implement this on the page using Studio components (e.g., "Add a Form container for booking", "Bind a payment action to the CTA button", "Add a pricing table section").

4. Provide a brief analysis summary of what the website/page appears to be about.
5. Do NOT invent precise arbitrary revenue numbers unless the available page copy explicitly supports them.
6. Return ONLY valid JSON in the following format (no markdown fences, no conversational commentary):

{
  "page_summary": {
    "detected_type": "detected page type (e.g. Portfolio / SaaS Landing Page / Educational Portal / Ecommerce / Content Blog)",
    "purpose": "1-2 sentences summarizing the apparent page topic and target audience"
  },
  "recommendations": [
    {
      "id": "rec_1",
      "strategy": "...",
      "category": "...",
      "why_fits": "...",
      "how_it_works": "...",
      "potential": "High | Medium | Low",
      "difficulty": "Low | Medium | High",
      "priority": "High | Medium | Low",
      "studio_implementation": [
        "...",
        "..."
      ]
    }
  ]
}
"""


@frappe.whitelist()
@has_page_write_perm()
def analyze_page_revenue(page_id: str, page_context: str) -> dict:
	"""Analyze the current page structure and return revenue recommendations using openrouter/free."""
	if not isinstance(page_id, str):
		frappe.throw(_("Invalid page_id parameter. Must be a string."), frappe.ValidationError)

	if not isinstance(page_context, str):
		frappe.throw(_("Invalid page_context parameter. Must be a string."), frappe.ValidationError)

	logger.info(f"Revenue AI request started | page_id={page_id} | requested_model={REVENUE_MODEL}")

	api_key = llm.get_api_key()
	has_api_key = bool(api_key)
	logger.info(f"Revenue AI API key configured | {str(has_api_key).lower()}")
	if not api_key:
		frappe.throw(_("OpenRouter API key is not configured. Please set it in Studio Settings."))

	page_meta = {}
	if page_id and frappe.db.exists("Studio Page", page_id):
		doc = frappe.get_doc("Studio Page", page_id)
		page_meta = {
			"page_title": doc.page_title or doc.page_name,
			"route": doc.route,
			"resources_count": len(doc.resources) if doc.resources else 0,
			"variables_count": len(doc.variables) if doc.variables else 0,
		}

	compressed_tree = ""
	try:
		raw_data = json.loads(page_context)
		root = raw_data[0] if isinstance(raw_data, list) and raw_data else raw_data
		if isinstance(root, dict):
			compressed_tree = BlockCodec.to_json(BlockCodec.compress(root))
	except (json.JSONDecodeError, TypeError) as e:
		logger.warning(f"Could not compress page_context JSON: {e}")
		compressed_tree = page_context[:4000]

	user_prompt = f"""Target Page Metadata:
{json.dumps(page_meta, indent=2)}

Current Page Block Structure (JSON):
{compressed_tree}

Please analyze this page and generate 3 to 5 highly relevant, contextual revenue opportunities based strictly on the content and structure above."""

	messages = [
		{"role": "system", "content": REVENUE_SYSTEM_PROMPT},
		{"role": "user", "content": user_prompt},
	]

	try:
		params = {"max_tokens": 4000, "temperature": 0.3}
		logger.info(f"Revenue AI calling llm.complete | requested_model={REVENUE_MODEL}")

		response_text = llm.complete(
			model=REVENUE_MODEL,
			messages=messages,
			params=params,
			stream=False,
			api_key=api_key,
		)

		response_len = len(response_text) if response_text else 0
		logger.info(f"Revenue AI response received | response_length={response_len}")
		logger.info("Revenue AI provider info | Note: llm.complete() returns text content only; underlying provider/model metadata is logged by studio.ai.llm")

		parsed, repaired = llm.loads_tolerant(BlockCodec.strip_fences(response_text))
		if isinstance(parsed, dict) and "recommendations" in parsed:
			logger.info(f"Revenue AI response parsed successfully | recommendations_count={len(parsed.get('recommendations', []))}")
			return {"status": "success", "result": parsed}
		else:
			logger.warning(f"Revenue AI response parsing failed | response_length={response_len}")
			return {
				"status": "error",
				"message": _("Could not parse AI recommendations. Please try again."),
				"raw": response_text[:1000],
			}
	except Exception as e:
		logger.error(f"Revenue AI request failed | error={e!s}", exc_info=True)
		frappe.log_error(f"Revenue AI request failed: {e}", "analyze_page_revenue")
		return {"status": "error", "message": _("Revenue analysis failed. Please try again.")}

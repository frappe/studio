"""preview_page — let the agent SEE the page it built.

Studio pages are client-rendered Vue, so the capture drives Frappe's in-process
headless Chromium at the app's /dev preview URL (which renders draft_blocks —
exactly what the agent writes) with a short-lived session minted for the
requesting user (drafts need auth), waits for the SPA to paint, then trims and
tiles the screenshot into readable screenfuls for the vision model. The tiles
ride a follow-up user message (AgentRunner.flush_pending_images) — the OpenAI
tool-result shape can't carry image parts. Degrades to a plain "preview
unavailable" tool result when Chromium isn't reachable — a missing renderer
must never fail the turn.
"""

import base64
import logging

import frappe

from studio.ai.agent.registry import Tool

logger = frappe.logger("studio.ai.agent.preview")
logger.setLevel(logging.INFO)

# Hard cost bounds — a screenshot loop can't run away. Per page: one review +
# one re-check after fixes. Per turn: covers a multi-page build.
MAX_PREVIEWS_PER_PAGE = 2
MAX_PREVIEWS_PER_TURN = 8
MAX_IMAGE_BYTES = 3 * 1024 * 1024  # mirrors BlockCodec.validate_image_data's cap
PREVIEW_WIDTH = 1280
# The viewport we capture into. Chromium screenshots the viewport, not the
# document, so this has to clear a whole generated page. Blank tail is trimmed.
CAPTURE_HEIGHT = 8000
# One attached image per this many pixels of page. NOT one tall image: a vision
# model shrinks an image to fit its longest edge (~1568px), so a single
# 1280x6000 capture reaches the model with every label illegible.
TILE_HEIGHT = 2000
MAX_TILES = 3
SPA_RENDER_WAIT_MS = 3000

# How far a pixel may drift from the background before it counts as content —
# lossy webp leaves a couple of levels of drift across a blank band.
BLANK_TOLERANCE = 16
# App shells pin chrome (a sidebar footer, a bottom nav) to the viewport bottom —
# 8000px down in our oversized capture. A drift band living entirely within this
# strip, separated from the real content by at least MIN_TAIL_GAP of blank, is
# pinned chrome, not content flow, and must not defeat the blank-tail trim.
PIN_ZONE = 300
MIN_TAIL_GAP = 1500

REVIEW_RUBRIC = (
	"For YOUR eyes only (the user doesn't see it). Review in three passes, then act:\n"
	"1. BREAKAGE: unreadable contrast, accidental overlap, empty sections, components that "
	"didn't render (blank areas where content should be), raw {{ }} text on screen, a layout "
	"that clearly collapses.\n"
	"2. SIZING & FILL — vision glosses over proportions, so check these DELIBERATELY: (a) does "
	"every repeated element (card, row, input) FILL its column/track width? A card floating "
	"narrower than its column — lots of dead space to its right — means a fixed width or a "
	"broken stretch: fix with width '100%' on the child or alignItems 'stretch' on the track. "
	"(b) are repeated elements UNIFORM across columns/rows (same width, same height rhythm)? "
	"(c) is any element overflowing or hugging a container edge it should be inset from?\n"
	"3. DESIGN LANGUAGE — judge the screenshot against the design-language rules in your "
	"instructions (principles, ink ladder, color discipline, geometry, empty states), and "
	"against what the user actually asked for.\n"
	"The screenshot shows the SYMPTOM; read_block shows the CAUSE — confirm a suspect width or "
	"gap against the block's actual styles before fixing. Fix failures with surgical edits on "
	"the specific blocks (update_block / update_blocks) — regenerate only if the layout is "
	"beyond repair. Motion, hover and drag behaviour are invisible in a static screenshot — "
	"don't chase them here. You may preview ONCE more after fixing; never loop screenshots. "
	"If problems remain after your fixes, say so honestly in your summary and stop. Don't "
	"describe the screenshot to the user."
)


def run_preview_page(ctx, args: dict) -> str:
	from studio.ai.agent.tools.pages import _resolve_app_page
	from studio.ai.models import ModelRegistry

	if not ModelRegistry.is_vision_capable(ctx.model):
		return "Your model can't view images — skip visual checks this turn and don't call this again."

	page_id = ctx.page_id
	if ref := (args.get("page_name") or "").strip():
		page, error = _resolve_app_page(ctx, ref)
		if error:
			return error
		page_id = page.name
	if not page_id:
		return "FAILED: no page in focus — open or create a page first."

	taken = ctx.preview_counts.get(page_id, 0)
	if taken >= MAX_PREVIEWS_PER_PAGE or sum(ctx.preview_counts.values()) >= MAX_PREVIEWS_PER_TURN:
		return "Preview limit reached — proceed with what you have."
	ctx.preview_counts[page_id] = taken + 1

	page = frappe.get_doc("Studio Page", page_id)
	ctx.emit("progress", message=f"Looking at '{page.page_title}'…")
	try:
		image, errors = capture_page(ctx, page)
	except Exception:
		logger.warning("preview_page: render failed for %s", page_id, exc_info=True)
		return (
			"Preview unavailable (screenshot renderer not reachable). "
			"Continue without the visual check — do not retry."
		)

	attached, complete = attach_to_model(ctx, page, image)
	if not attached:
		return "Screenshot captured but too large to attach for review — finish up."
	extent = (
		f"The page is attached below as {attached} images, top to bottom — review ALL of them."
		if attached > 1
		else "Screenshot attached below."
	)
	if not complete:
		extent += " They stop before the end of the page; anything past that you have NOT seen."
	# A screenshot of ANOTHER page is a reference to study, not a build to review.
	if page_id != ctx.page_id:
		return (
			f"{extent} This is another page of the app, attached as a visual REFERENCE for "
			"your eyes only. Study its design language — palette, typography, spacing rhythm, "
			"section structure — and carry it into your work on the focused page."
		)
	from studio.ai.agent.capture import error_report

	if report := error_report(errors):
		return (
			f"{extent}\nRUNTIME ERRORS during the render — the page is broken in ways the "
			f"screenshot may not show. Fix these FIRST (a [network] error names the failing "
			f"server call; a [js] error usually points at a binding or script):\n{report}\n"
			f"{REVIEW_RUBRIC}"
		)
	clean = " No runtime errors were detected during the render." if errors == [] else ""
	return f"{extent}{clean} {REVIEW_RUBRIC}"


def capture_page(ctx, page) -> tuple[bytes, list[dict] | None]:
	"""Screenshot the page's /dev draft preview as the requesting user, plus the
	runtime errors collected during the render (None = collection unavailable)."""
	from studio.ai.agent.capture import capture_with_errors

	url = preview_url(ctx, page)
	sid = mint_preview_sid(ctx.user)
	try:
		return capture_with_errors(
			url,
			headers={"Cookie": f"sid={sid}"} if sid else None,
			wait_ms=SPA_RENDER_WAIT_MS,
			width=PREVIEW_WIDTH,
			height=CAPTURE_HEIGHT,
		)
	finally:
		drop_preview_sid(sid)


def preview_url(ctx, page) -> str:
	app_route = frappe.db.get_value("Studio App", page.studio_app or ctx.app_id, "route") or ""
	return frappe.utils.get_url(f"/dev/{app_route}{page.route or ''}")


def mint_preview_sid(user: str) -> str | None:
	"""A short-lived real session for the capture (drafts need auth). Seeding
	form_dict['sid'] keeps Session() off frappe.request, which a worker lacks."""
	from frappe.sessions import Session

	try:
		frappe.form_dict["sid"] = "Guest"
		info = frappe.db.get_value("User", user, ["full_name", "user_type"], as_dict=True)
		session = Session(user=user, resume=False, full_name=info.full_name, user_type=info.user_type)
		return session.data.get("sid")
	except Exception:
		logger.warning("preview_page: could not mint a session, capturing unauthenticated", exc_info=True)
		return None
	finally:
		frappe.form_dict.pop("sid", None)


def drop_preview_sid(sid: str | None) -> None:
	if not sid:
		return
	try:
		from frappe.sessions import delete_session

		delete_session(sid, reason="Studio AI preview done")
	except Exception:
		pass


def attach_to_model(ctx, page, image: bytes) -> tuple[int, bool]:
	"""Queue the page as a run of readable screenfuls, top to bottom, for
	flush_pending_images. Returns (tiles attached, whether they cover the page)."""
	try:
		tiles, complete = tile_screenshot(image)
	except Exception:
		logger.warning("preview_page: tiling failed, attaching the raw capture", exc_info=True)
		tiles, complete = [image], True
	title = page.page_title or page.name
	attached = 0
	for index, tile in enumerate(tiles, start=1):
		if len(tile) > MAX_IMAGE_BYTES:
			continue
		where = f" — part {index} of {len(tiles)}, top to bottom" if len(tiles) > 1 else ""
		ctx.pending_images.append(
			{
				"caption": f"Screenshot of draft page '{title}'{where}:",
				"data_url": "data:image/webp;base64," + base64.b64encode(tile).decode(),
			}
		)
		attached += 1
	return attached, complete and attached == len(tiles)


def tile_screenshot(image: bytes) -> tuple[list[bytes], bool]:
	"""Trim the blank tail, then slice the page into readable screenfuls.
	Returns (tiles, complete) — complete is False when the page ran past MAX_TILES."""
	from io import BytesIO

	from PIL import Image

	im = Image.open(BytesIO(image)).convert("RGB")
	im = im.crop((0, 0, im.width, max(content_height(im), 1)))
	tiles = []
	for top in range(0, im.height, TILE_HEIGHT):
		buffer = BytesIO()
		im.crop((0, top, im.width, min(top + TILE_HEIGHT, im.height))).save(buffer, "WEBP", quality=80)
		tiles.append(buffer.getvalue())
		if len(tiles) == MAX_TILES:
			break
	return tiles, len(tiles) * TILE_HEIGHT >= im.height


def content_height(im) -> int:
	"""Where the page actually ends — everything below is the blank tail of an
	oversized viewport. Diffed against the BOTTOM ROW tiled full-height (not a
	single colour): an app shell's sidebar/background columns run the whole
	viewport, so the tail is 'rows that repeat the bottom row', and only rows
	with actual content drift from it."""
	from PIL import Image, ImageChops

	bottom_row = im.crop((0, im.height - 1, im.width, im.height))
	background = bottom_row.resize(im.size, Image.NEAREST)
	drift = ImageChops.difference(im, background).convert("L")
	mask = drift.point(lambda level: 255 if level > BLANK_TOLERANCE else 0)
	bbox = mask.getbbox()
	if not bbox:
		return im.height
	end = bbox[3]
	if end >= im.height - PIN_ZONE:
		inner = mask.crop((0, 0, im.width, im.height - PIN_ZONE)).getbbox()
		if inner and inner[3] < im.height - PIN_ZONE - MIN_TAIL_GAP:
			end = inner[3]  # the band at the bottom is pinned chrome, not content
	return min(end + 32, im.height)  # a little breathing room below the last content


TOOLS = [
	Tool(
		name="preview_page",
		side="server",
		handler=run_preview_page,
		description=(
			"Render the focused page's draft to a screenshot attached to you so you can SEE what "
			"you built (the user is not shown the image in chat), AND report the runtime errors hit "
			"during the render — uncaught JS, console errors, failed server calls — which catch "
			"breakage invisible in pixels (an empty list that is really a crashed data source). Call "
			"it after EVERY generate_page build and after wiring data/scripts, BEFORE moving to the "
			"next page or ending the turn: fix reported errors first, then the visual rubric, with "
			"surgical edits; optionally preview once more, never loop screenshots. Also works on "
			"ANOTHER page (pass page_name) "
			"to study it as a visual reference before building a page that must match it. If the "
			"renderer is unavailable, continue without it."
		),
		parameters={
			"type": "object",
			"properties": {
				"page_name": {
					"type": "string",
					"description": "The page to screenshot (from list_pages). Defaults to the focused page.",
				},
			},
		},
	)
]

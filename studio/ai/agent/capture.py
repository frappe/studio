"""Screenshot + runtime-error capture for preview_page.

A screenshot shows what looks wrong; this also captures what IS wrong. It
mirrors frappe.utils.preview.capture_screenshot's browser lifecycle (acquire /
register / reset-singleton-on-crash) but injects a collector script before
navigation — uncaught JS errors, console.error calls, and failed fetch
responses (a data source 417/500 arrives with the server's exception message) —
and reads it back right before the screenshot. The whole enhanced path degrades
to frappe's plain helper: errors then come back as None ("collection
unavailable"), never a false "no errors".
"""

import json
import logging
import time

import frappe

logger = frappe.logger("studio.ai.agent.capture")
logger.setLevel(logging.INFO)

# Runs before any page script (Page.addScriptToEvaluateOnNewDocument). Caps and
# truncates in-page so the evaluate payload stays small; python dedupes further.
ERROR_COLLECTOR_JS = """
(() => {
	const errors = [];
	window.__studioRuntimeErrors = errors;
	const push = (type, message) => {
		if (errors.length < 20 && message) errors.push({ type, message: String(message).slice(0, 400) });
	};
	window.addEventListener("error", (e) => push("js", (e.error && e.error.stack) || e.message));
	window.addEventListener("unhandledrejection", (e) => {
		const r = e.reason;
		push("js", (r && (r.stack || r.message)) || r);
	});
	const consoleError = console.error;
	console.error = (...args) => {
		push(
			"console",
			args
				.map((a) => {
					if (typeof a === "string") return a;
					if (a instanceof Error) return a.stack || a.message;
					try { return JSON.stringify(a); } catch (_) { return String(a); }
				})
				.join(" ")
		);
		return consoleError.apply(console, args);
	};
	const fetchOriginal = window.fetch;
	window.fetch = (...args) =>
		fetchOriginal.apply(window, args).then((response) => {
			if (response.status >= 400) {
				const url = (response.url || "").split("?")[0];
				response
					.clone()
					.text()
					.then((body) => {
						let detail = body;
						try { detail = JSON.parse(body).exception || body; } catch (_) {}
						push("network", response.status + " " + url + " — " + detail);
					})
					.catch(() => push("network", response.status + " " + url));
			}
			return response;
		});
})();
"""


def capture_with_errors(
	url: str, *, headers: dict | None = None, wait_ms: int = 0, width: int = 1280, height: int = 720
) -> tuple[bytes, list[dict] | None]:
	"""(webp screenshot, runtime errors) — errors is None when collection was
	unavailable (fallback capture), [] when the page rendered clean."""
	try:
		return _enhanced_capture(url, headers=headers, wait_ms=wait_ms, width=width, height=height)
	except Exception:
		logger.warning("enhanced capture failed, falling back to plain screenshot", exc_info=True)
		from frappe.utils.preview import capture_screenshot

		image = capture_screenshot(
			"webp", url=url, headers=headers, wait_for=wait_ms, width=width, height=height
		)
		return image, None


def _enhanced_capture(url, *, headers, wait_ms, width, height) -> tuple[bytes, list[dict] | None]:
	"""Same control flow as frappe.utils.preview.capture_screenshot — keep the
	lifecycle handling in sync with it — plus the collector inject + readback."""
	from frappe.utils.chromium import CDPSocketClient, ChromiumManager, Page

	generator, browser_id = ChromiumManager.acquire()
	session = page = None
	try:
		try:
			if not generator._devtools_url:
				generator._set_devtools_url()
			session = CDPSocketClient(generator._devtools_url)
			session.connect()
			context, error = session.send("Target.createBrowserContext", {"disposeOnDetach": True})
			if error:
				raise RuntimeError(f"Error creating browser context: {error}")

			page = Page(session, context["browserContextId"], "screenshot")
			page.is_print_designer = False
			page.set_media_emulation("screen")
			page.set_device_metrics(width, height)
			page.send("Page.enable")
			page.send("Page.addScriptToEvaluateOnNewDocument", {"source": ERROR_COLLECTOR_JS})
			if headers:
				page.send("Network.enable")
				page.send("Network.setExtraHTTPHeaders", {"headers": headers})
			page.navigate(url)
			if wait_ms:
				time.sleep(wait_ms / 1000)
			errors = _collect_errors(page)
			return page.capture_screenshot(image_format="webp"), errors
		finally:
			_safe(page and page.close)
			_safe(session and session.disconnect)
			generator.remove_browser(browser_id)
	except Exception:
		# Only reset the singleton when the local Chrome process actually exited
		# (same rule as frappe's helper — a transient error must not reset it).
		proc = generator._chromium_process
		if proc is not None and proc.poll() is not None:
			generator._close_browser()
		raise


def _collect_errors(page) -> list[dict] | None:
	try:
		result = page.evaluate("JSON.stringify(window.__studioRuntimeErrors || [])")
		value = (result or {}).get("result", {}).get("value") or "[]"
		errors = json.loads(value)
		return errors if isinstance(errors, list) else None
	except Exception:
		logger.warning("runtime-error readback failed", exc_info=True)
		return None


def error_report(errors: list[dict] | None) -> str:
	"""Deduped, capped bullet list for the tool result; "" when clean or unavailable."""
	if not errors:
		return ""
	lines: list[str] = []
	for e in errors:
		line = f"- [{e.get('type', 'js')}] {' '.join(str(e.get('message', '')).split())}"
		if line not in lines:
			lines.append(line)
	report = "\n".join(lines[:8])
	if len(lines) > 8:
		report += f"\n(+{len(lines) - 8} more)"
	return report


def _safe(fn) -> None:
	if fn:
		try:
			fn()
		except Exception:
			logger.warning("capture cleanup failed", exc_info=True)

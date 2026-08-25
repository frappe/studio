"""Per-page run locks for agent turns.

One page has one AI writer at a time: a turn takes the lock for the page it is
editing (its focus) and moves the lock when the focus moves. The token is the
SESSION id, so a session can freely re-acquire its own lock (refreshing the TTL)
while a different chat targeting the same page is refused with a clear message.

Redis NX with a TTL comfortably above the job timeout — a crashed worker's lock
expires on its own instead of wedging the page. The session-level `is_running`
flag remains the per-chat concurrency guard; this lock is the cross-chat one.
"""

import frappe

# Job timeout is 600s; the margin covers enqueue latency and clock skew.
LOCK_TTL_SECONDS = 900


def acquire_page_lock(page_id: str, session_id: str) -> str | None:
	"""Take (or refresh) the page's run lock for this session. Returns None on
	success, or the holding session id when another chat owns the page."""
	if frappe.cache.set(_key(page_id), session_id, nx=True, ex=LOCK_TTL_SECONDS):
		return None
	holder = _holder(page_id)
	if holder is None or holder == session_id:
		frappe.cache.set(_key(page_id), session_id, ex=LOCK_TTL_SECONDS)
		return None
	return holder


def release_page_lock(page_id: str, session_id: str) -> None:
	"""Drop the lock, but only if this session still holds it — never clobber a
	lock another session acquired after ours expired."""
	if _holder(page_id) == session_id:
		frappe.cache.delete(_key(page_id))


def _holder(page_id: str) -> str | None:
	value = frappe.cache.get(_key(page_id))
	if value is None:
		return None
	return value.decode() if isinstance(value, bytes) else str(value)


def _key(page_id: str) -> str:
	return frappe.cache.make_key(f"studio_ai_page_lock:{page_id}")

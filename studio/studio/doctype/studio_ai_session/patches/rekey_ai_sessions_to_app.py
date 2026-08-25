import frappe


def execute():
	"""AI sessions are app-scoped now (`app` Link, `page` demoted to the session's current
	focus). Backfill `app` from the page each session was created on; a session whose page
	is gone has no app to belong to, so it goes (messages cascade via on_trash)."""
	for row in frappe.get_all("Studio AI Session", fields=["name", "page"]):
		app = frappe.db.get_value("Studio Page", row.page, "studio_app") if row.page else None
		if app:
			frappe.db.set_value("Studio AI Session", row.name, "app", app, update_modified=False)
		else:
			frappe.delete_doc("Studio AI Session", row.name, ignore_permissions=True, force=True)

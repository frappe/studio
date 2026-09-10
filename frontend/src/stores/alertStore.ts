import { shallowRef } from "vue"
import { useStorage } from "@vueuse/core"
import { defineStore } from "pinia"
import { createResource, toast } from "frappe-ui"

import { copyToClipboard } from "@/utils/helpers"
import type { StudioPage } from "@/types/Studio/StudioPage"

export type AlertAction = {
	label: string
	onClick: () => void
}

export type AppAlert = {
	id: string
	message: string
	action?: AlertAction
}

type LegacyVariableMigration = {
	code: string
	variable_names: string[]
}

const useAlertStore = defineStore("alerts", () => {
	const alerts = shallowRef<AppAlert[]>([])
	const dismissedAlertIds = useStorage<string[]>("studio:dismissed-alerts", [])
	const legacyMigration = shallowRef<LegacyVariableMigration | null>(null)
	let currentLegacyVariablePage: string | null = null

	function copyLegacyVariables() {
		if (!legacyMigration.value) return
		copyToClipboard(legacyMigration.value.code)
		toast.success("Legacy variables copied")
	}

	function show(alert: AppAlert) {
		if (dismissedAlertIds.value.includes(alert.id)) return
		alerts.value = [...alerts.value.filter((item) => item.id !== alert.id), alert]
	}

	function remove(id: string) {
		alerts.value = alerts.value.filter((alert) => alert.id !== id)
	}

	function dismiss(id: string) {
		dismissedAlertIds.value = [...new Set([...dismissedAlertIds.value, id])]
		remove(id)
	}

	function getLegacyVariableAlertId(pageName: string) {
		return `legacy-variables:${pageName}`
	}

	function getLegacyVariableAlertMessage(variableNames: string[]) {
		const visibleNames = variableNames.slice(0, 3).join(", ")
		const remainingCount = variableNames.length - 3
		const names = remainingCount > 0 ? `${visibleNames}, and ${remainingCount} more` : visibleNames
		return `Legacy variables found on this page: ${names}. Add them to the page script and expose them from setup().`
	}

	async function loadLegacyVariableMigration(page: StudioPage) {
		if (currentLegacyVariablePage === page.name) return
		currentLegacyVariablePage = page.name
		legacyMigration.value = null

		try {
			const migration = (await createResource({
				url: "studio.studio.doctype.studio_page.studio_page.get_legacy_variable_migration",
				method: "GET",
				params: { page_name: page.name },
			}).fetch()) as LegacyVariableMigration | null

			if (currentLegacyVariablePage !== page.name) return
			legacyMigration.value = migration
			if (!migration) return

			show({
				id: getLegacyVariableAlertId(page.name),
				message: getLegacyVariableAlertMessage(migration.variable_names),
				action: {
					label: "Copy legacy variables",
					onClick: copyLegacyVariables,
				},
			})
		} catch (error) {
			console.error("Failed to check for legacy page variables", error)
		}
	}

	function removeLegacyVariableMigration(pageName: string) {
		if (currentLegacyVariablePage === pageName) {
			currentLegacyVariablePage = null
			legacyMigration.value = null
		}
		remove(getLegacyVariableAlertId(pageName))
	}

	async function showAlerts(page: StudioPage) {
		await loadLegacyVariableMigration(page)
	}

	function removeAlerts(pageName: string) {
		removeLegacyVariableMigration(pageName)
	}

	return {
		legacyMigration,
		copyLegacyVariables,
		alerts,
		show,
		remove,
		dismiss,
		showAlerts,
		removeAlerts,
	}
})

export default useAlertStore

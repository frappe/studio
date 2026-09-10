export const EDITOR_RUNTIME_ENTRIES = {
	vue: "src/editorRuntime/vue.ts",
	"vue-router": "src/editorRuntime/vue-router.ts",
	pinia: "src/editorRuntime/pinia.ts",
	"frappe-ui": "src/editorRuntime/frappe-ui.ts",
	"frappe-ui/experimental": "src/editorRuntime/frappe-ui-experimental.ts",
	"frappe-ui/frappe": "src/editorRuntime/frappe-ui-frappe.ts",
	"frappe-ui/editor": "src/editorRuntime/frappe-ui-editor.ts",
	"frappe-ui/list": "src/editorRuntime/frappe-ui-list.ts",
	"frappe-ui/code-editor": "src/editorRuntime/frappe-ui-code-editor.ts",
	"frappe-ui/icons": "src/editorRuntime/frappe-ui-icons.ts",
}

export function isEditorRuntimeImport(source) {
	return Object.hasOwn(EDITOR_RUNTIME_ENTRIES, source)
}

export function getEditorRuntimeBuildInputs(root) {
	return Object.fromEntries(
		Object.entries(EDITOR_RUNTIME_ENTRIES).map(([specifier, source]) => [
			`editor-runtime-${specifier.replaceAll("/", "-")}`,
			new URL(source, root).pathname,
		]),
	)
}

import { createResource } from "frappe-ui"
import { customVueComponentsRegistry } from "@/globals"
import { setPageScriptImporters } from "@/data/studioPageScripts"
import { registerBuiltCustomComponentTemplates } from "@/utils/components"

type EditorModule = {
	protocolVersion: number
	components: Record<string, any>
	componentTemplates: Record<string, string>
	pageScripts: Record<string, () => Promise<Record<string, any>>>
}

type EditorAssets = {
	script?: string
	stylesheets?: string[]
}

type EditorAssetsResponse = EditorAssets & {
	message?: EditorAssets
}

const standardAppEditorAssets = createResource({
	url: "run_doc_method",
	makeParams(studioApp: string) {
		return {
			dt: "Studio App",
			dn: studioApp,
			method: "get_editor_assets",
			args: {},
		}
	},
})

export async function loadStandardAppEditor(studioApp: string): Promise<boolean> {
	const response = (await standardAppEditorAssets.reload(studioApp)) as EditorAssetsResponse | null
	const assets = response?.message || response
	const script = assets?.script
	if (!script) throw new Error(`Production editor assets are missing for Studio app "${studioApp}"`)
	loadStylesheets(assets.stylesheets || [])

	const editorModule: EditorModule = await import(/* @vite-ignore */ script)
	if (editorModule.protocolVersion !== 1) {
		throw new Error(`Unsupported Studio editor module protocol: ${editorModule.protocolVersion}`)
	}

	customVueComponentsRegistry.value = editorModule.components || {}
	registerBuiltCustomComponentTemplates(editorModule.componentTemplates || {})
	setPageScriptImporters(editorModule.pageScripts || {})
	return true
}

function loadStylesheets(stylesheets: string[]) {
	for (const href of stylesheets) {
		const alreadyLoaded = Array.from(
			document.head.querySelectorAll<HTMLLinkElement>("link[data-studio-editor-css]"),
		).some((link) => link.dataset.studioEditorCss === href)
		if (alreadyLoaded) continue
		const link = document.createElement("link")
		link.rel = "stylesheet"
		link.href = href
		link.dataset.studioEditorCss = href
		document.head.appendChild(link)
	}
}

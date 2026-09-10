import { createPinia, setActivePinia } from "pinia"
import { computed, nextTick, ref } from "vue"
import { setConfig } from "frappe-ui"
import useCodeStore from "@/stores/codeStore"
import { setPageScriptImporters, unregisterStudioPageScripts } from "@/data/studioPageScripts"
import type { StudioPage } from "@/types/Studio/StudioPage"
import type { Resource } from "@/types/Studio/StudioResource"

const notes: Resource = {
	resource_id: "notes",
	resource_name: "notes",
	resource_type: "API Resource",
	url: "test.notes",
	method: "GET",
	auto: false,
	params: { category: "{{ category }}" },
}

const script = `
const category = ref(route.params.category)
const title = ref("")
const loaded = notes.reload().then(() => { title.value = notes.data[0].title })
`

describe("page initialization", () => {
	let store: ReturnType<typeof useCodeStore>
	let requests: any[]
	const category = ref("News")
	const page = (source = script) => ({ name: "test-page", script: source }) as StudioPage

	beforeEach(() => {
		setActivePinia(createPinia())
		store = useCodeStore()
		category.value = "News"
		store.setRouteObject(computed(() => ({ params: { category: category.value } })))
		requests = []
		setConfig("resourceFetcher", async (options: any) => {
			requests.push(options)
			if (options.url === "frappe.client.get") return { name: options.params.name }
			return [{ title: options.params.category }]
		})
	})

	afterEach(() => {
		store.teardownPage()
		unregisterStudioPageScripts()
		setConfig("resourceFetcher", undefined)
	})

	it("exposes state to filters before a setup request fetches", async () => {
		await store.initializePage(page(), { rows: [notes] })
		await store.pageScriptBindings.loaded
		expect(store.pageScriptError).to.equal(null)
		expect(requests).to.have.length(1)
		expect(requests[0].params).to.deep.equal({ category: "News" })
		expect(store.pageScriptTemplateBindings.title).to.equal("News")
	})

	it("runs auto-fetches with the initial script state", async () => {
		await store.initializePage(page('const category = ref("Tech")'), {
			rows: [{ ...notes, auto: true }],
		})
		await new Promise((resolve) => setTimeout(resolve, 0))
		await store.resources.notes.promise
		expect(requests).to.have.length(1)
		expect(requests[0].params).to.deep.equal({ category: "Tech" })
	})

	it("uses the new route state when resetting the page", async () => {
		await store.initializePage(page(), { rows: [notes] })
		await store.pageScriptBindings.loaded
		category.value = "Sports"
		await store.initializePage(page(), { rows: [notes] })
		await store.pageScriptBindings.loaded
		expect(requests.map((request) => request.params.category)).to.deep.equal(["News", "Sports"])
		expect(store.pageScriptTemplateBindings.title).to.equal("Sports")
	})

	it("disposes setup watchers", async () => {
		await store.initializePage(
			page(`
			const category = ref("News")
			const changes = ref(0)
			watch(category, () => changes.value++)
		`),
			{ rows: [notes] },
		)
		const bindings = store.pageScriptBindings
		bindings.category.value = "Tech"
		await nextTick()
		expect(bindings.changes.value).to.equal(1)
		store.teardownPage()
		bindings.category.value = "Sports"
		await nextTick()
		expect(bindings.changes.value).to.equal(1)
	})

	it("does not rerun setup on a resource-only refresh", async () => {
		await store.initializePage(page(), { rows: [notes] })
		await store.pageScriptBindings.loaded
		await store.setPageResources(page(), { rows: [notes] })
		expect(requests).to.have.length(1)
	})

	it("uses fresh params for requests made by a saved script", async () => {
		await store.initializePage(page(), { rows: [notes] })
		await store.pageScriptBindings.loaded
		await store.setPageScript(page(script.replace("ref(route.params.category)", 'ref("Edited")')))
		await store.pageScriptBindings.loaded
		expect(requests.map((request) => request.params.category)).to.deep.equal(["News", "Edited"])
		expect(store.pageScriptTemplateBindings.title).to.equal("Edited")
	})

	it("ignores an old script import after navigating to another page", async () => {
		let resolveModule!: (module: any) => void
		let signalImport!: () => void
		const imported = new Promise<void>((resolve) => {
			signalImport = resolve
		})
		setPageScriptImporters({
			old: () =>
				new Promise((resolve) => {
					resolveModule = resolve
					signalImport()
				}),
		})
		const oldLoad = store.initializePage({ name: "old", is_standard: 1 } as StudioPage, { rows: [] })
		await imported
		await store.initializePage(page('const title = ref("New page")'), { rows: [] })
		let oldSetupRan = false
		resolveModule({
			default: () => {
				oldSetupRan = true
				return { title: "Old page" }
			},
		})
		await oldLoad
		expect(oldSetupRan).to.equal(false)
		expect(store.pageScriptTemplateBindings.title).to.equal("New page")
	})

	it("supports requests during exported page setup", async () => {
		setPageScriptImporters({
			standard: async () => ({
				default(context: any) {
					const category = ref("Exported")
					const title = ref("")
					const loaded = context.notes.reload().then(() => {
						title.value = context.notes.data[0].title
					})
					return { category, title, loaded }
				},
			}),
		})
		await store.initializePage({ name: "standard", is_standard: 1 } as StudioPage, { rows: [notes] })
		await store.pageScriptBindings.loaded
		expect(store.pageScriptTemplateBindings.title).to.equal("Exported")
	})

	it("resolves document filters from script state before fetching", async () => {
		await store.initializePage(
			page(`
			const selected = ref("TEST-NOTE")
			const resolved = ref("")
			const loaded = note.reload().then(() => { resolved.value = note.name })
		`),
			{
				rows: [
					{
						resource_id: "note",
						resource_name: "note",
						resource_type: "Document",
						document_type: "Note",
						auto: false,
						fetch_document_using_filters: true,
						filters: { name: "{{ selected }}" },
					},
				],
			},
		)
		await store.pageScriptBindings.loaded
		expect(store.pageScriptError).to.equal(null)
		expect(store.pageScriptTemplateBindings.resolved).to.equal("TEST-NOTE")
		expect(requests).to.have.length(1)
	})

	it("coalesces an immediate watcher and auto-fetch, with fresh params on updates", async () => {
		await store.initializePage(
			page(`
			const category = ref("News")
			watch(category, () => notes.reload(), { immediate: true })
		`),
			{ rows: [{ ...notes, auto: true }] },
		)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(requests.map((r) => r.params.category)).to.deep.equal(["News"])
		store.pageScriptBindings.category.value = "Tech"
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(requests.map((r) => r.params.category)).to.deep.equal(["News", "Tech"])
	})

	it("preserves explicit params and does not coalesce submissions", async () => {
		await store.initializePage(
			page(`
			const category = ref("News")
			const loaded = Promise.all([
				notes.submit({ category: "First" }),
				notes.submit({ category: "Second" }),
			])
		`),
			{ rows: [notes] },
		)
		await store.pageScriptBindings.loaded
		expect(requests.map((r) => r.params.category)).to.deep.equal(["First", "Second"])
	})

	it("honors direct params assignments", async () => {
		await store.initializePage(
			page(`
			const category = ref("News")
			notes.params = { category: "Assigned" }
			const loaded = notes.reload()
		`),
			{ rows: [notes] },
		)
		await store.pageScriptBindings.loaded
		expect(requests[0].params.category).to.equal("Assigned")
	})

	it("evaluates list filters after setup and coalesces the initial auto-fetch", async () => {
		await store.initializePage(
			page(`
			const category = ref("News")
			const loaded = notes.reload()
		`),
			{
				rows: [
					{
						...notes,
						resource_type: "Document List",
						document_type: "Note",
						filters: { category: "{{ category }}" },
						auto: true,
					},
				],
			},
		)
		await store.pageScriptBindings.loaded
		expect(requests).to.have.length(1)
		expect(requests[0].params.filters).to.deep.equal({ category: "News" })
	})

	it("keeps document methods stable while a dependent name becomes available", async () => {
		await store.initializePage(
			page(`
			const selected = ref(null)
			const title = computed(() => note.doc?.name || "")
			watch(selected, value => { if (value) note.reload() }, { immediate: true })
		`),
			{
				rows: [
					{
						resource_id: "note",
						resource_name: "note",
						resource_type: "Document",
						document_type: "Note",
						auto: true,
						fetch_document_using_filters: true,
						filters: { name: "{{ selected }}" },
					},
				],
			},
		)
		const reload = store.resources.note.reload
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(requests).to.have.length(0)
		store.pageScriptBindings.selected.value = "FIRST"
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(store.pageScriptTemplateBindings.title).to.equal("FIRST")
		store.pageScriptBindings.selected.value = "SECOND"
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(store.pageScriptTemplateBindings.title).to.equal("SECOND")
		expect(store.resources.note.reload).to.equal(reload)
		expect(requests.map((r) => r.params.name)).to.deep.equal(["FIRST", "SECOND"])
	})

	it("explains how to migrate an async setup", async () => {
		setPageScriptImporters({
			standard: async () => ({ default: async () => ({ title: "Too late" }) }),
		})
		await store.initializePage({ name: "standard", is_standard: 1 } as StudioPage, { rows: [] })
		expect(store.pageScriptError).to.contain("synchronously")
		expect(store.pageScriptBindings).to.deep.equal({})
	})
})

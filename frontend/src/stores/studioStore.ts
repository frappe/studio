import { ref, reactive, computed, nextTick, Ref, watch } from "vue"
import router from "@/router/studio_router"
import { defineStore } from "pinia"

import {
	getBlockInstance,
	getRootBlock,
	jsToJson,
	getBlockCopyWithoutParent,
	jsonToJs,
	fetchApp,
	fetchPage,
	getNewResource,
	confirm,
	getInitialVariableValue,
	getBlockCopy,
} from "@/utils/helpers"
import { studioPages } from "@/data/studioPages"
import { studioPageResources } from "@/data/studioResources"
import { studioApps } from "@/data/studioApps"

import Block from "@/utils/block"
import useCanvasStore from "@/stores/canvasStore"

import type { StudioApp } from "@/types/Studio/StudioApp"
import type { StudioPage } from "@/types/Studio/StudioPage"
import type { Resource } from "@/types/Studio/StudioResource"
import { EditingMode, LeftPanelOptions, RightPanelOptions, Slot } from "@/types"
import ComponentContextMenu from "@/components/ComponentContextMenu.vue"
import { studioVariables } from "@/data/studioVariables"
import { Variable } from "@/types/Studio/StudioPageVariable"
import { toast } from "vue-sonner"
import { createResource } from "frappe-ui"

const useStudioStore = defineStore("store", () => {
	const studioLayout = reactive({
		leftPanelWidth: 300,
		rightPanelWidth: 275,
		showLeftPanel: true,
		showRightPanel: true,
		leftPanelActiveTab: <LeftPanelOptions>"Add Component",
		rightPanelActiveTab: <RightPanelOptions>"Properties",
	})
	const activeBreakpoint = ref("desktop")
	const guides = reactive({
		showX: false,
		showY: false,
		x: 0,
		y: 0,
	})
	const componentContextMenu = ref<InstanceType<typeof ComponentContextMenu> | null>(null)

	// fragment mode
	const editingMode = ref<EditingMode>("page")
	const fragmentData = ref({
		block: <Block | null>null,
		saveAction: <Function | null>null,
		saveActionLabel: <string | null>null,
		fragmentName: <string | null>null,
		fragmentId: <string | null>null,
	})

	async function editOnCanvas(
		block: Block,
		saveAction: (block: Block) => void,
		saveActionLabel: string = "Save",
		fragmentName?: string,
		fragmentId?: string
	) {
		const blockCopy = getBlockCopy(block, true)
		fragmentData.value = {
			block: blockCopy,
			saveAction,
			saveActionLabel,
			fragmentName: fragmentName || block.componentName,
			fragmentId: fragmentId || block.componentId
		}
		editingMode.value = "fragment"
	}

	async function exitFragmentMode(e?: Event) {
		if (editingMode.value === "page") return
		e?.preventDefault()

		clearSelection()
		editingMode.value = "page"
		fragmentData.value = {
			block: null,
			saveAction: null,
			saveActionLabel: null,
			fragmentName: null,
			fragmentId: null,
		}
	}

	// block hover & selection
	const hoveredBlock = ref<string | null>(null)
	const hoveredBreakpoint = ref<string | null>(null)
	const selectedBlockIds = ref<Set<string>>(new Set())
	const selectedBlocks = computed(() => {
		return (
			Array.from(selectedBlockIds.value)
				.map((id) => activeCanvas.value?.findBlock(id))
				// filter out missing blocks/null values
				.filter((b) => b)
		)
	}) as Ref<Block[]>

	function selectBlock(block: Block, e: MouseEvent | null, multiSelect = false) {
		if (settingPage.value) return
		selectBlockById(block.componentId, e, multiSelect)
	}

	function selectBlockById(blockId: string, e: MouseEvent | null, multiSelect = false) {
		if (multiSelect) {
			selectedBlockIds.value.add(blockId)
		} else {
			selectedBlockIds.value = new Set([blockId])
		}
	}

	function clearSelection() {
		selectedBlockIds.value = new Set()
	}

	// slots
	const showSlotEditorDialog = ref(false)

	const selectedSlot = ref<Slot | null>()
	function selectSlot(slot: Slot) {
		selectedSlot.value = slot
		selectBlockById(slot.parentBlockId, null)
	}

	const activeSlotIds = computed(() => {
		const slotIds = new Set<string>()
		for (const block of selectedBlocks.value) {
			for (const slot of Object.values(block.componentSlots)) {
				slotIds.add(slot.slotId)
			}
		}
		return slotIds
	})

	watch(
		() => activeSlotIds.value,
		(map) => {
			// clear selected slot if the block is deleted, not selected anymore, or the slot is removed from the block
			if (selectedSlot.value && !map.has(selectedSlot.value.slotId)) {
				selectedSlot.value = null
			}
		},
		{ immediate: true }
	)

	// studio apps
	const activeApp = ref<StudioApp | null>(null)
	const appPages = ref<Record<string, StudioPage>>({})

	async function setApp(appName: string) {
		const appDoc = await fetchApp(appName)
		activeApp.value = appDoc
		await setAppPages(appName)
	}

	async function setAppPages(appName: string) {
		if (!appName) {
			return
		}
		studioPages.filters = { studio_app : appName }
		await studioPages.reload()
		appPages.value = {}

		studioPages.data.map((page: StudioPage) => {
			appPages.value[page.name] = page
		})
	}

	async function setAppHome(appName: string, pageName: string) {
		await studioApps.setValue.submit({ name: appName, app_home: pageName })
		setApp(appName)
	}

	async function deleteAppPage(appName: string, page: StudioPage) {
		// TODO: disallow deleting app home or app with only one page
		const confirmed = await confirm(`Are you sure you want to delete the page <b>${page.page_title}</b>?`)
		if (confirmed) {
			await studioPages.delete.submit(page.name)
			await setApp(appName)
		}
	}

	async function duplicateAppPage(appName: string, page: StudioPage) {
		toast.promise(
			createResource({
				url: "studio.studio.doctype.studio_page.studio_page.duplicate_page",
				method: "POST",
				params: {
					page_name: page.name,
					app_name: appName,
				}
			}).fetch(),
			{
				loading: "Duplicating page",
				success: (page: StudioPage) => {
					// load page and refresh
					router.push({
						name: "StudioPage",
						params: { appID: appName, pageID: page.name },
					})
					return "Page duplicated"
				},
			},
		)
	}

	function getAppPageRoute(pageName: string) {
		return Object.values(appPages.value).find((page) => page.name === pageName)?.route
	}

	// studio pages
	const activePage = ref<StudioPage | null>(null)
	const pageBlocks = ref<Block[]>([])
	const selectedPage = ref<string | null>(null)
	const savingPage = ref(false)
	const settingPage = ref(false)

	async function setPage(pageName: string) {
		settingPage.value = true
		const page = await fetchPage(pageName)
		activePage.value = page

		const blocks = jsonToJs(page.draft_blocks || page.blocks || "[]")
		if (blocks.length === 0) {
			pageBlocks.value = [getRootBlock()]
		} else {
			pageBlocks.value = [getBlockInstance(blocks[0])]
		}
		selectedPage.value = page.name
		await setPageData(page)

		const canvasStore = useCanvasStore()
		canvasStore.activeCanvas?.setRootBlock(pageBlocks.value[0])

		nextTick(() => {
			settingPage.value = false
		})
	}

	function savePage() {
		const canvasStore = useCanvasStore()
		if (canvasStore?.activeCanvas) {
			pageBlocks.value = [canvasStore.activeCanvas.getRootBlock()]
		}
		const pageData = jsToJson(pageBlocks.value.map((block) => getBlockCopyWithoutParent(block)))

		const args = {
			name: selectedPage.value,
			draft_blocks: pageData,
		}
		return studioPages.setValue.submit(args)
			.then((page: StudioPage) => {
				activePage.value = page
			})
			.finally(() => {
				savingPage.value = false
			})
	}

	function updateActivePage(key: string, value: string) {
		return studioPages.setValue.submit(
			{ name: activePage.value?.name, [key]: value },
			{
				onSuccess() {
					activePage.value![key] = value
					setAppPages(activeApp.value!.name)
				},
			},
		)
	}

	async function publishPage() {
		if (!selectedPage.value) return
		return studioPages.runDocMethod
			.submit({
				name: selectedPage.value,
				method: "publish",
			})
			.then(async () => {
				activePage.value = await fetchPage(selectedPage.value!)
				if (activeApp.value && activePage.value) {
					openPageInBrowser(activeApp.value, activePage.value)
				}
			})
	}

	function openPageInBrowser(app: StudioApp, page: StudioPage) {
		let route = `${window.site_url}/${app.route}${page.route}`
		window.open(route, "studio-preview")
	}

	// styles
	const stylePropertyFilter = ref<string | null>(null)

	// data
	const resources = ref<Record<string, Resource>>({})
	const variableConfigs = ref<Record<string, Variable>>({})
	const variables = ref<Record<string, any>>({})

	async function setPageData(page: StudioPage) {
		await setPageResources(page)
		await setPageVariables(page)
	}

	async function setPageResources(page: StudioPage) {
		studioPageResources.filters = { parent: page.name }
		await studioPageResources.reload()
		resources.value = {}

		const resourcePromises = studioPageResources.data.map(async (resource: Resource) => {
			const newResource = await getNewResource(resource)
			return {
				resource_name: resource.resource_name,
				value: newResource,
				resource_id: resource.resource_id,
				resource_child_table_id: resource.name,
			}
		})

		const resolvedResources = await Promise.all(resourcePromises)

		resolvedResources.forEach((item) => {
			resources.value[item.resource_name] = item.value
			if (!item.value) return
			resources.value[item.resource_name].resource_id = item.resource_id
			resources.value[item.resource_name].resource_child_table_id = item.resource_child_table_id
		})
	}

	async function setPageVariables(page: StudioPage) {
		studioVariables.filters = { parent: page.name }
		await studioVariables.reload()
		variableConfigs.value = {}
		variables.value = {}

		studioVariables.data.map((variable: Variable) => {
			variableConfigs.value[variable.variable_name] = variable
			variables.value[variable.variable_name] = getInitialVariableValue(variable)
		})
	}

	return {
		// layout
		studioLayout,
		activeBreakpoint,
		guides,
		componentContextMenu,
		// fragment mode
		editingMode,
		fragmentData,
		editOnCanvas,
		exitFragmentMode,
		// block hover & selection
		hoveredBlock,
		hoveredBreakpoint,
		selectedBlockIds,
		selectedBlocks,
		selectBlock,
		selectBlockById,
		clearSelection,
		pageBlocks,
		// slots
		selectedSlot,
		selectSlot,
		showSlotEditorDialog,
		activeSlotIds,
		// studio app
		activeApp,
		setApp,
		setAppHome,
		deleteAppPage,
		duplicateAppPage,
		appPages,
		setAppPages,
		getAppPageRoute,
		// studio pages
		selectedPage,
		settingPage,
		savingPage,
		activePage,
		setPage,
		savePage,
		updateActivePage,
		publishPage,
		openPageInBrowser,
		// styles
		stylePropertyFilter,
		// data
		resources,
		variables,
		variableConfigs,
		setPageData,
		setPageResources,
		setPageVariables,
	}
})

export default useStudioStore

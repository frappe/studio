import { ref, reactive, computed, nextTick, Ref } from "vue"
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
} from "@/utils/helpers"
import { studioPages } from "@/data/studioPages"
import { studioPageResources } from "@/data/studioResources"
import { studioApps, studioAppPages } from "@/data/studioApps"

import StudioCanvas from "@/components/StudioCanvas.vue"
import Block from "@/utils/block"

import type { StudioApp } from "@/types/Studio/StudioApp"
import type { StudioPage } from "@/types/Studio/StudioPage"
import type { Resource } from "@/types/Studio/StudioResource"
import { LeftPanelOptions, RightPanelOptions } from "@/types"

const useStudioStore = defineStore("store", () => {
	const canvas = ref<InstanceType<typeof StudioCanvas> | null>(null)
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

	// block hover & selection
	const hoveredBlock = ref<string | null>(null)
	const hoveredBreakpoint = ref<string | null>(null)
	const selectedBlockIds = ref<string[]>([])
	const selectedBlocks = computed(() => {
		return (
			selectedBlockIds.value
				.map((id) => canvas.value?.findBlock(id))
				// filter out missing blocks/null values
				.filter((b) => b)
		)
	}) as Ref<Block[]>

	function selectBlock(block: Block, e: MouseEvent | null, multiSelect = false) {
		if (multiSelect) {
			selectedBlockIds.value.push(block.componentId)
		} else {
			selectedBlockIds.value.splice(0, selectedBlockIds.value.length, block.componentId)
		}
		studioLayout.leftPanelActiveTab = "Layers"
	}

	// slots
	const selectedSlot = ref<string | null>()
	function selectSlot(slotName: string) {
		selectedSlot.value = slotName
	}

	const showSlotEditorDialog = ref(false)

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
		studioAppPages.filters = { parent: appName }
		await studioAppPages.reload()
		appPages.value = {}

		studioAppPages.data.map((page: StudioPage) => {
			appPages.value[page.page_name] = page
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
			// delink page from app
			await studioAppPages.delete.submit(page.name)
			try {
				// try deleting the main page
				await studioPages.delete.submit(page.page_name)
			} catch (e) {
				// ignore error - might be linked to other apps
			}
			await setApp(appName)
		}
	}

	function getAppPageRoute(pageName: string) {
		return Object.values(appPages.value).find((page) => page.page_name === pageName)?.route
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
		await setPageResources(page)
		canvas.value?.setRootBlock(pageBlocks.value[0])

		nextTick(() => {
			settingPage.value = false
		})
	}

	function savePage() {
		if (canvas.value) {
			pageBlocks.value = [canvas.value.getRootBlock()]
		}
		const pageData = jsToJson(pageBlocks.value.map((block) => getBlockCopyWithoutParent(block)))

		const args = {
			name: selectedPage.value,
			draft_blocks: pageData,
		}
		return studioPages.setValue.submit(args).finally(() => {
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
				if (activePage.value) {
					openPageInBrowser(activePage.value)
				}
			})
	}

	function openPageInBrowser(page: StudioPage) {
		let route = page.route
		window.open(`/${route}`, "studio-preview")
	}

	// styles
	const stylePropertyFilter = ref<string | null>(null)

	// data
	const resources = ref<Record<string, Resource>>({})

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

	return {
		// layout
		canvas,
		studioLayout,
		activeBreakpoint,
		guides,
		// block hover & selection
		hoveredBlock,
		hoveredBreakpoint,
		selectedBlockIds,
		selectedBlocks,
		selectBlock,
		pageBlocks,
		// slots
		selectedSlot,
		selectSlot,
		showSlotEditorDialog,
		// studio app
		activeApp,
		setApp,
		setAppHome,
		deleteAppPage,
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
		setPageResources,
	}
})

export default useStudioStore

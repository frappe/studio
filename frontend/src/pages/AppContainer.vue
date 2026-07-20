<template>
	<AppComponent v-if="rootBlock" :block="rootBlock" />
</template>

<script setup lang="ts">
import { watch, ref } from "vue"
import { useRoute } from "vue-router"
import { usePageMeta } from "frappe-ui"

import { findPageWithRoute } from "@/utils/helpers"
import { getBlockInstance } from "@/utils/serializer"
import { useLivePreview } from "@/utils/useLivePreview"
import AppComponent from "@/components/AppComponent.vue"

import useAppStore from "@/stores/appStore"
import useCodeStore from "@/stores/codeStore"

import type { StudioPage } from "@/types/Studio/StudioPage"
import Block from "@/utils/block"

const store = useAppStore()
const route = useRoute()
const codeStore = useCodeStore()
const page = ref<StudioPage | null>(null)

const rootBlock = ref<Block | null>(null)
let renderedPath: string | null = null

async function loadPage(force: boolean = false) {
	const currentPath = resolvePagePath()
	if (!currentPath) {
		rootBlock.value = null
		renderedPath = null
		return
	}

	const isSamePage = !force && currentPath === renderedPath
	if (!isSamePage) {
		const nextPage = await findPageWithRoute(window.app_name, currentPath)
		if (!nextPage) return
		page.value = nextPage
	}
	if (!page.value) return

	await store.setPageData(page.value)
	await codeStore.setPageScript(page.value, Boolean(page.value.is_standard))

	if (isSamePage) return

	const blocks = window.is_preview
		? JSON.parse(page.value?.draft_blocks || page.value?.blocks)
		: JSON.parse(page.value?.blocks)
	if (blocks) {
		rootBlock.value = getBlockInstance(blocks[0])
		renderedPath = currentPath
	}
}

watch(() => route.path, () => loadPage(), { immediate: true })

if (window.is_preview) useLivePreview(page, () => loadPage(true))

function resolvePagePath() {
	if (route.meta?.isDynamic) return route.matched?.[0]?.path
	const { pageRoute } = route.params as { pageRoute: string[] }
	return pageRoute ? pageRoute[0] : "/"
}

usePageMeta(() => {
	return {
		title: page.value?.page_title,
	}
})
</script>

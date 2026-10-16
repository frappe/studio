<template>
	<div class="h-full">
		<FrappeUIProvider>
			<!-- one page instance per page: a different page, or a preview reload, mounts fresh -->
			<router-view v-slot="{ Component, route }">
				<ErrorPage v-if="route.meta.loadError" :error="route.meta.loadError" />
				<component v-else :is="Component" :key="`${route.meta.pageName}:${revision}`" />
			</router-view>
		</FrappeUIProvider>
	</div>
</template>

<script setup lang="ts">
import { ref } from "vue"
import { FrappeUIProvider } from "frappe-ui"
import ErrorPage from "@/pages/ErrorPage.vue"
import { useLivePreview } from "@/utils/useLivePreview"

const revision = window.is_preview ? useLivePreview() : ref(0)
</script>

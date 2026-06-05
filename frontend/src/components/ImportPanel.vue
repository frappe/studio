<template>
	<div class="flex flex-col gap-4">
		<div>
			<p class="text-xs text-gray-500">
				Import pages and components from any installed frappe app into Studio.
			</p>
		</div>

		<!-- App selector -->
		<div class="flex flex-col gap-1.5">
			<span class="text-xs font-medium text-gray-700">Select App</span>
			<Select
				v-model="selectedApp"
				:options="appOptions"
				placeholder="Choose a frappe app..."
				@change="onAppChange"
			/>
		</div>

		<!-- Preview -->
		<div v-if="preview.loading" class="flex items-center gap-2 text-xs text-gray-500">
			<FeatherIcon name="loader" class="h-3 w-3 animate-spin" />
			Scanning app...
		</div>

		<div v-else-if="preview.data" class="flex flex-col gap-3">
			<!-- Summary badges -->
			<div class="flex flex-wrap gap-1.5">
				<Badge :label="`${selectedPages.length} pages`" theme="blue" />
				<Badge :label="`${selectedComponents.length} components`" theme="green" />
				<Badge v-if="preview.data.warnings?.length" :label="`${preview.data.warnings.length} warnings`" theme="orange" />
			</div>

			<!-- Pages list -->
			<div class="flex flex-col gap-1">
				<div class="flex items-center justify-between">
					<span class="text-xs font-medium text-gray-700">Pages</span>
					<button class="text-xs text-gray-500 hover:text-gray-700" @click="toggleAllPages">
						{{ allPagesSelected ? "Deselect all" : "Select all" }}
					</button>
				</div>
				<div class="max-h-48 overflow-y-auto rounded border border-gray-100">
					<label
						v-for="page in preview.data.pages"
						:key="page.page_name"
						class="flex cursor-pointer items-center gap-2 border-b border-gray-100 px-2.5 py-1.5 text-xs last:border-0 hover:bg-gray-50"
					>
						<input
							type="checkbox"
							:value="page.page_name"
							v-model="selectedPages"
							class="rounded"
						/>
						<span class="truncate text-gray-800">{{ page.page_title }}</span>
						<span class="ml-auto shrink-0 text-gray-400">{{ page.route }}</span>
					</label>
				</div>
			</div>

			<!-- Components summary -->
			<div class="flex flex-col gap-1">
				<div class="flex items-center justify-between">
					<span class="text-xs font-medium text-gray-700">Components</span>
					<button class="text-xs text-gray-500 hover:text-gray-700" @click="toggleAllComponents">
						{{ allComponentsSelected ? "Deselect all" : "Select all" }}
					</button>
				</div>
				<div class="max-h-32 overflow-y-auto rounded border border-gray-100">
					<label
						v-for="comp in preview.data.components"
						:key="comp.component_id"
						class="flex cursor-pointer items-center gap-2 border-b border-gray-100 px-2.5 py-1.5 text-xs last:border-0 hover:bg-gray-50"
					>
						<input
							type="checkbox"
							:value="comp.component_id"
							v-model="selectedComponents"
							class="rounded"
						/>
						<span class="truncate text-gray-800">{{ comp.component_name }}</span>
					</label>
				</div>
			</div>

			<!-- Warnings -->
			<div v-if="preview.data.warnings?.length" class="rounded border border-orange-100 bg-orange-50 p-2">
				<p class="mb-1 text-xs font-medium text-orange-700">Warnings</p>
				<ul class="space-y-0.5">
					<li
						v-for="(w, i) in preview.data.warnings"
						:key="i"
						class="text-xs text-orange-600"
					>
						{{ w }}
					</li>
				</ul>
			</div>

			<!-- Import button -->
			<Button
				label="Import"
				variant="solid"
				:loading="importing"
				:disabled="!selectedPages.length && !selectedComponents.length"
				@click="runImport"
			/>
		</div>

		<!-- Result -->
		<div v-if="importResult" class="rounded border border-green-100 bg-green-50 p-3">
			<p class="text-xs font-medium text-green-700">Import complete</p>
			<p class="mt-0.5 text-xs text-green-600">
				{{ importResult.pages_imported }} pages · {{ importResult.components_imported }} components imported
			</p>
		</div>

		<div v-if="importError" class="rounded border border-red-100 bg-red-50 p-3">
			<p class="text-xs font-medium text-red-700">Import failed</p>
			<p class="mt-0.5 whitespace-pre-wrap font-mono text-xs text-red-600">{{ importError }}</p>
		</div>
	</div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue"
import { createResource, Badge, Select, Button, FeatherIcon } from "frappe-ui"

const selectedApp = ref("")
const selectedPages = ref<string[]>([])
const selectedComponents = ref<string[]>([])
const importing = ref(false)
const importResult = ref<{ pages_imported: number; components_imported: number } | null>(null)
const importError = ref<string | null>(null)

const importableApps = createResource({
	url: "studio.api.get_importable_apps",
	auto: true,
})

const appOptions = computed(() =>
	(importableApps.data || []).map((a: { app: string }) => ({
		label: a.app,
		value: a.app,
	}))
)

const preview = createResource({
	url: "studio.api.preview_import",
	onSuccess(data: any) {
		selectedPages.value = data.pages?.map((p: any) => p.page_name) ?? []
		selectedComponents.value = data.components?.map((c: any) => c.component_id) ?? []
	},
})

function onAppChange() {
	if (!selectedApp.value) return
	importResult.value = null
	importError.value = null
	preview.submit({ frappe_app: selectedApp.value })
}

const allPagesSelected = computed(
	() => selectedPages.value.length === (preview.data?.pages?.length ?? 0)
)

const allComponentsSelected = computed(
	() => selectedComponents.value.length === (preview.data?.components?.length ?? 0)
)

function toggleAllPages() {
	selectedPages.value = allPagesSelected.value
		? []
		: preview.data.pages.map((p: any) => p.page_name)
}

function toggleAllComponents() {
	selectedComponents.value = allComponentsSelected.value
		? []
		: preview.data.components.map((c: any) => c.component_id)
}

async function runImport() {
	importing.value = true
	importResult.value = null
	importError.value = null

	try {
		const logName = await createResource({
			url: "studio.api.start_import",
		}).submit({
			frappe_app: selectedApp.value,
			selected_pages: selectedPages.value,
			selected_components: selectedComponents.value,
		})

		await pollUntilDone(logName)
	} catch (err: any) {
		importError.value = err.message || String(err)
	} finally {
		importing.value = false
	}
}

async function pollUntilDone(logName: string) {
	const logResource = createResource({
		url: "frappe.client.get",
		params: { doctype: "Studio Import Log", name: logName },
	})

	for (let i = 0; i < 60; i++) {
		await logResource.reload()
		const doc = logResource.data
		if (!doc) break

		if (doc.status === "Complete") {
			importResult.value = {
				pages_imported: doc.pages_imported,
				components_imported: doc.components_imported,
			}
			return
		}

		if (doc.status === "Failed") {
			importError.value = doc.error || "Import failed"
			return
		}

		await sleep(2000)
	}

	importError.value = "Import timed out"
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms))
}
</script>

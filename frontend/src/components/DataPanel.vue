<template>
	<div class="flex flex-col gap-3 p-4">
		<CollapsibleSection sectionName="Data Sources">
			<div class="ml-3 flex flex-col gap-1" v-if="!isObjectEmpty(codeStore.resources)">
				<div
					v-for="(resource, resource_name) in codeStore.resources"
					:key="resource_name"
					class="group/item flex flex-row items-center justify-between"
				>
					<div class="-ml-[0.9rem] flex items-center gap-1 overflow-hidden">
						<ObjectBrowser :object="resource" :name="resource_name" />
						<Tooltip v-if="!resource" text="No matching document found for the current filters">
							<span class="lucide-alert-circle h-[14px] w-[14px] cursor-pointer text-ink-amber-6" />
						</Tooltip>
					</div>
					<ItemActions
						class="-mt-1 self-start"
						:menuOptions="getResourceMenu(resource_name)"
						@edit="openResource(resource_name)"
					/>
				</div>
			</div>

			<EmptyState v-else message="No resources added" />

			<div class="mt-2 flex flex-col" v-if="store.activePage">
				<Button icon-left="plus" @click="showResourceDialog = true">Add Data Source</Button>
				<ResourceDialog
					v-model:showDialog="showResourceDialog"
					:resource="existingResource"
					@addResource="addResource"
					@editResource="editResource"
				/>
			</div>
		</CollapsibleSection>
	</div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue"
import { Tooltip, Button } from "frappe-ui"
import useStudioStore from "@/stores/studioStore"
import useCodeStore from "@/stores/codeStore"
import CollapsibleSection from "@/components/CollapsibleSection.vue"
import ObjectBrowser from "@/components/ObjectBrowser.vue"
import EmptyState from "@/components/EmptyState.vue"
import ResourceDialog from "@/components/ResourceDialog.vue"
import ItemActions from "@/components/ItemActions.vue"

import { isObjectEmpty, getAutocompleteValues, getParamsObj, confirm, copyToClipboard } from "@/utils/helpers"
import { studioPageResources } from "@/data/studioResources"
import type { Resource } from "@/types/Studio/StudioResource"
import { toast } from "frappe-ui"
import { copyDataSource } from "@/utils/blockCopyPaste"

/**
 * Insert resource into DB
 * fetch resources attached to page in store
 * show resources on the data panel
 */

const store = useStudioStore()
const codeStore = useCodeStore()
const showResourceDialog = ref(false)
const existingResource = ref<Resource | null>()

watch(showResourceDialog, (show) => {
	if (!show) {
		existingResource.value = null
	}
})

const addResource = (resource: Resource) => {
	if (!resource.resource_name) {
		toast.error("Data Source Name is required")
		return
	}

	studioPageResources.insert
		.submit({
			...getResourceValues(resource),
			parent: store.activePage?.name,
			parenttype: "Studio Page",
			parentfield: "resources",
		})
		.then(async (data: any) => {
			if (store.activePage) {
				await codeStore.setPageResources(store.activePage, true)
				store.syncPageModified(data)
			}
			showResourceDialog.value = false
		})
}

const deleteResource = async (resource_name: string) => {
	const confirmed = await confirm(`Are you sure you want to delete the data source ${resource_name}?`)
	if (!confirmed) return
	const stored = await getStoredResource(resource_name)
	if (!stored) return
	studioPageResources.delete
		.submit(stored.resource_id)
		.then(async () => {
			if (store.activePage) {
				await codeStore.setPageResources(store.activePage, true)
				await store.refreshActivePageModified()
			}
			toast.success(`Data Source ${resource_name} deleted successfully`)
		})
		.catch(() => {
			toast.error(`Failed to delete data source ${resource_name}`)
		})
}

const editResource = async (resource: Resource) => {
	return studioPageResources.setValue
		.submit(getResourceValues(resource))
		.then(async (data: any) => {
			if (store.activePage) {
				await codeStore.setPageResources(store.activePage, true)
				store.syncPageModified(data)
			}
			toast.success(`Data Source ${resource.resource_name} updated successfully`)
			showResourceDialog.value = false
		})
		.catch(() => {
			toast.error(`Failed to update data source ${resource.resource_name}`)
		})
}

const getResourceValues = (resource: Resource) => {
	return {
		...resource,
		name: resource.resource_id,
		fields: getAutocompleteValues(resource.fields),
		whitelisted_methods: getAutocompleteValues(resource.whitelisted_methods),
		params: getParamsObj(resource.params),
	}
}

const openResource = async (resource_name: string) => {
	existingResource.value = await getStoredResource(resource_name)
	showResourceDialog.value = true
}

const getStoredResource = async (resource_name: string) => {
	studioPageResources.filters = {
		parent: store.activePage?.name,
		resource_name: resource_name,
	}
	await studioPageResources.reload()
	return studioPageResources.data[0]
}

const getResourceMenu = (resource_name: string) => {
	return [
		{
			label: "Delete",
			icon: "lucide-trash",
			theme: "red",
			onClick: () => deleteResource(resource_name),
		},
		{
			label: "Copy",
			icon: "lucide-copy",
			onClick: () => copyDataSource(getStoredResource(resource_name), resource_name),
		},
	]
}
</script>

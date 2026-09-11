<template>
	<div
		role="alert"
		class="relative z-40 flex h-8 items-center gap-2 border-b border-outline-amber-3 bg-surface-amber-2 px-3 text-sm text-ink-gray-8"
	>
		<FeatherIcon name="alert-circle" class="h-3.5 w-3.5 shrink-0 text-ink-amber-6" />
		<p class="min-w-0 flex-1 truncate">{{ message }}</p>
		<button
			v-if="action"
			type="button"
			class="shrink-0 font-medium text-ink-gray-8 underline"
			@click="action.onClick"
		>
			{{ action.label }}
		</button>
		<button
			type="button"
			aria-label="Dismiss warning"
			title="Dismiss warning"
			class="grid h-6 w-6 shrink-0 place-items-center rounded hover:bg-surface-amber-3"
			@click="emit('dismiss')"
		>
			<span class="lucide-x h-3.5 w-3.5" />
		</button>
	</div>
</template>

<script setup lang="ts">
import { FeatherIcon } from "frappe-ui"

import type { AlertAction } from "@/stores/alertStore"

defineProps<{
	message: string
	action?: AlertAction
}>()

const emit = defineEmits<{
	dismiss: []
}>()
</script>

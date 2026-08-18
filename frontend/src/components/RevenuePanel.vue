<template>
	<div class="flex flex-1 flex-col overflow-hidden bg-surface-base">
		<!-- Header -->
		<div
			class="flex shrink-0 items-center justify-between border-b border-outline-gray-1 bg-surface-base px-3 py-2.5"
		>
			<div class="flex items-center gap-1.5 text-xs font-medium text-ink-gray-7">
				<LucideTrendingUp class="h-4 w-4 text-ink-gray-6" />
				<span>Revenue Recommendations</span>
			</div>
			<Button
				v-if="analysisResult && !loading"
				variant="ghost"
				size="sm"
				icon="refresh-cw"
				title="Re-analyze Page"
				@click="analyzeRevenue"
			/>
		</div>

		<!-- AI Key Check -->
		<div v-if="!isAIEnabled" class="flex flex-1 flex-col items-start gap-3 p-4">
			<p class="text-p-xs text-ink-gray-6">
				Configure an AI API key in Studio Settings to analyze page revenue opportunities.
			</p>
			<Button variant="subtle" label="Open Settings" @click="store.showStudioSettingsDialog = true" />
		</div>

		<!-- Main Content Container -->
		<div v-else class="no-scrollbar flex-1 space-y-4 overflow-y-auto px-4 py-4">
			<!-- Initial Empty State -->
			<div
				v-if="!analysisResult && !loading && !error"
				class="flex h-full flex-col items-center justify-center gap-3 py-12 text-center"
			>
				<div class="flex h-12 w-12 items-center justify-center rounded-full bg-surface-gray-2 text-ink-gray-6">
					<LucideDollarSign class="h-6 w-6" />
				</div>
				<div class="max-w-xs space-y-1">
					<h4 class="text-xs font-semibold text-ink-gray-8">Analyze Page Monetization</h4>
					<p class="text-[11px] leading-relaxed text-ink-gray-5">
						Inspect your current page structure, components, copy, and layout to discover contextual revenue opportunities.
					</p>
				</div>
				<Button
					variant="solid"
					label="Analyze Page Revenue"
					icon="sparkles"
					class="mt-2"
					@click="analyzeRevenue"
				/>
			</div>

			<!-- Loading State -->
			<div v-if="loading" class="flex flex-col items-center justify-center gap-3 py-16 text-center">
				<div class="flex h-10 w-10 items-center justify-center rounded-full bg-surface-gray-2 text-ink-gray-7">
					<FeatherIcon name="loader" class="h-5 w-5 animate-spin" />
				</div>
				<div class="space-y-1">
					<p class="text-xs font-medium text-ink-gray-8">Analyzing website structure & content…</p>
					<p class="text-[11px] text-ink-gray-5">Evaluating monetization potential with AI</p>
				</div>
			</div>

			<!-- Error State -->
			<ErrorMessage v-if="error" :message="error" class="my-2" />

			<!-- Analysis Results -->
			<template v-if="analysisResult && !loading">
				<!-- Page Summary Banner -->
				<div
					v-if="analysisResult.page_summary"
					class="rounded-lg border border-outline-gray-2 bg-surface-elevation-1 p-3.5 space-y-1.5"
				>
					<div class="flex items-center justify-between">
						<span class="text-[11px] font-semibold uppercase tracking-wider text-ink-gray-5">
							Page Purpose
						</span>
						<Badge
							v-if="analysisResult.page_summary.detected_type"
							variant="subtle"
							theme="blue"
							size="sm"
							:label="analysisResult.page_summary.detected_type"
						/>
					</div>
					<p class="text-xs text-ink-gray-7 leading-relaxed">
						{{ analysisResult.page_summary.purpose }}
					</p>
				</div>

				<!-- Recommendation Cards List -->
				<div class="space-y-3.5">
					<div class="flex items-center justify-between px-0.5">
						<span class="text-[11px] font-semibold uppercase tracking-wider text-ink-gray-5">
							Recommended Strategies ({{ recommendations.length }})
						</span>
					</div>

					<div
						v-for="(rec, idx) in recommendations"
						:key="rec.id || idx"
						class="rounded-lg border border-outline-gray-2 bg-surface-base p-3.5 space-y-3 transition-shadow hover:shadow-sm"
					>
						<!-- Card Header: Title & Badges -->
						<div class="space-y-2">
							<div class="flex items-start justify-between gap-2">
								<h5 class="text-xs font-bold text-ink-gray-9 leading-snug">
									{{ rec.strategy }}
								</h5>
								<Badge
									v-if="rec.category"
									variant="outline"
									theme="gray"
									size="sm"
									:label="rec.category"
									class="shrink-0"
								/>
							</div>

							<!-- Metrics Badges (Potential, Difficulty, Priority) -->
							<div class="flex flex-wrap items-center gap-1.5 text-[10px]">
								<Badge
									:theme="getPotentialTheme(rec.potential)"
									variant="subtle"
									size="sm"
									:label="`Potential: ${rec.potential || 'Medium'}`"
								/>
								<Badge
									:theme="getDifficultyTheme(rec.difficulty)"
									variant="subtle"
									size="sm"
									:label="`Difficulty: ${rec.difficulty || 'Medium'}`"
								/>
								<Badge
									v-if="rec.priority"
									theme="gray"
									variant="subtle"
									size="sm"
									:label="`Priority: ${rec.priority}`"
								/>
							</div>
						</div>

						<!-- Why it fits -->
						<div class="space-y-1 rounded bg-surface-gray-1 p-2.5">
							<div class="text-[10px] font-bold uppercase tracking-wider text-ink-gray-5">
								Why it fits this page
							</div>
							<p class="text-xs text-ink-gray-7 leading-relaxed">
								{{ rec.why_fits }}
							</p>
						</div>

						<!-- How it works -->
						<div class="space-y-1">
							<div class="text-[10px] font-bold uppercase tracking-wider text-ink-gray-5">
								Monetization Model
							</div>
							<p class="text-xs text-ink-gray-7 leading-relaxed">
								{{ rec.how_it_works }}
							</p>
						</div>

						<!-- Studio Implementation Steps -->
						<div v-if="rec.studio_implementation?.length" class="space-y-1.5 pt-1 border-t border-outline-gray-1">
							<div class="text-[10px] font-bold uppercase tracking-wider text-ink-gray-5">
								Studio Implementation
							</div>
							<ul class="space-y-1 text-xs text-ink-gray-7">
								<li
									v-for="(step, sIdx) in rec.studio_implementation"
									:key="sIdx"
									class="flex items-start gap-1.5"
								>
									<LucideCheckCircle2 class="h-3.5 w-3.5 text-ink-green-4 shrink-0 mt-0.5" />
									<span>{{ step }}</span>
								</li>
							</ul>
						</div>
					</div>
				</div>

				<!-- Re-analyze button at bottom -->
				<div class="pt-2 text-center">
					<Button
						variant="subtle"
						size="sm"
						label="Refresh Analysis"
						icon="refresh-cw"
						@click="analyzeRevenue"
					/>
				</div>
			</template>
		</div>
	</div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue"
import { Button, Badge, FeatherIcon, ErrorMessage, call } from "frappe-ui"
import useStudioStore from "@/stores/studioStore"
import useCanvasStore from "@/stores/canvasStore"
import { getBlockString } from "@/utils/serializer"
import { studioSettings } from "@/data/studioSettings"

import LucideTrendingUp from "~icons/lucide/trending-up"
import LucideDollarSign from "~icons/lucide/dollar-sign"
import LucideCheckCircle2 from "~icons/lucide/check-circle-2"

const store = useStudioStore()
const canvasStore = useCanvasStore()

const isAIEnabled = computed(() => !!studioSettings.doc?.ai_api_key)

const loading = ref(false)
const error = ref("")
const analysisResult = ref<any>(null)

let currentRequestId = 0

watch(
	() => store.selectedPage,
	() => {
		currentRequestId++
		analysisResult.value = null
		error.value = ""
		loading.value = false
	},
)

const recommendations = computed(() => analysisResult.value?.recommendations ?? [])

function getPageContext(): string {
	const root = store.pageBlocks?.[0] ?? canvasStore.activeCanvas?.getRootBlock()
	return root ? getBlockString(root) : "[]"
}

async function analyzeRevenue() {
	const requestId = ++currentRequestId
	const pageId = store.activePage?.name || store.activePage?.page_name || ""
	const context = getPageContext()

	loading.value = true
	error.value = ""

	try {
		const res: any = await call("studio.ai.revenue.analyze_page_revenue", {
			page_id: pageId,
			page_context: context,
		})

		if (requestId !== currentRequestId) return

		if (res?.status === "success" && res.result) {
			analysisResult.value = res.result
		} else {
			error.value = res?.message || "Failed to analyze page revenue opportunities."
		}
	} catch (e: any) {
		if (requestId !== currentRequestId) return
		error.value = e?.message || "An error occurred while analyzing the page."
	} finally {
		if (requestId === currentRequestId) {
			loading.value = false
		}
	}
}

function getPotentialTheme(potential?: string): string {
	const val = (potential || "").toLowerCase()
	if (val.includes("high")) return "green"
	if (val.includes("medium")) return "blue"
	return "gray"
}

function getDifficultyTheme(difficulty?: string): string {
	const val = (difficulty || "").toLowerCase()
	if (val.includes("low")) return "green"
	if (val.includes("medium")) return "orange"
	return "red"
}
</script>

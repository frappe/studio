<template>
	<div class="flex flex-1 flex-col overflow-hidden bg-surface-base">
		<!-- A failed models fetch is NOT "no providers": the one-shot request can land in a
		     server-restart window (approving a backend write restarts the dev server), and
		     without a retry the panel dead-ends — hiding any pending approval card. -->
		<div v-if="aiModels.error" class="flex flex-1 flex-col items-start gap-3 p-4">
			<p class="text-p-xs text-ink-gray-6">Couldn't load the AI models — {{ modelsErrorHint }}</p>
			<Button variant="solid" label="Retry" @click="retryModels" />
		</div>

		<div v-else-if="!isAIEnabled" class="flex flex-1 flex-col items-start gap-3 p-4">
			<p class="text-p-xs text-ink-gray-6">
				Connect an AI provider — an API key or your ChatGPT subscription — to use the assistant.
			</p>
			<Button variant="solid" label="Connect a provider" @click="showProviders = true" />
		</div>

		<div v-else ref="messagesEl" class="no-scrollbar flex-1 space-y-4 overflow-y-auto px-4 py-4">
			<div
				v-if="!messages.length"
				class="flex h-full flex-col items-center justify-center gap-2 pb-8 text-center"
			>
				<LucideSparkle class="h-8 w-8 text-ink-gray-3" />
				<p class="text-xs text-ink-gray-4">Chat to create or edit this page</p>
			</div>

			<template v-for="msg in messages" :key="msg.id">
				<div v-if="msg.role === 'user'" class="flex flex-col items-end gap-1">
					<img
						v-if="msg.metadata?.attachedImageUrl"
						:src="msg.metadata.attachedImageUrl"
						class="max-h-40 max-w-[88%] rounded-md border border-outline-gray-2 object-contain"
						alt="Attached design"
					/>
					<div
						v-if="msg.content"
						class="w-fit max-w-[88%] rounded-md border bg-surface-gray-1 px-3 py-2 text-p-xs text-ink-gray-8"
					>
						<div class="whitespace-pre-wrap break-words">{{ msg.content }}</div>
					</div>
				</div>
				<div v-else class="flex w-full flex-col items-start gap-2">
					<div
						class="w-fit max-w-full break-words text-p-xs text-ink-gray-8 [&_a]:text-ink-blue-3 [&_a]:underline [&_code]:rounded [&_code]:bg-surface-gray-2 [&_code]:px-1 [&_code]:py-0.5 [&_h1]:my-1.5 [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:my-1.5 [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-surface-gray-2 [&_pre]:p-2 [&_strong]:font-semibold [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5"
						v-html="renderMarkdown(msg.content)"
					/>

					<!-- Proposed plan: data plan + layout plan + palette + approve -->
					<div
						v-if="msg.metadata?.status === 'plan_summary'"
						class="flex w-full min-w-0 flex-col gap-3 rounded-md border border-outline-gray-1 bg-surface-gray-1 p-3"
					>
						<div v-if="msg.metadata.data_plan?.length" class="flex flex-col gap-1">
							<div class="text-[10px] font-semibold uppercase tracking-wide text-ink-gray-5">Data</div>
							<ul class="flex flex-col gap-1">
								<li
									v-for="(item, i) in msg.metadata.data_plan"
									:key="'d' + i"
									class="break-words text-p-xs text-ink-gray-7"
								>
									• {{ item }}
								</li>
							</ul>
						</div>
						<div v-if="msg.metadata.layout_plan?.length" class="flex flex-col gap-1">
							<div class="text-[10px] font-semibold uppercase tracking-wide text-ink-gray-5">Layout</div>
							<ul class="flex flex-col gap-1">
								<li
									v-for="(item, i) in msg.metadata.layout_plan"
									:key="'l' + i"
									class="break-words text-p-xs text-ink-gray-7"
								>
									• {{ item }}
								</li>
							</ul>
						</div>
						<div v-if="msg.metadata.palette" class="break-words text-[11px] text-ink-gray-5">
							Palette: {{ msg.metadata.palette }}
						</div>
						<Button
							v-if="msg.id === lastMessageId"
							variant="outline"
							size="sm"
							label="Approve & build"
							:disabled="loading"
							@click="sendPrompt('Yes, that looks good - go ahead and build it.')"
						/>
					</div>

					<!-- Sensitive action (e.g. a backend file write): diff + Approve/Skip. Gated by
					     the PERSISTED status, never lastMessageId — the card must survive reloads
					     and resolve exactly once. -->
					<div
						v-else-if="isActionCard(msg)"
						class="flex w-full min-w-0 flex-col gap-2 rounded-md border border-outline-gray-1 bg-surface-gray-1 p-3"
					>
						<div class="flex items-center justify-between gap-2">
							<span class="truncate font-mono text-[11px] text-ink-gray-7">
								{{ msg.metadata.title || msg.metadata.file_path }}
							</span>
							<Badge v-if="msg.metadata.status !== 'pending_action'" variant="subtle" size="sm">
								{{ actionStatusLabel(msg.metadata.status) }}
							</Badge>
						</div>
						<div
							v-if="msg.metadata.diff"
							class="max-h-64 overflow-auto rounded p-2 font-mono text-[11px] leading-4"
						>
							<div
								v-for="(line, i) in diffLines(msg.metadata.diff)"
								:key="i"
								class="whitespace-pre px-1"
								:class="diffLineClass(line)"
							>
								{{ line || " " }}
							</div>
						</div>
						<ul v-if="msg.metadata.warnings?.length" class="flex flex-col gap-1">
							<li
								v-for="(warning, i) in msg.metadata.warnings"
								:key="i"
								class="break-words text-[11px] text-ink-amber-3"
							>
								⚠ {{ warning }}
							</li>
						</ul>
						<div v-if="msg.metadata.status === 'pending_action'" class="flex justify-end gap-1.5">
							<Button
								variant="outline"
								size="sm"
								label="Skip"
								:disabled="loading || !!pendingActionBusy"
								@click="resolvePendingAction(msg, 'skip')"
							/>
							<Button
								variant="solid"
								size="sm"
								label="Approve"
								:loading="pendingActionBusy === msg.id"
								:disabled="loading || !!pendingActionBusy"
								@click="resolvePendingAction(msg, 'approve')"
							/>
						</div>
					</div>

					<!-- Clarification: tappable answer options -->
					<div
						v-else-if="
							msg.metadata?.status === 'clarification' &&
							msg.metadata.options?.length &&
							msg.id === lastMessageId
						"
						class="flex flex-wrap gap-1.5"
					>
						<Button
							v-for="(option, i) in msg.metadata.options"
							:key="i"
							variant="outline"
							size="sm"
							:label="option"
							:disabled="loading"
							@click="sendPrompt(option)"
						/>
					</div>
				</div>
			</template>

			<p v-if="loading" class="text-p-xs text-ink-gray-5">
				{{ statusMessage || "Generating…" }}
			</p>
		</div>

		<div v-if="isAIEnabled" class="shrink-0 border-t border-outline-gray-1 bg-surface-base p-4">
			<ErrorMessage v-if="error" :message="error" class="mb-2" />

			<!-- A background page the turn is (or was) building — jump there to watch it stream -->
			<div
				v-if="buildingPage && buildingPage.name !== pageId"
				class="mb-2 flex items-center justify-between gap-2 rounded border border-outline-gray-1 bg-surface-gray-1 px-2 py-1.5"
			>
				<span class="flex min-w-0 items-center gap-1.5 text-xs text-ink-gray-6">
					<LucideSparkle v-if="loading" class="h-3 w-3 shrink-0 animate-pulse text-ink-gray-5" />
					<span class="truncate">{{ buildingVerb }} “{{ buildingPage.title }}”</span>
				</span>
				<div class="flex shrink-0 items-center gap-1">
					<Button size="sm" variant="outline" @click="openBuildingPage">Open</Button>
					<button
						class="rounded p-1 text-ink-gray-5 hover:bg-surface-gray-2 hover:text-ink-gray-7"
						title="Dismiss"
						@click="buildingPage = null"
					>
						<FeatherIcon name="x" class="h-3.5 w-3.5" />
					</button>
				</div>
			</div>

			<div v-if="isModifyMode" class="mb-2 flex items-center gap-1.5 rounded py-1">
				<span class="truncate text-xs text-ink-gray-5">Editing:</span>
				<Badge variant="subtle" size="sm">
					{{ selectedBlock?.blockName || selectedBlock?.componentName }}
				</Badge>
			</div>

			<div v-if="imagePreviewUrl" class="mb-2 flex items-center gap-2">
				<div class="relative">
					<img
						:src="imagePreviewUrl"
						class="h-12 w-12 rounded border border-outline-gray-2 object-cover"
						alt="Attached design"
					/>
					<button
						class="text-ink-white absolute -right-1.5 -top-1.5 rounded-full bg-surface-gray-7 p-0.5 hover:bg-surface-gray-6"
						title="Remove image"
						@click="controller.clearImage()"
					>
						<FeatherIcon name="x" class="h-3 w-3" />
					</button>
				</div>
				<span class="truncate text-xs text-ink-gray-5">{{ imageFileName }}</span>
			</div>

			<div class="relative">
				<textarea
					v-model="prompt"
					rows="4"
					class="w-full resize-none rounded border border-[--surface-gray-2] bg-surface-gray-2 px-2 py-1.5 text-p-sm text-ink-gray-8 placeholder-ink-gray-4 transition-colors hover:border-[--outline-elevation-2] hover:bg-surface-gray-3 focus:border-outline-gray-4 focus:bg-surface-base focus:shadow-sm focus:ring-0 focus-visible:ring-2 focus-visible:ring-outline-gray-3 disabled:cursor-not-allowed disabled:bg-surface-gray-1 disabled:text-ink-gray-5"
					:placeholder="
						isModifyMode ? 'Describe what to change in this block...' : 'Chat to create or edit this page...'
					"
					:disabled="loading"
					@keydown.meta.enter="generate"
					@keydown.ctrl.enter="generate"
					@paste="onPaste"
					@drop="onDropImage"
					@dragover.prevent
				/>
			</div>

			<div class="mt-2 flex items-center justify-between gap-2">
				<div class="flex items-center gap-0.5">
					<Combobox
						v-model="selectedModel"
						trigger="button"
						size="sm"
						side="top"
						align="start"
						:disabled="loading"
						:options="modelComboOptions"
					>
						<template #trigger="{ open, setOpen }">
							<button
								class="flex h-7 max-w-[9rem] items-center gap-1.5 rounded px-1.5 text-ink-gray-5 transition-colors hover:bg-surface-gray-2 hover:text-ink-gray-8"
								@click="setOpen(!open)"
							>
								<FeatherIcon name="cpu" class="h-3.5 w-3.5 shrink-0" />
								<span class="truncate text-xs">{{ modelLabel }}</span>
							</button>
						</template>
					</Combobox>

					<button
						v-if="isVisionModel"
						class="flex h-7 items-center gap-1.5 rounded px-1.5 text-ink-gray-5 transition-colors hover:bg-surface-gray-2 hover:text-ink-gray-8 disabled:cursor-not-allowed disabled:opacity-50"
						title="Attach a screenshot or design to reproduce"
						:disabled="loading"
						@click="imageInput?.click()"
					>
						<FeatherIcon name="image" class="h-3.5 w-3.5 shrink-0" />
					</button>
					<input ref="imageInput" type="file" accept="image/*" class="hidden" @change="onImageSelected" />
				</div>

				<Button v-if="loading" variant="subtle" label="Stop" icon="square" @click="stop" />
				<Button
					v-else
					variant="solid"
					:label="isModifyMode ? 'Edit' : 'Generate'"
					icon="arrow-up"
					:disabled="!prompt.trim() && !imagePreviewUrl"
					@click="generate"
				/>
			</div>
		</div>

		<AIProvidersDialog ref="providersDialog" v-model="showProviders" @changed="aiModels.reload()" />
	</div>
</template>

<script lang="ts" setup>
import { ref, computed, inject, watch, nextTick } from "vue"
import { useRouter } from "vue-router"
import { ErrorMessage, Button, Badge, Combobox, FeatherIcon, call, createResource, toast } from "frappe-ui"
import { marked } from "marked"
import DOMPurify from "dompurify"
import useStudioStore from "@/stores/studioStore"
import useCanvasStore from "@/stores/canvasStore"
import useCodeStore from "@/stores/codeStore"
import { AIChatController } from "@/components/AIChatController"
import AIProvidersDialog from "@/components/AIProvidersDialog.vue"
import { getBlockInstance } from "@/utils/serializer"
import type { BlockOptions } from "@/types"
import LucideSparkle from "~icons/lucide/sparkle"

const store = useStudioStore()
const canvasStore = useCanvasStore()
const codeStore = useCodeStore()
const socket = inject<any>("socket")

// The assistant works when any model's provider is ready (a stored key, an
// OAuth sign-in, or a keyless self-hosted gateway). Managed from the dialog.
const showProviders = ref(false)
const providersDialog = ref<InstanceType<typeof AIProvidersDialog> | null>(null)
const isAIEnabled = computed(() => modelOptions.value.some((m: any) => m.ready))

const prompt = ref("")
const loading = ref(false)
const error = ref("")
const statusMessage = ref("")
const selectedModel = ref("")
const messages = ref<any[]>([])
const messagesEl = ref<HTMLElement | null>(null)

// A plan's "Approve & build" and a clarification's options only make sense for the CURRENT turn —
// the last message. On older ones they're stale (already answered), so gate the buttons on this.
const lastMessageId = computed(() => messages.value[messages.value.length - 1]?.id)

// Sensitive-action cards are different: they're gated by the message's PERSISTED status
// (pending → resolved/expired server-side), so they survive reloads and resolve exactly once.
const ACTION_STATUSES = ["pending_action", "action_applied", "action_skipped", "action_expired"]
const pendingActionBusy = ref<string | number | null>(null)

function isActionCard(msg: any): boolean {
	return !!msg.metadata?.kind && ACTION_STATUSES.includes(msg.metadata?.status)
}

function diffLines(diff: string): string[] {
	return diff.replace(/\n$/, "").split("\n")
}

function diffLineClass(line: string): string {
	if (line.startsWith("+++") || line.startsWith("---")) return "text-ink-gray-4"
	if (line.startsWith("@@")) return "text-ink-gray-5"
	if (line.startsWith("+")) return "bg-surface-green-1 text-ink-green-6"
	if (line.startsWith("-")) return "bg-surface-red-2 text-ink-red-6"
	return "text-ink-gray-7"
}

function actionStatusLabel(status: string): string {
	const labels: Record<string, string> = {
		action_applied: "Applied",
		action_skipped: "Skipped",
		action_expired: "Superseded",
	}
	return labels[status] ?? status
}

async function resolvePendingAction(msg: any, decision: "approve" | "skip") {
	if (loading.value || pendingActionBusy.value) return
	// The transient card (shown before the session reload) carries the persisted
	// message id in metadata; a reloaded card's own id IS the docname.
	const messageId = typeof msg.id === "string" ? msg.id : msg.metadata?.message_id
	if (!messageId) return
	pendingActionBusy.value = msg.id
	try {
		const res: any = await call("studio.ai.api.confirm_pending_action", {
			session_id: controller.sessionId,
			message_id: messageId,
			decision,
		})
		// Re-pull the session first (the server appended the outcome and flipped the
		// card's status) — the reload REPLACES the message list, so the resumed turn's
		// pending bubble must be created after it, never before.
		await sessionResource.submit({
			app_id: appId.value,
			session_id: controller.sessionId || undefined,
		})
		if (res?.resumed) controller.beginResumedTurn("Continuing…")
	} catch (e: any) {
		// Applying a backend write restarts the dev server, which can kill this very
		// request ("socket hang up"). The apply is idempotent server-side, so the
		// honest advice is: wait a beat and press Approve again.
		error.value =
			"Couldn't reach the server while applying — it may have restarted to load the change. " +
			"Wait a few seconds and try again."
		reloadSession()
	} finally {
		pendingActionBusy.value = null
	}
}

const pageId = computed(() => store.activePage?.name ?? "")
// Sessions are scoped to the app; the open page is just the turn's target.
const appId = computed(() => store.activeApp?.name ?? "")
const router = useRouter()

// The page a running turn is building when it isn't the one on the canvas — rendered
// as a chip with an Open button so the user can jump there and watch it stream.
const buildingPage = ref<{ name: string; title: string; action: string } | null>(null)

// "Building" only for a page the turn CREATED; a chip for an existing page the agent
// went back to (nav wiring, tweaks) says "Updating" — "Building" there reads as the
// agent redoing a finished page.
const buildingVerb = computed(() => {
	const created = buildingPage.value?.action === "created"
	if (loading.value) return created ? "Building" : "Updating"
	return created ? "Built" : "Updated"
})

function openBuildingPage() {
	if (!buildingPage.value) return
	router.push({
		name: "StudioPage",
		params: { appID: appId.value, pageID: buildingPage.value.name },
	})
}

const selectedBlock = computed(() => {
	const block = canvasStore.activeCanvas?.selectedBlocks?.[0] ?? null
	if (!block || block.isRoot()) return null
	return block
})

const isModifyMode = computed(() => !!selectedBlock.value)

const aiModels = createResource({
	url: "studio.ai.models.get_ai_models",
	auto: true,
})

function retryModels() {
	aiModels.reload()
	// The session fetch may have failed in the same restart window — re-pull it too
	// so a pending approval card comes back with the models.
	reloadSession()
}

// Logged-out and server-restarting both land here; tell the user which it is —
// "retry in a few seconds" is a dead end when what they need is to log in.
const modelsErrorHint = computed(() => {
	const message = aiModels.error?.messages?.[0] || aiModels.error?.message || ""
	if (/login|permitted|permission/i.test(message)) {
		return "you appear to be logged out. Log in to the site, then retry."
	}
	return "the server may have been restarting. Retry in a few seconds."
})

const modelOptions = computed(() =>
	(aiModels.data ?? []).map((m: any) => ({
		label: m.label,
		value: m.id,
		vision: !!m.vision_capable,
		ready: !!m.ready,
	})),
)

const modelComboOptions = computed(() => [
	...modelOptions.value.map((m: any) => ({
		label: m.label,
		value: m.value,
		disabled: !m.ready,
	})),
	{
		type: "custom" as const,
		key: "add-model",
		label: "Add model",
		icon: "lucide-plus",
		onClick: () => providersDialog.value?.openForAddModel(),
	},
])

const modelLabel = computed(() => {
	const selected = modelOptions.value.find((m: any) => m.value === selectedModel.value)
	return selected ? selected.label : "Model"
})

const isVisionModel = computed(() => {
	const selected = modelOptions.value.find((m: any) => m.value === selectedModel.value)
	return selected ? selected.vision : true
})

const sessionResource = createResource({
	url: "studio.ai.api.get_ai_session",
	onSuccess(data: any) {
		messages.value = data.messages ?? []
		// Events are keyed by session, so the chat keeps receiving a running turn
		// wherever the user navigates within the app.
		controller.ensureAttached(data.session_id ?? "")
		// A turn is mid-flight targeting the page on the canvas (e.g. the editor reloaded
		// during a build): the server owns that draft, so suspend autosave right away —
		// tool batches and stream chunks re-assert this, but the first one may be seconds away.
		canvasStore.isAIStreaming = !!data.is_running && data.page === pageId.value
		if (data.is_running) resumeRunningTurn(data)
		if (data.selected_model) {
			selectedModel.value = data.selected_model
		} else if (modelOptions.value.length) {
			selectedModel.value = modelOptions.value[0].value
		}
		scrollToBottom()
		reloadSessions()
	},
})

// The loaded session has a turn mid-flight (the editor reloaded, or the panel came
// back to this app): re-enter the live turn and surface where it's building.
async function resumeRunningTurn(data: any) {
	const build = await controller.resumeRunningTurn()
	const target = build?.page_id || data.page
	if (!target || target === pageId.value) return
	const title =
		build?.page_title ||
		Object.values(store.appPages).find((p: any) => p.name === target)?.page_title ||
		target
	// A live generation stream on the target means it's being built out; without one we
	// only know the turn is focused there — show the softer "Updating".
	buildingPage.value = { name: target, title, action: build?.page_id ? "created" : "focused" }
}

// The app's chats for the session switcher in the panel header.
const sessions = ref<any[]>([])

async function reloadSessions() {
	if (!appId.value) return
	sessions.value = (await call("studio.ai.api.list_app_ai_sessions", { app_id: appId.value })) ?? []
}

// Titles are first prompts, so cap them — the dropdown sizes to its longest
// label and would sprawl across the canvas.
const truncateTitle = (title: string, max = 44) =>
	title.length > max ? title.slice(0, max - 1).trimEnd() + "…" : title

const sessionOptions = computed(() => {
	if (!sessions.value.length) return []
	// Delete sits in its own group so it reads as an action on the current chat
	// rather than another chat to switch to — frappe-ui draws the divider.
	return [
		{
			group: "Chats",
			hideLabel: true,
			options: sessions.value.map((s: any) => ({
				label: truncateTitle(s.title || "New chat"),
				icon: s.name === controller.sessionId ? "lucide-check" : "lucide-message-circle",
				onClick: () => switchSession(s.name),
			})),
		},
		{
			group: "Manage",
			hideLabel: true,
			options: [
				{
					label: "Delete current chat",
					icon: "lucide-trash-2",
					theme: "red",
					onClick: deleteSession,
				},
			],
		},
	]
})

async function newSession() {
	if (loading.value) return
	const res: any = await call("studio.ai.api.new_ai_session", {
		app_id: appId.value,
		model: selectedModel.value || undefined,
	})
	controller.ensureAttached(res.session_id ?? "")
	messages.value = res.messages ?? []
	reloadSessions()
}

function switchSession(sessionId: string) {
	if (loading.value || sessionId === controller.sessionId) return
	buildingPage.value = null
	sessionResource.submit({ app_id: appId.value, session_id: sessionId })
}

async function deleteSession() {
	if (loading.value || !controller.sessionId) return
	await call("studio.ai.api.delete_ai_session", { session_id: controller.sessionId })
	controller.detach()
	controller.sessionId = ""
	// Falls to the app's most recent remaining chat, or a fresh one.
	sessionResource.submit({ app_id: appId.value })
}

function scrollToBottom() {
	nextTick(() => {
		if (messagesEl.value) {
			messagesEl.value.scrollTo({
				top: messagesEl.value.scrollHeight,
				behavior: "smooth",
			})
		}
	})
}

function reloadSession() {
	if (appId.value) {
		// Stay on the current chat — a turn just finished or errored; re-pull its messages.
		sessionResource.submit({ app_id: appId.value, session_id: controller.sessionId || undefined })
	}
}

function renderMarkdown(content: string): string {
	if (!content) return ""
	return DOMPurify.sanitize(marked.parse(content, { gfm: true, breaks: true }) as string)
}

const controller = new AIChatController({
	socket,
	messages,
	loading,
	statusMessage,
	error,
	pageId: () => pageId.value,
	getCanvas: () => canvasStore.activeCanvas,
	getSelectedBlockIds: () => (selectedBlock.value ? [selectedBlock.value.componentId] : []),
	setRootBlock: (block: BlockOptions) => {
		const rootBlock = getBlockInstance(block)
		store.pageBlocks = [rootBlock]
		canvasStore.activeCanvas?.setRootBlock(rootBlock, false)
	},
	savePage: () => store.savePage(),
	adoptServerWrite: (modified?: string) => store.adoptServerSave(modified),
	setAIOwnsCanvas: (owned: boolean) => (canvasStore.isAIStreaming = owned),
	onPageEvent: (data) => {
		// A page the agent just created is invisible to the pages panel until refetched.
		store.setAppPages(appId.value)
		if (data.page_name === pageId.value) {
			// The agent retitled/re-routed the page on the canvas (set_page_meta saved the
			// doc): adopt the new meta + stamp so the header updates and the user's next
			// save doesn't conflict.
			if (data.action === "updated" && store.activePage) {
				store.activePage.page_title = data.page_title
				store.activePage.route = data.route
				store.syncPageModified({ modified: data.modified })
			}
			buildingPage.value = null
			return
		}
		buildingPage.value = {
			name: data.page_name,
			title: data.page_title || data.page_name,
			action: data.action,
		}
	},
	reloadSession,
	scrollToBottom,
	reloadPageData: ({ resources, variables, script, modified }) => {
		const page = store.activePage
		if (!page) return
		if (resources) codeStore.setPageResources(page)
		if (variables) codeStore.setPageVariables(page)
		if (script) store.reloadActivePageScript()
		store.syncPageModified({ modified })
	},
})

watch(isVisionModel, (vision) => {
	if (!vision) controller.clearImage()
})

// Attached-image state + input (exposed so the template auto-unwraps the refs).
const imagePreviewUrl = controller.imagePreviewUrl
const imageFileName = controller.imageFileName
const imageInput = ref<HTMLInputElement | null>(null)

function onImageSelected(e: Event) {
	const input = e.target as HTMLInputElement
	const file = input.files?.[0]
	if (file) controller.attachImageFile(file)
	input.value = "" // let the same file be re-picked
}

function onPaste(e: ClipboardEvent) {
	const file = Array.from(e.clipboardData?.items || [])
		.find((item) => item.type.startsWith("image/"))
		?.getAsFile()
	if (!file) return
	e.preventDefault()
	if (!warnIfNoVision()) return
	controller.attachImageFile(file)
}

function onDropImage(e: DragEvent) {
	const file = e.dataTransfer?.files?.[0]
	if (!file?.type.startsWith("image/")) return
	e.preventDefault()
	if (!warnIfNoVision()) return
	controller.attachImageFile(file)
}

function warnIfNoVision(): boolean {
	if (isVisionModel.value) return true
	toast.error(`${modelLabel.value} can't read images. Pick a vision-capable model to attach a design.`)
	return false
}

// Sessions are app-scoped: switching pages within the app keeps the chat (and any
// running turn) — only an app change loads a different conversation.
watch(
	() => appId.value,
	(newApp) => {
		canvasStore.isAIStreaming = false
		buildingPage.value = null
		controller.detach()
		controller.sessionId = ""
		messages.value = []
		if (newApp) sessionResource.submit({ app_id: newApp })
	},
	{ immediate: true },
)

watch(
	() => pageId.value,
	() => {
		// A turn targeting another page keeps building server-side; this page's autosave
		// must not stay suspended by it. Events targeting THIS page re-assert the flag.
		canvasStore.isAIStreaming = false
	},
)

async function generate() {
	const text = prompt.value.trim()
	const hasImage = !!controller.imageData.value
	if (!text && !hasImage) return
	prompt.value = ""
	buildingPage.value = null
	// An attached design with no words is still a valid instruction: reproduce it.
	await controller.submit(text || "Reproduce this attached design as a page.", selectedModel.value)
	// A chat is titled by its first prompt — this turn may have just named it.
	reloadSessions()
}

function stop() {
	controller.cancel()
}

// A clarification option or plan approval is just the user's next message.
function sendPrompt(text: string) {
	if (loading.value) return
	buildingPage.value = null
	controller.submit(text, selectedModel.value)
}

// Header actions for this panel render in StudioLeftPanel's title row, which
// reaches them through a template ref on the (always-mounted) panel.
defineExpose({
	sessionOptions,
	newSession,
	openProviders: () => (showProviders.value = true),
})
</script>

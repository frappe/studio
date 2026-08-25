import { call } from "frappe-ui"
import { ref, type Ref } from "vue"
import { type AIChatHandlers, attachAIChatListeners, detachAIChatListeners } from "@/components/ai/realtime"
import { ToolDispatcher } from "@/components/ai/toolDispatch"
import type { BlockOptions } from "@/types"
import { tryParseJsonBlock } from "@/utils/blockCodec"
import { throttle } from "@/utils/helpers"

/** Everything the controller needs from the panel: the shared chat state it mutates
 * and the canvas/page helpers it drives. Keeps the controller free of Vue component
 * internals so the agent turn lifecycle lives in one testable place. */
export interface AIChatContext {
	socket: any
	messages: Ref<any[]>
	loading: Ref<boolean>
	statusMessage: Ref<string>
	error: Ref<string>
	pageId: () => string
	getCanvas: () => any
	getSelectedBlockIds: () => string[]
	setRootBlock: (block: BlockOptions) => void
	/** Flush unsaved canvas changes so the server-side turn starts from what the user sees. */
	savePage: () => Promise<any> | void
	/** The server persisted the draft: adopt its modified stamp + local draft marker. */
	adoptServerWrite: (modified?: string) => void
	/** While a turn runs, the server owns this page's draft — the editor's autosave stands down. */
	setAIOwnsCanvas: (owned: boolean) => void
	/** The turn created, focused, or retitled a page: refresh the pages list, adopt new
	 * meta for the open page, and surface a chip linking to a background build. */
	onPageEvent: (data: {
		action: string
		page_name: string
		page_title: string
		route: string
		modified?: string
	}) => void
	reloadSession: () => void
	scrollToBottom: () => void
	reloadPageData: (opts: {
		resources?: boolean
		variables?: boolean
		script?: boolean
		modified?: string
	}) => void
}

/**
 * Orchestrates one Studio AI agent turn: sends the user prompt to
 * `studio.ai.api.run` and reacts to the `ai_chat_*` realtime events. Block-tree
 * mutation lives in ToolDispatcher; full-page generation streams as `page_json`.
 */
export class AIChatController {
	sessionId = ""
	private attachedSessionId = ""
	// Optional screenshot/design attached to the next prompt (base64 data URL) — reproduced as a layout.
	imageData = ref<string | null>(null)
	imagePreviewUrl = ref<string | null>(null)
	imageFileName = ref("")
	private readonly dispatcher: ToolDispatcher
	private pendingAssistantId: number | null = null
	private summary = ""
	private pageBuffer = ""
	// Bumped when a generation starts fresh (stream offset 0) — lets an in-flight
	// buffer fetch detect it resolved across a generation boundary and stand down.
	private generationSeq = 0
	private readonly renderStreamedPage: () => void

	constructor(private readonly ctx: AIChatContext) {
		this.dispatcher = new ToolDispatcher({ getCanvas: ctx.getCanvas, setRootBlock: ctx.setRootBlock })
		// Re-parsing + rebuilding the whole tree per token pegs the CPU; the final
		// generate_page op re-applies the authoritative document, so a coarse cadence is fine.
		this.renderStreamedPage = throttle(() => {
			const block = tryParseJsonBlock(this.pageBuffer)
			if (block) this.ctx.setRootBlock(block)
		}, 200)
	}

	get handlers(): AIChatHandlers {
		return {
			onProgress: this.onProgress,
			onStream: this.onStream,
			onToolBatch: this.onToolBatch,
			onPage: this.onPage,
			onClarify: this.onClarify,
			onComplete: this.onComplete,
			onError: this.onError,
			onReload: this.onReload,
		}
	}

	/** Listen on this session's event channel, detaching any previous one. Events are
	 * keyed by session — the chat keeps receiving a running turn across page switches. */
	ensureAttached(sessionId: string) {
		if (!sessionId || sessionId === this.attachedSessionId) return
		this.detach()
		attachAIChatListeners(this.ctx.socket, sessionId, this.handlers)
		this.attachedSessionId = sessionId
		this.sessionId = sessionId
	}

	detach() {
		if (!this.attachedSessionId) return
		detachAIChatListeners(this.ctx.socket, this.attachedSessionId, this.handlers)
		this.attachedSessionId = ""
	}

	/** Canvas events carry the page the turn is editing; the editor mirrors them only
	 * when that page is the one it shows. Everything else is a background build. */
	private targetsOpenPage(data: any): boolean {
		return !data.target_page_id || data.target_page_id === this.ctx.pageId()
	}

	async submit(promptText: string, model: string) {
		this.summary = ""
		this.pageBuffer = ""
		this.ctx.error.value = ""
		this.ctx.loading.value = true
		this.ctx.statusMessage.value = ""
		const image = this.imageData.value
		this.pushMessage("user", promptText, image ? { attachedImageUrl: image } : undefined)
		this.clearImage()
		this.pendingAssistantId = this.pushMessage("assistant", "Thinking…")
		this.ctx.scrollToBottom()
		try {
			// The server edits the page authoritatively from its saved draft — flush any
			// unsaved canvas changes first so the turn starts from exactly what the user sees.
			await this.ctx.savePage()
			this.ctx.setAIOwnsCanvas(true)
			const res: any = await call("studio.ai.api.run", {
				prompt: promptText,
				page_id: this.ctx.pageId(),
				model,
				session_id: this.sessionId || undefined,
				selected_block_ids: this.ctx.getSelectedBlockIds(),
				image_data: image ?? undefined,
			})
			if (res?.session_id) this.ensureAttached(res.session_id)
			if (res?.status === "busy") {
				this.onError({ message: res.message || "Another AI request is still processing." })
			}
		} catch (e: any) {
			this.onError({ message: e?.message || "Failed to start. Please try again." })
		}
	}

	/** A (re)loaded panel found this session's turn still running: re-enter the live
	 * turn — pending bubble + spinner — and replay any in-flight generation stream.
	 * Returns the build's target page (for the panel's "Building…" chip) or null. */
	async resumeRunningTurn(): Promise<{ page_id: string; page_title: string } | null> {
		this.beginResumedTurn("Reconnecting to the running build…")
		return await this.fetchStreamBuffer()
	}

	/** A turn continues server-side without a submit from this panel (a reload found it
	 * running, or resolving an approval card re-enqueued the agent): spinner + a fresh
	 * pending bubble so the streamed reply has somewhere to land. */
	beginResumedTurn(status: string) {
		this.ctx.loading.value = true
		this.ctx.statusMessage.value = status
		if (this.pendingAssistantId == null) {
			this.pendingAssistantId = this.pushMessage("assistant", "Working…")
		}
	}

	cancel = async () => {
		if (!this.sessionId) return
		this.ctx.statusMessage.value = "Cancelling…"
		try {
			await call("studio.ai.api.cancel", { session_id: this.sessionId })
		} catch {
			// Ignore — the user will see the cancelled event when it arrives.
		}
	}

	// --- realtime handlers ------------------------------------------------

	onProgress = (data: any) => {
		this.ctx.loading.value = true
		this.ctx.statusMessage.value = data.message || this.ctx.statusMessage.value
	}

	onStream = (data: any) => {
		if (!data.chunk) return
		if (data.kind === "page_json") {
			// Buffer EVERY chunk, whatever page is open: the user may click "Open" on a
			// background build mid-stream, and the preview only renders from a complete
			// buffer. offset 0 starts a fresh generation (a multi-page turn streams
			// several); a chunk AHEAD of the buffer means we missed some (e.g. a reload
			// mid-stream) — refill from the server's Redis snapshot and let later chunks
			// append; a chunk BEHIND it is one the snapshot already covered.
			if (typeof data.offset === "number") {
				if (data.offset === 0) {
					this.generationSeq++
					this.pageBuffer = ""
				} else if (data.offset > this.pageBuffer.length) {
					this.recoverFromGap()
					return
				} else if (data.offset < this.pageBuffer.length) return
			}
			this.pageBuffer += data.chunk
			// Render (and suspend autosave — the preview must never be saved) only on the
			// page being built.
			if (!this.targetsOpenPage(data)) return
			this.ctx.setAIOwnsCanvas(true)
			this.renderStreamedPage()
			return
		}
		this.summary += data.chunk
		this.updatePending(this.summary)
		this.ctx.scrollToBottom()
	}

	onToolBatch = (data: any) => {
		if (!data.operations?.length) return
		// The server already applied + persisted these ops. Mirror them only when the
		// canvas shows the page they landed on; a background page picks them up from the
		// DB on navigation.
		if (!this.targetsOpenPage(data)) return
		// Re-assert ownership (covers returning to a page whose build is still in flight)
		// so the editor's autosave doesn't react to the mirrored mutations.
		this.ctx.setAIOwnsCanvas(true)
		this.dispatcher.applyToolBatch(data.operations)
		this.ctx.adoptServerWrite(data.modified)
		this.ctx.scrollToBottom()
	}

	onComplete = (data: any) => {
		this.ctx.setAIOwnsCanvas(false)
		this.ctx.loading.value = false
		this.ctx.statusMessage.value = ""
		this.updatePending(this.summary || data.message || "Done")
		this.pendingAssistantId = null
		this.summary = ""
		this.pageBuffer = ""
		this.ctx.reloadSession()
	}

	onError = (data: any) => {
		this.ctx.setAIOwnsCanvas(false)
		this.ctx.loading.value = false
		this.ctx.statusMessage.value = ""
		this.ctx.error.value = data.message || "Request failed."
		this.pendingAssistantId = null
		this.summary = ""
		this.pageBuffer = ""
		this.ctx.reloadSession()
	}

	onPage = (data: any) => {
		if (data?.page_name) this.ctx.onPageEvent(data)
	}

	onReload = (data: any) => {
		// A server tool wrote page data (data sources / variables / script). Re-fetch so the
		// canvas re-evaluates `{{ }}` bindings and re-runs setup() against the live state.
		// Only meaningful when the written page is the one on the canvas.
		if (!this.targetsOpenPage(data)) return
		this.ctx.reloadPageData({
			resources: !!data.resources,
			variables: !!data.variables,
			script: !!data.script,
			modified: data.modified,
		})
	}

	onClarify = (data: any) => {
		this.ctx.setAIOwnsCanvas(false)
		this.ctx.loading.value = false
		this.ctx.statusMessage.value = ""
		if (data.pending_action) {
			// A sensitive action awaits approval: render the card right away; the session
			// reload below swaps in the persisted message (same metadata shape, and the
			// persisted status is what gates the buttons).
			this.updatePending(data.question || "Approve this change?", {
				status: "pending_action",
				...data.pending_action,
			})
		} else if (data.plan_summary) {
			this.updatePending(data.headline || "Here's my plan", {
				status: "plan_summary",
				headline: data.headline || "",
				data_plan: data.data_plan || [],
				layout_plan: data.layout_plan || [],
				palette: data.palette || "",
			})
		} else {
			this.updatePending(data.question || "Could you clarify?", {
				status: "clarification",
				options: data.options || [],
			})
		}
		this.pendingAssistantId = null
		this.summary = ""
		// Backend persists+commits clarify messages before emitting, so this is race-free.
		this.ctx.reloadSession()
	}

	// --- helpers ----------------------------------------------------------

	/** Pull the server's snapshot of the in-flight generation (Redis, ~512-char cadence)
	 * and catch the local buffer up to it. Renders only when the build targets the open page. */
	private async fetchStreamBuffer(): Promise<{ page_id: string; page_title: string } | null> {
		const session = this.sessionId
		if (!session) return null
		const generation = this.generationSeq
		let build: any = null
		try {
			build = await call("studio.ai.api.get_active_build", { session_id: session })
		} catch {
			return null
		}
		if (!build?.content || this.sessionId !== session) return null
		// A new generation started (offset 0) while we fetched — this snapshot is the
		// previous one's tail; keep the chip info but don't pollute the fresh buffer.
		if (this.generationSeq !== generation) {
			return { page_id: build.page_id ?? "", page_title: build.page_title ?? "" }
		}
		if (build.content.length > this.pageBuffer.length) {
			this.pageBuffer = build.content
			if (!build.page_id || build.page_id === this.ctx.pageId()) {
				this.ctx.setAIOwnsCanvas(true)
				this.renderStreamedPage()
			}
		}
		return { page_id: build.page_id ?? "", page_title: build.page_title ?? "" }
	}

	/** A live chunk ran ahead of the local buffer: refill from the server snapshot.
	 * The snapshot trails the stream by up to ~512 chars, so this fires a few times
	 * until offsets line up — the flag keeps it to one fetch in flight. */
	private recoveringGap = false
	private recoverFromGap() {
		if (this.recoveringGap) return
		this.recoveringGap = true
		this.fetchStreamBuffer().finally(() => (this.recoveringGap = false))
	}

	private pushMessage(
		role: "user" | "assistant",
		content: string,
		metadata?: Record<string, any>,
	): number {
		const id = Date.now() + this.ctx.messages.value.length
		this.ctx.messages.value = [...this.ctx.messages.value, { id, role, content, ...(metadata ? { metadata } : {}) }]
		return id
	}

	attachImageFile = (file: File) => {
		if (!file.type.startsWith("image/")) return
		if (file.size > 5 * 1024 * 1024) {
			this.ctx.error.value = "Image is too large. Please use an image smaller than 5 MB."
			return
		}
		this.imageFileName.value = file.name || "pasted-image.png"
		const reader = new FileReader()
		reader.onload = (e) => {
			this.imageData.value = e.target?.result as string
			this.imagePreviewUrl.value = this.imageData.value
		}
		reader.readAsDataURL(file)
	}

	clearImage = () => {
		this.imageData.value = null
		this.imagePreviewUrl.value = null
		this.imageFileName.value = ""
	}

	private updatePending(content: string, metadata?: Record<string, any>) {
		if (this.pendingAssistantId == null) return
		const index = this.ctx.messages.value.findIndex((m) => m.id === this.pendingAssistantId)
		if (index === -1) return
		const next = [...this.ctx.messages.value]
		next[index] = {
			...next[index],
			content,
			...(metadata ? { metadata: { ...next[index].metadata, ...metadata } } : {}),
		}
		this.ctx.messages.value = next
	}
}

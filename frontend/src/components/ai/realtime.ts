/** The unified `ai_chat_*` realtime event family. Each event name is suffixed
 * with the SESSION id by the backend (see studio/ai/agent/loop.py) — the chat
 * follows the conversation across page switches; payloads carry target_page_id. */

type Handler = (data: any) => void

export interface AIChatHandlers {
	onProgress: Handler
	onStream: Handler
	onToolBatch: Handler
	onPage: Handler
	onClarify: Handler
	onComplete: Handler
	onError: Handler
	onReload: Handler
}

interface Realtime {
	on: (event: string, handler: Handler) => void
	off: (event: string, handler: Handler) => void
}

function listenerMap(h: AIChatHandlers): Record<string, Handler> {
	return {
		ai_chat_progress: h.onProgress,
		ai_chat_stream: h.onStream,
		ai_chat_tool_batch: h.onToolBatch,
		ai_chat_page: h.onPage,
		ai_chat_clarify: h.onClarify,
		ai_chat_complete: h.onComplete,
		ai_chat_error: h.onError,
		ai_chat_reload: h.onReload,
	}
}

const eventName = (base: string, sessionId: string) => (sessionId ? `${base}_${sessionId}` : base)

export function attachAIChatListeners(realtime: Realtime, sessionId: string, handlers: AIChatHandlers) {
	const map = listenerMap(handlers)
	Object.entries(map).forEach(([base, handler]) => realtime.on(eventName(base, sessionId), handler))
}

export function detachAIChatListeners(realtime: Realtime, sessionId: string, handlers: AIChatHandlers) {
	const map = listenerMap(handlers)
	Object.entries(map).forEach(([base, handler]) => realtime.off(eventName(base, sessionId), handler))
}

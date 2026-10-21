import { effectScope } from "vue"

export class PageScriptScope {
	private scope = effectScope(true)

	constructor(private onError: (error: unknown) => void) {}

	get active() {
		return this.scope.active
	}

	run(setup: () => Record<string, any> | void): Record<string, any> {
		try {
			const bindings = this.scope.run(setup)
			if (bindings && typeof bindings.then === "function") {
				Promise.resolve(bindings).catch(() => {})
				throw new Error(
					"Return page state synchronously. Fetch resources from a watcher or an event handler.",
				)
			}
			return bindings || {}
		} catch (error) {
			this.stop()
			this.onError(error)
			return {}
		}
	}

	stop() {
		this.scope.stop()
	}
}

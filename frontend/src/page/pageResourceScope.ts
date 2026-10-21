import { computed, shallowRef, markRaw, nextTick, type WatchStopHandle } from "vue"
import { createDocumentResource } from "frappe-ui"
import type {
	APIResourceInstance,
	ListResourceInstance,
	DocumentResourceInstance,
} from "@/types/Studio/StudioResource"

/** Bind inputs at request time, including calls made by user watchers before Vue flushes. */
export function bindResourceInputs<T extends APIResourceInstance | ListResourceInstance>(
	resource: T,
	resourceScope: PageResourceScope,
	field: "params" | "filters",
	evaluate: () => any,
	readOnly: boolean,
): T {
	const inputs = computed(evaluate)
	const override = shallowRef<any>()
	const currentInputs = () => (override.value === undefined ? inputs.value : override.value)
	const readKey = {}
	const list = field === "filters" ? resource as ListResourceInstance : null
	const fetch = list ? list.list.fetch : resource.fetch
	const request = (args: any[], read: boolean) =>
		resourceScope.run(
			() => {
				if (list) {
					resource.update({ filters: currentInputs() })
					return fetch(...args)
				}
				return fetch(args[0] ?? currentInputs(), ...args.slice(1))
			},
			read && !args.length ? readKey : undefined,
		)

	const reload = (...args: any[]) => request(args, readOnly)
	if (list) {
		// Pagination and list.reload() also reach this entry point.
		list.list.fetch = reload
		list.list.reload = reload
		list.list.submit = (...args: any[]) => request(args, false)
		resource.fetch = (...args: any[]) => resource.reload(...args)
		for (const name of ["fetchOne", "insert", "setValue", "delete", "runDocMethod"] as const) {
			const operation = list[name]
			for (const method of ["fetch", "reload", "submit"] as const) {
				const invoke = operation[method]
				operation[method] = (...args: any[]) => resourceScope.run(() => invoke(...args))
			}
		}
	} else {
		const api = resource as APIResourceInstance
		api.fetch = reload
		api.reload = reload
		api.submit = (...args: any[]) => request(args, false)
	}

	return new Proxy(markRaw({}) as T, {
		get(target, key) {
			if (typeof key === "string" && key.startsWith("__v_")) return Reflect.get(target, key)
			if (key === field) return currentInputs()
			if (key === "update")
				return (options: Record<string, any>) => {
					if (field in options) override.value = options[field]
					resource.update(options)
				}
			return Reflect.get(resource, key)
		},
		has: (_target, key) => key === field || key in resource,
		ownKeys: () => Reflect.ownKeys(resource),
		getOwnPropertyDescriptor: (_target, key) => Object.getOwnPropertyDescriptor(resource, key),
		set(_target, key, value) {
			if (key === field) override.value = value
			else Reflect.set(resource, key, value)
			return true
		},
	})
}

/** A document's methods exist before its filters have resolved to a name. */
export class PageDocumentResource {
	private current = shallowRef<DocumentResourceInstance | null>(null)
	private lookup: Promise<DocumentResourceInstance | null> | null = null
	private lookupKey = ""
	private readKey = {}
	readonly resource: DocumentResourceInstance

	constructor(
		private resourceScope: PageResourceScope,
		private options: { doctype: string; whitelistedMethods?: Record<string, string> },
		private getFilters: () => any,
		private resolveName: (filters: any) => Promise<any>,
	) {
		const methods: Record<string, any> = {}
		for (const name of [
			"get",
			"setValue",
			"setValueDebounced",
			"save",
			"delete",
			...Object.keys(options.whitelistedMethods || {}),
		]) {
			methods[name] = this.operation(name)
		}
		const initial: Record<string | symbol, any> = {
			doc: null,
			name: null,
			doctype: options.doctype,
			auto: false,
			...methods,
			reload: (...args: any[]) => methods.get.fetch(...args),
		}
		this.resource = new Proxy(markRaw(initial) as DocumentResourceInstance, {
			get: (target, key) =>
				(typeof key === "string" && key.startsWith("__v_")) ||
				key in methods ||
				["reload", "auto"].includes(String(key))
					? Reflect.get(target, key)
					: ((this.current.value && Reflect.get(this.current.value, key)) ?? Reflect.get(target, key)),
			set: (target, key, value) => {
				if (key === "auto") target[key] = value
				else if (this.current.value) Reflect.set(this.current.value, key, value)
				else Reflect.set(target, key, value)
				return true
			},
		})
	}

	initialize() {
		return this.resourceScope.run(() => this.resolve())
	}

	private operation(name: string) {
		const initial: Record<string | symbol, any> = { data: null, loading: false, error: null, promise: null }
		const invoke = (method: string, args: any[]) => {
			const promise = this.resourceScope.run(
				async () => {
					const document = await this.resolve()
					if (!document || !this.resourceScope.active) return
					return Reflect.get(document, name)[method](...args)
				},
				name === "get" && method !== "submit" && !args.length ? this.readKey : undefined,
			)
			initial.promise = promise
			return promise
		}
		return new Proxy(markRaw(initial), {
			get: (target, key) => {
				if (typeof key === "string" && key.startsWith("__v_")) return Reflect.get(target, key)
				if (["fetch", "reload", "submit"].includes(String(key)))
					return (...args: any[]) => invoke(String(key), args)
				return (this.current.value && Reflect.get(this.current.value, name)?.[key]) ?? Reflect.get(target, key)
			},
		})
	}

	private resolve() {
		const filters = this.getFilters()
		const key = JSON.stringify(filters)
		if (this.lookup && key === this.lookupKey) return this.lookup
		this.lookupKey = key
		this.current.value = null
		const lookup = this.resolveName(filters)
			.then((name) => {
				if (!this.resourceScope.active || this.lookup !== lookup) return null
				if (!name) {
					this.lookup = null
					return null
				}
				const document = createDocumentResource({ ...this.options, name, auto: false })
				this.current.value = document
				return document
			})
			.catch((error) => {
				if (this.lookup === lookup) this.lookup = null
				throw error
			})
		this.lookup = lookup
		return lookup
	}
}

type Request = { run: () => unknown; resolve: (value: any) => void; reject: (error: unknown) => void }

/** Own resource watchers and queued requests for one page load or resource refresh. */
export class PageResourceScope {
	private starts: (() => WatchStopHandle)[] = []
	private watchers: WatchStopHandle[] = []
	private started = false
	private pauses = 1
	private stopped = false
	private scheduled = false
	private pending = new Map<object, { request: Request; promise: Promise<any> }>()

	get active() {
		return !this.stopped
	}

	onStart(start: () => WatchStopHandle) {
		if (!this.stopped) this.starts.push(start)
	}

	activate() {
		if (this.stopped || this.started) return
		this.started = true
		for (const start of this.starts) this.watchers.push(start())
		this.starts = []
		this.resume()
	}

	pause() {
		this.pauses++
	}

	resume() {
		this.pauses--
		this.schedule()
	}

	run(run: () => unknown, readKey: object = {}) {
		if (this.stopped) return Promise.resolve(undefined)
		const existing = this.pending.get(readKey)
		if (existing) return existing.promise
		let request!: Request
		const promise = new Promise((resolve, reject) => {
			request = { run, resolve, reject }
		})
		this.pending.set(readKey, { request, promise })
		// Auto-fetches and immediate watchers may intentionally ignore the returned promise.
		void promise.catch(() => {})
		this.schedule()
		return promise
	}

	stop() {
		this.stopped = true
		this.starts = []
		for (const stop of this.watchers) stop()
		this.watchers = []
		for (const { request } of this.pending.values()) request.resolve(undefined)
		this.pending.clear()
	}

	private schedule() {
		if (this.pauses || this.stopped || this.scheduled) return
		this.scheduled = true
		void nextTick().then(() => {
			this.scheduled = false
			if (this.pauses || this.stopped) return
			const requests = [...this.pending.values()]
			this.pending.clear()
			for (const { request } of requests) {
				if (this.stopped) {
					request.resolve(undefined)
					continue
				}
				try {
					Promise.resolve(request.run()).then(request.resolve, request.reject)
				} catch (error) {
					request.reject(error)
				}
			}
		})
	}
}

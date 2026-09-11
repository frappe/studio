import { defineStore } from "pinia"
import {
	ref, computed, watch, watchEffect, reactive, toRef, toRefs, unref,
	isRef, isReactive, shallowRef, readonly, markRaw, nextTick,
	type ComputedRef, type WatchStopHandle, h,
} from "vue"
import { watchDebounced } from "@vueuse/core"
import { createDocumentResource, createListResource, createResource, call } from "frappe-ui"
import { PageScriptScope } from "@/utils/pageScriptScope"
import { studioPageResources } from "@/data/studioResources"
import { loadPageScriptModule, setPageScriptHotUpdateHandler } from "@/data/studioPageScripts"
import * as globalUtils from "@/utils/globalUtils"
import { getValueFromObject, setValueInObject } from "@/utils/helpers"
import { isDynamicValue, normalizeDynamicValue } from "@/utils/code"
import { isFunctionExpression, toOptionalChaining, getTopLevelBindings } from "@/utils/parseCode"
import type {
	Filters,
	Resource,
	DocumentResource,
	DocumentListResource,
	APIResource,
	DataResult,
} from "@/types/Studio/StudioResource"
import type { StudioPage } from "@/types/Studio/StudioPage"
import type { ExpressionEvaluationContext } from "@/types"
import type { Router } from "vue-router"

export const vueReactivityApis = {
	ref, reactive, computed, watch, watchEffect, watchDebounced,
	toRef, toRefs, unref, isRef, isReactive,
	shallowRef, readonly, markRaw, nextTick,
}

type ResourceOptions = { editor?: boolean; rows?: Resource[] }

const useCodeStore = defineStore("codeStore", () => {
	const resources = ref<Record<string, Resource>>({})
	const routeObject = ref<ComputedRef>()
	const routerObject = ref<Router | Readonly<Router>>()

	// shallowRef (not ref): a deep ref would wrap this in reactive() and auto-unwrap the nested refs
	const pageScriptBindings = shallowRef<Record<string, any>>({})
	const pageScriptTemplateBindings = computed(() => {
		const unwrapped: Record<string, any> = {}
		for (const key in pageScriptBindings.value) {
			unwrapped[key] = unref(pageScriptBindings.value[key])
		}
		return unwrapped
	})
	const pageScriptError = ref<string | null>(null)
	const currentPageName = ref<string | null>(null)
	let pageScriptScope: PageScriptScope | null = null
	let resourceRequests: ResourceRequests | null = null
	let startResources: (() => void)[] = []
	let resourceWatchers: WatchStopHandle[] = []

	function setRouteObject(route: ComputedRef) {
		routeObject.value = route
	}

	function setRouterObject(router: Router | Readonly<Router>) {
		routerObject.value = router
	}

	// RESOURCES
	let pendingResources: Record<string, any> | null = null
	async function initializePage(page: StudioPage, options: ResourceOptions = {}) {
		teardownPage()
		await loadPageResources(page, options, () => setPageScript(page))
	}

	async function setPageResources(page: StudioPage, options: ResourceOptions = {}) {
		await loadPageResources(page, options)
	}

	async function loadPageResources(
		page: StudioPage,
		options: ResourceOptions,
		setup?: () => Promise<void>,
	) {
		stopResourceWatchers()
		resourceRequests?.stop()
		const requests = new ResourceRequests()
		resourceRequests = requests
		startResources = []
		const pageResources = reactive({}) as Record<string, any>
		pendingResources = pageResources
		const resourceRows = await getPageResourceRows(page, options.rows)
		if (pendingResources !== pageResources) return

		for (const row of resourceRows) {
			const resource = createPageResource(row, requests)
			if (options.editor) {
				resource.resource_id = row.resource_id
				resource.resource_type = row.resource_type
			}
			pageResources[row.resource_name] = resource
		}
		resources.value = pageResources
		if (setup) await setup()
		if (pendingResources !== pageResources) return
		for (const start of startResources) start()
		startResources = []
		requests.resume()
	}

	async function getPageResourceRows(page: StudioPage, preloadedResources?: Resource[]) {
		if (preloadedResources) return preloadedResources

		studioPageResources.filters = { parent: page.name }
		return (await studioPageResources.reload()) as Resource[]
	}

	function createPageResource(resource: Resource, requests: ResourceRequests) {
		switch (resource.resource_type) {
			case "Document":
				return getDocumentResource(resource, requests)
			case "Document List":
				return getListResource(resource, requests)
			case "API Resource":
				return getAPIResource(resource, requests)
		}
	}

	function getListResource(resource: DocumentListResource, requests: ResourceRequests) {
		const fields = typeof resource.fields === "string" ? JSON.parse(resource.fields) : resource.fields
		const list = createListResource({
			doctype: resource.document_type,
			fields: fields?.length ? fields : "*",
			pageLength: resource.limit,
			orderBy: resource.sort_field ? `${resource.sort_field} ${resource.sort_order}` : undefined,
			auto: false,
			...getTransforms(resource),
			...getSuccessErrorHandlers(resource),
		})
		list.data = []
		const evaluate = () => getEvaluatedFilters(resource.filters)
		const bound = bindResourceInputs(list, requests, "filters", evaluate, true)
		bound.auto = resource.auto
		watchResourceInputs(bound, evaluate)
		return bound
	}

	function getAPIResource(resource: APIResource, requests: ResourceRequests) {
		const api = createResource({
			url: resource.url,
			method: resource.method,
			auto: false,
			...getTransforms(resource),
			...getSuccessErrorHandlers(resource),
		})
		const evaluate = () => getAPIParams(resource.params)
		const bound = bindResourceInputs(api, requests, "params", evaluate, resource.method === "GET")
		bound.auto = resource.auto
		watchResourceInputs(bound, evaluate)
		return bound
	}

	function getDocumentResource(resource: DocumentResource, requests: ResourceRequests) {
		const evaluate = () => resource.fetch_document_using_filters
			? getEvaluatedFilters(resource.filters) || {}
			: { name: resource.document_name }
		const document = new PageDocumentResource(requests, {
			doctype: resource.document_type,
			...getTransforms(resource),
			...getSuccessErrorHandlers(resource),
			...getWhitelistedMethods(resource),
		}, evaluate, (filters) => resolveDocnameFromFilters(resource, filters))
		document.resource.auto = resource.auto
		watchResourceInputs(document.resource, evaluate, () => { void document.initialize() })
		return document.resource
	}

	function watchResourceInputs(resource: any, evaluate: () => any, initialize?: () => void) {
		startResources.push(() => {
			const refresh = () => {
				initialize?.()
				if (resource.auto) void resource.reload()
			}
			resourceWatchers.push(watch(() => JSON.stringify(evaluate()), refresh))
			refresh()
		})
	}

	const getEvaluatedFilters = (filters: Filters | null = null) => {
		if (!filters) return
		if (typeof filters === "string") {
			filters = JSON.parse(filters)
		}

		const evaluatedFilters: Partial<Filters> = {}

		for (const key in filters) {
			const raw = filters[key]
			if (Array.isArray(raw)) {
				// A list filter is [operator, value] and Frappe unpacks exactly that pair —
				// the operator must survive to the wire (stripping it turned "!=" and
				// "not in" filters into equality/bare lists). A flat [op, v1, v2, ...] is
				// a malformed multi-value filter from older saves — recover it.
				const operator = raw[0]
				const value = raw.length > 2 ? raw.slice(1) : raw[1]
				const evaluated = evaluateFilterValue(value)
				evaluatedFilters[key] = evaluated === undefined ? undefined : [operator, evaluated]
			} else {
				evaluatedFilters[key] = evaluateFilterValue(raw)
			}
		}

		return evaluatedFilters
	}

	const evaluateFilterValue = (value: any): any => {
		if (Array.isArray(value)) {
			return value.map((item) => evaluateFilterValue(item)).filter((item) => item !== undefined)
		}
		if (isDynamicValue(value)) {
			// null ?? undefined → undefined, so nullish filters get dropped on serialization
			return getDynamicValue(value, {}) ?? undefined
		}
		return value
	}

	function getAPIParams(params: Record<string, any> | string | null = null) {
		if (!params) return null
		if (typeof params === "string") {
			params = JSON.parse(params)
		}
		// evaluate on a copy: evaluation re-runs on every context change and must not bake values into the config
		const evaluated: Record<string, any> = { ...(params as Record<string, any>) }
		Object.entries(evaluated).forEach(([key, value]) => {
			if (isDynamicValue(value)) {
				// null ?? undefined → undefined, so nullish params get dropped on serialization
				evaluated[key] = getDynamicValue(value, {}) ?? undefined
			}
		})
		return evaluated
	}

	const resolveDocnameFromFilters = async (resource: DocumentResource, filters: Partial<Filters>) => {
		// the common `name = {{ route.params.id }}` case resolves to the docname itself — no server lookup needed
		const keys = Object.keys(filters)
		if (keys.length === 1 && keys[0] === "name") {
			const name = filters.name
			if (!Array.isArray(name)) return name
			if (name[0] === "=") return name[1]
		}
		if (!keys.length || Object.values(filters).some((value) => value == null)) return null
		// other filters (e.g. category = tech) need a lookup for one matching doc's name
		const doc = await call("frappe.client.get_value", {
			doctype: resource.document_type,
			fieldname: "name",
			filters,
		})
		return doc?.name
	}

	const getTransforms = (resource: Resource) => {
		if (!resource.transform) return {}
		return {
			transform: (data: any) => {
				try {
					const context = { ...scriptContext.value, data }
					const transformFn = new Function(
						"ctx",
						`with(ctx) {
							${resource.transform}
							return transform(data);
						}`,
					)
					return transformFn(context)
				} catch (error) {
					console.error(`Error executing transform: ${resource.transform}`, error)
					return data
				}
			},
		}
	}

	const getSuccessErrorHandlers = (resource: Resource) => {
		const handlers: Record<string, Function> = {}
		if (resource.on_success) {
			handlers["onSuccess"] = (data: DataResult) => {
				return handleSuccess(resource.on_success!, data)
			}
		}
		if (resource.on_error) {
			handlers["onError"] = (error: any) => {
				return handleError(resource.on_error!, error)
			}
		}
		return handlers
	}

	const getWhitelistedMethods = (resource: DocumentResource) => {
		if (resource.whitelisted_methods) {
			let whitelisted_methods = resource.whitelisted_methods
			if (typeof resource.whitelisted_methods === "string") {
				whitelisted_methods = JSON.parse(resource.whitelisted_methods)
			}
			const methods: Record<string, string> = {}
			whitelisted_methods.forEach((method: string) => methods[method] = method)
			return { whitelistedMethods: methods }
		}
		return {}
	}

	function stopResourceWatchers() {
		resourceWatchers.forEach((stop) => stop())
		resourceWatchers = []
	}

	function teardownPage() {
		pendingResources = null
		resourceRequests?.stop()
		resourceRequests = null
		startResources = []
		currentPageName.value = null
		stopResourceWatchers()
		disposePageScriptScope()
	}

	function getValueFromBinding(bindingPath: string, localContext?: ExpressionEvaluationContext) {
		const context = { ...pageScriptTemplateBindings.value, ...localContext }
		return getValueFromObject(context, bindingPath)
	}

	function setValueInBinding(bindingPath: string, value: any, localContext?: ExpressionEvaluationContext) {
		const pathParts = bindingPath.split(".")
		const rootKey = pathParts[0]
		if (localContext && localContext[rootKey] !== undefined) {
			setValueInObject(localContext, bindingPath, value)
			return
		}

		const binding = pageScriptBindings.value[rootKey]
		if (isRef(binding)) {
			if (pathParts.length === 1) {
				binding.value = value
			} else {
				setValueInObject(binding.value as Record<string, any>, pathParts.slice(1).join("."), value)
			}
			return
		}
		setValueInObject(pageScriptBindings.value, bindingPath, value)
	}

	// PAGE SCRIPT
	async function setPageScript(page: StudioPage) {
		const requests = resourceRequests
		requests?.pause()
		try {
			await runPageScript(page)
		} finally {
			requests?.resume()
		}
	}

	async function runPageScript(page: StudioPage) {
		disposePageScriptScope()
		const scope = new PageScriptScope(reportPageScriptError)
		pageScriptScope = scope
		pageScriptBindings.value = {}
		pageScriptError.value = null
		currentPageName.value = page.name

		if (page.is_standard) {
			const module = await loadPageScriptModule(page.name)
			if (!scope.active) return
			if (typeof module?.default === "function") {
				pageScriptBindings.value = scope.run(() => module.default(scriptContext.value))
			}
		} else if (page.script?.trim()) {
			pageScriptBindings.value = compilePageScript(page.script, getTopLevelBindings(page.script))
		}
	}

	function disposePageScriptScope() {
		pageScriptScope?.stop()
		pageScriptScope = null
	}

	function compilePageScript(source: string, bindingNames: string[]) {
		// Run the page script source once, like a Vue `<script setup>`, and return every top-level
		// binding (refs/reactive/computed/functions/classes). Free identifiers resolve through a
		// proxy over the LIVE execution context, so the script sees the Vue reactivity APIs and
		// resources and modules — including ones registered a tick later. The source is
		// always run (even with no named bindings) so watcher-only scripts still take effect.
		const liveContext = new Proxy(
			{},
			{
				has(_target, key) {
					// let globals (console, Function, …) fall through to the outer scope
					if (key === Symbol.unscopables) return false
					return key in interpretedScriptContext.value
				},
				get(_target, key) {
					return (interpretedScriptContext.value as Record<string | symbol, any>)[key]
				},
			},
		)
		return pageScriptScope!.run(() => {
			const factory = new Function(
				"context",
				`with (context) {
					${source}
					return { ${bindingNames.join(", ")} };
				}`,
			)
			return factory(liveContext)
		}) || {}
	}

	function reportPageScriptError(error: unknown) {
		console.error("Error running page script", error)
		pageScriptError.value = error instanceof Error ? error.message : String(error)
	}

	// HMR: the active page's script (or a composable/util it imports) was edited. Re-run its setup
	// with the freshly hot-loaded module so new refs/computed and changed dependency code take
	// effect without a reload. (Pinia stores keep their singleton state — they refresh their code
	// only via their own acceptHMRUpdate.) Registered once here so both the editor and the preview
	// (each with their own codeStore) hot-apply script edits to the page they're showing.
	async function applyPageScriptHMR(setup: unknown) {
		const requests = resourceRequests
		requests?.pause()
		disposePageScriptScope()
		pageScriptScope = new PageScriptScope(reportPageScriptError)
		pageScriptError.value = null
		pageScriptBindings.value = {}
		if (typeof setup === "function") {
			pageScriptBindings.value = pageScriptScope.run(() => setup(scriptContext.value))
		}
		requests?.resume()
	}
	setPageScriptHotUpdateHandler((pageName, setup) => {
		if (currentPageName.value === pageName) applyPageScriptHMR(setup)
	})

	// SCRIPT CONTEXTS
	const evalContext = computed(() => {
		return {
			...resources.value,
			...pageScriptTemplateBindings.value,
			...globalUtils,
			route: unref(routeObject.value),
			router: routerObject.value,
		}
	})

	// Base context for every script scope — event/success/error handlers, function-value props, and page-script setup
	const scriptContext = computed(() => {
		return {
			...currentResourceProxies(),
			...pageScriptBindings.value,
			...globalUtils,
			route: currentRoute,
			router: routerObject.value,
		}
	})

	// for non-standard pages: scriptContext + vueReactivityApis since it can't import them
	const interpretedScriptContext = computed(() => {
		return {
			...vueReactivityApis,
			...scriptContext.value,
		}
	})

	const resourceProxies: Record<string, any> = {}
	function currentResourceProxies() {
		const proxies: Record<string, any> = {}
		for (const name in resources.value) {
			resourceProxies[name] ??= proxyToCurrent(() => resources.value[name])
			proxies[name] = resourceProxies[name]
		}
		return proxies
	}

	const currentRoute = proxyToCurrent(() => unref(routeObject.value))

	function proxyToCurrent(getCurrent: () => any) {
		return new Proxy(
			{},
			{
				get: (_, key) => getCurrent()?.[key],
				has: (_, key) => key in (getCurrent() || {}),
				set: (_, key, value) => {
					const target = getCurrent()
					if (target) target[key] = value
					return true
				},
				ownKeys: () => Reflect.ownKeys(getCurrent() || {}),
				getOwnPropertyDescriptor: (_, key) => {
					const target = getCurrent()
					if (target && key in target) return { enumerable: true, configurable: true, value: target[key] }
				},
			},
		)
	}

	// EXPRESSION EVALUATION
	function getDynamicValue(value: string, localContext: ExpressionEvaluationContext) {
		let result = ""
		let lastIndex = 0

		const context = { ...evalContext.value, ...localContext }

		if (!isDynamicValue(value)) {
			return evaluateExpression(value, context)
		}

		// Find all dynamic expressions in the prop value
		const matches = value.matchAll(/\{\{(.*?)\}\}/g)

		// Evaluate each dynamic expression and add it to the result
		for (const match of matches) {
			const expression = match[1].trim()
			const dynamicValue = evaluateExpression(expression, context)

			if (dynamicValue !== null && typeof dynamicValue === "object") {
				// for proptype as object, return the evaluated object as is
				// TODO: handle this more explicitly by checking the actual prop type
				return dynamicValue
			}

			// If the whole value is a single dynamic expression, return the normalized evaluated value
			// e.g. value === "{{ showTooltip }}" should return boolean true/false if appropriate
			if (value.trim().match(/^\{\{.*\}\}$/)) {
				return normalizeDynamicValue(dynamicValue)
			}

			// Append the static part of the string
			result += value.slice(lastIndex, match.index)
			// Append the evaluated dynamic value, treating null/undefined as empty
			result += dynamicValue != null ? String(dynamicValue) : ""
			// update lastIndex to the end of the current match
			lastIndex = match.index + match[0].length
		}

		// Append the final static part of the string
		result += value.slice(lastIndex)
		return result || undefined
	}

	function evaluateDynamicValues(value: string | object | number, localContext: ExpressionEvaluationContext = {}): any {
		/* recurse into arrays/objects and evaluate dynamic expressions */
		if (typeof value === "string") {
			if (isDynamicValue(value)) {
				return getDynamicValue(value, localContext)
			}
			if (isFunctionExpression(value)) {
				const func = stringToFunction(value, localContext)
				if (typeof func === "function") {
					return func
				}
			}
			return value
		}

		if (Array.isArray(value)) {
			return value.map((item) => evaluateDynamicValues(item, localContext))
		}

		if (value !== null && typeof value === "object") {
			const result: Record<string, any> = {}
			for (const [key, val] of Object.entries(value)) {
				result[key] = evaluateDynamicValues(val, localContext)
			}
			return result
		}

		return value
	}

	function evaluateExpression(expression: string, localContext: ExpressionEvaluationContext) {
		try {
			const context = { ...evalContext.value, ...localContext }
			// Replace dot notation with optional chaining via AST
			const safeExpression = toOptionalChaining(expression)

			// Create a function that takes the context as an argument
			const func = new Function('context', `
				with (context || {}) {
					try {
						return ${safeExpression};
					} catch (e) {
						return undefined;
					}
				}
			`)

			return func(context)
		} catch (error) {
			console.error(`Error evaluating expression: ${expression}`, error)
			return undefined
		}
	}

	function stringToFunction(value: string, localContext: Record<string, any>): Function | string {
		/**
		 * Convert a function string to an actual function
		 * Used for component props that have function values
		 */
		const registeredComponents = window.__APP_COMPONENTS__ || {}

		try {
			const fn = new Function(
				"h",
				...Object.keys(registeredComponents),
				...Object.keys(scriptContext.value),
				...Object.keys(localContext),
				`return (${value})`
			)
			return fn(h, ...Object.values(registeredComponents), ...Object.values(scriptContext.value), ...Object.values(localContext))
		} catch (e) {
			return value
		}
	}

	// EVENT SCRIPTS
	function executeUserScript(
		script: string,
		slotScope?: Record<string, any>,
		componentContext?: Record<string, any>,
		eventArgs?: any[],
	) {
		try {
			const context = { ...scriptContext.value, ...slotScope, ...componentContext, eventArgs }

			const scriptToExecute = `
				with (context) {
				${script}
				if (typeof handleEvent === "function") {
					return handleEvent(...(context.eventArgs || []));
				}
				}
			`;
			const scriptFunction = new Function("context", scriptToExecute);
			return scriptFunction(context);
		} catch (error) {
			console.error(`Error executing the script: ${script}`, error)
		}
	}

	function handleSuccess(
		script: string,
		data: DataResult,
		slotScope?: Record<string, any>,
		componentContext?: Record<string, any>,
		eventArgs?: any[],
	) {
		try {
			const context = {
				...scriptContext.value,
				...slotScope,
				...componentContext,
				eventArgs,
				data,
			}

			const successFn = new Function(
				"ctx",
				`with(ctx) {
					${script}
					return onSuccess(data);
				}`,
			)
			return successFn(context)
		} catch (error) {
			console.error(`Error executing success script: ${script}`, error)
		}
	}

	function handleError(
		script: string,
		error: any,
		slotScope?: Record<string, any>,
		componentContext?: Record<string, any>,
		eventArgs?: any[],
	) {
		try {
			const context = {
				...scriptContext.value,
				...slotScope,
				...componentContext,
				eventArgs,
				error,
			}

			const errorFn = new Function(
				"ctx",
				`with(ctx) {
					${script}
					return onError(error);
				}`,
			)
			return errorFn(context)
		} catch (err) {
			console.error(`Error executing error script: ${script}`, err)
		}
	}

	return {
		setRouteObject,
		setRouterObject,
		routeObject,
		routerObject,
		teardownPage,
		// resources
		resources,
		initializePage,
		setPageResources,
		// two-way prop bindings (props stored as { $type: "variable", name })
		getValueFromBinding,
		setValueInBinding,
		// page script
		pageScriptBindings,
		pageScriptTemplateBindings,
		pageScriptError,
		setPageScript,
		// code execution
		evalContext,
		scriptContext,
		interpretedScriptContext,
		getDynamicValue,
		evaluateDynamicValues,
		executeUserScript,
		handleSuccess,
		handleError,
		getAPIParams,
		stringToFunction,
	}
})

export default useCodeStore

/** Bind inputs at request time, including calls made by user watchers before Vue flushes. */
function bindResourceInputs(
	resource: any,
	requests: ResourceRequests,
	field: "params" | "filters",
	evaluate: () => any,
	readOnly: boolean,
) {
	const inputs = computed(evaluate)
	const override = shallowRef<any>()
	const currentInputs = () => (override.value === undefined ? inputs.value : override.value)
	const readKey = {}
	const fetch = field === "filters" ? resource.list.fetch : resource.fetch
	const request = (args: any[], read: boolean) =>
		requests.run(
			() => {
				if (field === "filters") {
					resource.update({ filters: currentInputs() })
					return fetch(...args)
				}
				return fetch(args[0] ?? currentInputs(), ...args.slice(1))
			},
			read && !args.length ? readKey : undefined,
		)

	const reload = (...args: any[]) => request(args, readOnly)
	if (field === "filters") {
		// Pagination and list.reload() also reach this entry point.
		resource.list.fetch = reload
		resource.list.reload = reload
		resource.list.submit = (...args: any[]) => request(args, false)
		resource.fetch = (...args: any[]) => resource.reload(...args)
		for (const name of ["fetchOne", "insert", "setValue", "delete", "runDocMethod"]) {
			const operation = resource[name]
			for (const method of ["fetch", "reload", "submit"]) {
				const invoke = operation[method]
				operation[method] = (...args: any[]) => requests.run(() => invoke(...args))
			}
		}
	} else {
		resource.fetch = reload
		resource.reload = reload
		resource.submit = (...args: any[]) => request(args, false)
	}

	return new Proxy(markRaw({}) as Record<string | symbol, any>, {
		get(target, key) {
			if (typeof key === "string" && key.startsWith("__v_")) return target[key]
			if (key === field) return currentInputs()
			if (key === "update")
				return (options: Record<string, any>) => {
					if (field in options) override.value = options[field]
					resource.update(options)
				}
			return resource[key]
		},
		has: (_target, key) => key === field || key in resource,
		ownKeys: () => Reflect.ownKeys(resource),
		getOwnPropertyDescriptor: (_target, key) => Object.getOwnPropertyDescriptor(resource, key),
		set(_target, key, value) {
			if (key === field) override.value = value
			else resource[key] = value
			return true
		},
	})
}

/** A document's methods exist before its filters have resolved to a name. */
class PageDocumentResource {
	private current = shallowRef<any>(null)
	private lookup: Promise<any> | null = null
	private lookupKey = ""
	private readKey = {}
	readonly resource: any

	constructor(
		private requests: ResourceRequests,
		private options: Record<string, any>,
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
		this.resource = new Proxy(markRaw(initial), {
			get: (target, key) =>
				(typeof key === "string" && key.startsWith("__v_")) ||
				key in methods ||
				["reload", "auto", "resource_id", "resource_type"].includes(String(key))
					? target[key]
					: (this.current.value?.[key] ?? target[key]),
			set: (target, key, value) => {
				if (["auto", "resource_id", "resource_type"].includes(String(key))) target[key] = value
				else if (this.current.value) this.current.value[key] = value
				else target[key] = value
				return true
			},
		})
	}

	initialize() {
		return this.requests.run(() => this.resolve())
	}

	private operation(name: string) {
		const initial: Record<string | symbol, any> = { data: null, loading: false, error: null, promise: null }
		const invoke = (method: string, args: any[]) => {
			const promise = this.requests.run(
				async () => {
					const document = await this.resolve()
					if (!document || !this.requests.active) return
					return document[name][method](...args)
				},
				name === "get" && method !== "submit" && !args.length ? this.readKey : undefined,
			)
			initial.promise = promise
			return promise
		}
		return new Proxy(markRaw(initial), {
			get: (target, key) => {
				if (typeof key === "string" && key.startsWith("__v_")) return target[key]
				if (["fetch", "reload", "submit"].includes(String(key)))
					return (...args: any[]) => invoke(String(key), args)
				return this.current.value?.[name]?.[key] ?? target[key]
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
				if (!this.requests.active || this.lookup !== lookup) return null
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

/** Hold requests until setup has exposed state; batch duplicate reads within a tick. */
class ResourceRequests {
	private pauses = 1
	private stopped = false
	private scheduled = false
	private pending = new Map<object, { request: Request; promise: Promise<any> }>()

	get active() {
		return !this.stopped
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

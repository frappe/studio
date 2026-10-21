import {
	ref, computed, watch, watchEffect, reactive, toRef, toRefs, unref,
	isRef, isReactive, shallowRef, readonly, markRaw, nextTick,
	type ComputedRef, h,
} from "vue"
import { watchDebounced } from "@vueuse/core"
import { createListResource, createResource, call } from "frappe-ui"
import { PageScriptScope } from "@/page/pageScriptScope"
import { PageResourceScope, PageDocumentResource, bindResourceInputs } from "@/page/pageResourceScope"
import { studioPageResources } from "@/data/studioResources"
import { loadPageScriptModule } from "@/data/studioPageScripts"
import * as globalUtils from "@/utils/globalUtils"
import { useSocket } from "@/socket"
import { getValueFromObject, setValueInObject } from "@/utils/helpers"
import { isDynamicValue, normalizeDynamicValue } from "@/utils/code"
import { DYNAMIC_EXPRESSION_CONTENT_REGEX } from "@/utils/constants"
import { isFunctionExpression, toOptionalChaining, getTopLevelBindings } from "@/utils/parseCode"
import type {
	Filters,
	Resource,
	DocumentResource,
	DocumentListResource,
	APIResource,
	DataResult,
	PageResource,
	APIResourceInstance,
	ListResourceInstance,
} from "@/types/Studio/StudioResource"
import type { StudioPage } from "@/types/Studio/StudioPage"
import type { ExpressionEvaluationContext } from "@/types"
import type { Ref } from "vue"
import type { Router, RouteLocationNormalized } from "vue-router"

export const vueReactivityApis = {
	ref, reactive, computed, watch, watchEffect, watchDebounced,
	toRef, toRefs, unref, isRef, isReactive,
	shallowRef, readonly, markRaw, nextTick,
}

type PageResourceOptions = {
	/** Use these definitions instead of fetching the page's resources. */
	preloadedResources?: Resource[]
}

// One page's data: resources, page script and the contexts bindings evaluate against
export function createPageScope(
	routeObject: Ref<ComputedRef | RouteLocationNormalized | undefined>,
	routerObject: Ref<Router | Readonly<Router> | undefined>,
) {
	const resources = ref<Record<string, PageResource>>({})

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
	let pageResourceScope: PageResourceScope | null = null

	// RESOURCES
	// Resources are created inert, the page script runs with them in scope, and only then do their
	// input watchers start and auto-fetches run, so filters/params can read the script's state.
	async function initializePage(
		page: StudioPage,
		{ preloadedResources }: PageResourceOptions = {},
	) {
		teardownPage()
		const resourceScope = await preparePageResources(page, { preloadedResources })
		if (!resourceScope.active) return
		await setPageScript(page)
		resourceScope.activate()
	}

	async function setPageResources(
		page: StudioPage,
		{ preloadedResources }: PageResourceOptions = {},
	) {
		const resourceScope = await preparePageResources(page, { preloadedResources })
		resourceScope.activate()
	}

	async function preparePageResources(
		page: StudioPage,
		{ preloadedResources }: PageResourceOptions,
	) {
		pageResourceScope?.stop()
		const resourceScope = new PageResourceScope()
		pageResourceScope = resourceScope
		const pageResources = reactive<Record<string, PageResource>>({})
		const resourceRows = await getPageResourceRows(page, preloadedResources)
		if (!resourceScope.active) return resourceScope

		for (const row of resourceRows) {
			const resource = createPageResource(row, resourceScope)
			pageResources[row.resource_name] = resource
		}
		resources.value = pageResources
		return resourceScope
	}

	async function getPageResourceRows(page: StudioPage, preloadedResources?: Resource[]) {
		let rows = preloadedResources
		if (!rows) {
			studioPageResources.filters = { parent: page.name }
			rows = (await studioPageResources.reload()) as Resource[]
		}
		return rows.map((row: Resource) => {
			const resource = { ...row }
			for (const field of ["fields", "filters", "params", "whitelisted_methods"]) {
				const value = resource[field]
				if (typeof value === "string") resource[field] = value.trim() ? JSON.parse(value) : undefined
			}
			return resource
		})
	}

	function createPageResource(resource: Resource, resourceScope: PageResourceScope): PageResource {
		switch (resource.resource_type) {
			case "Document":
				return createPageDocumentResource(resource, resourceScope)
			case "Document List":
				return createPageListResource(resource, resourceScope)
			case "API Resource":
				return createPageAPIResource(resource, resourceScope)
		}
	}

	function createPageListResource(resource: DocumentListResource, resourceScope: PageResourceScope) {
		const list: ListResourceInstance = createListResource({
			doctype: resource.document_type,
			fields: resource.fields?.length ? resource.fields : "*",
			pageLength: resource.limit,
			orderBy: resource.sort_field ? `${resource.sort_field} ${resource.sort_order}` : undefined,
			auto: false,
			...getTransforms(resource),
			...getSuccessErrorHandlers(resource),
		})
		list.data = []
		const evaluate = () => getEvaluatedFilters(resource.filters)
		const bound = bindResourceInputs(list, resourceScope, "filters", evaluate, true)
		bound.auto = resource.auto
		watchResourceInputs(resourceScope, bound, evaluate)
		return bound
	}

	function createPageAPIResource(resource: APIResource, resourceScope: PageResourceScope) {
		const api: APIResourceInstance = createResource({
			url: resource.url,
			method: resource.method,
			auto: false,
			...getTransforms(resource),
			...getSuccessErrorHandlers(resource),
		})
		const evaluate = () => getAPIParams(resource.params)
		const bound = bindResourceInputs(api, resourceScope, "params", evaluate, resource.method === "GET")
		bound.auto = resource.auto
		watchResourceInputs(resourceScope, bound, evaluate)
		return bound
	}

	function createPageDocumentResource(resource: DocumentResource, resourceScope: PageResourceScope) {
		const evaluate = () => resource.fetch_document_using_filters
			? getEvaluatedFilters(resource.filters) || {}
			: { name: resource.document_name }
		const document = new PageDocumentResource(resourceScope, {
			doctype: resource.document_type,
			...getTransforms(resource),
			...getSuccessErrorHandlers(resource),
			...getWhitelistedMethods(resource),
		}, evaluate, (filters) => resolveDocnameFromFilters(resource, filters))
		document.resource.auto = resource.auto
		watchResourceInputs(resourceScope, document.resource, evaluate, () => { void document.initialize() })
		return document.resource
	}

	function watchResourceInputs(resourceScope: PageResourceScope, resource: PageResource, evaluate: () => any, initialize?: () => void) {
		resourceScope.onStart(() => {
			const refresh = () => {
				initialize?.()
				if (resource.auto) void resource.reload()
			}
			return watch(() => JSON.stringify(evaluate()), refresh, { immediate: true })
		})
	}

	function getEvaluatedFilters(filters: Filters | null = null) {
		if (!filters) return

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

	function evaluateFilterValue(value: any): any {
		if (Array.isArray(value)) {
			return value.map((item) => evaluateFilterValue(item)).filter((item) => item !== undefined)
		}
		if (isDynamicValue(value)) {
			// null ?? undefined → undefined, so nullish filters get dropped on serialization
			return getDynamicValue(value, {}) ?? undefined
		}
		return value
	}

	function getAPIParams(params: Record<string, any> | null = null) {
		if (!params) return null
		// evaluate on a copy: evaluation re-runs on every context change and must not bake values into the config
		const evaluated: Record<string, any> = { ...params }
		Object.entries(evaluated).forEach(([key, value]) => {
			if (isDynamicValue(value)) {
				// null ?? undefined → undefined, so nullish params get dropped on serialization
				evaluated[key] = getDynamicValue(value, {}) ?? undefined
			}
		})
		return evaluated
	}

	async function resolveDocnameFromFilters(resource: DocumentResource, filters: Partial<Filters>) {
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

	function getTransforms(resource: Resource) {
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

	function getSuccessErrorHandlers(resource: Resource) {
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

	function getWhitelistedMethods(resource: DocumentResource) {
		if (resource.whitelisted_methods) {
			const methods: Record<string, string> = {}
			resource.whitelisted_methods.forEach((method: string) => methods[method] = method)
			return { whitelistedMethods: methods }
		}
		return {}
	}

	function teardownPage() {
		pageResourceScope?.stop()
		pageResourceScope = null
		currentPageName.value = null
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
		const resourceScope = pageResourceScope
		resourceScope?.pause()
		try {
			await runPageScript(page)
		} finally {
			resourceScope?.resume()
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

	// HMR: this page's script (or a composable/util it imports) was edited. Re-run its setup
	// with the freshly hot-loaded module so new refs/computed and changed dependency code take
	// effect without a reload.
	function applyPageScriptHotUpdate(pageName: string, setup: unknown) {
		if (currentPageName.value !== pageName) return
		const resourceScope = pageResourceScope
		resourceScope?.pause()
		disposePageScriptScope()
		pageScriptScope = new PageScriptScope(reportPageScriptError)
		pageScriptError.value = null
		pageScriptBindings.value = {}
		if (typeof setup === "function") {
			pageScriptBindings.value = pageScriptScope.run(() => setup(scriptContext.value))
		}
		resourceScope?.resume()
	}

	// SCRIPT CONTEXTS
	const evalContext = computed(() => {
		return {
			...resources.value,
			...pageScriptTemplateBindings.value,
			...globalUtils,
			socket: useSocket(),
			route: unref(routeObject.value),
			router: routerObject.value,
		}
	})

	// Base context for every script scope — event/success/error handlers, function-value props, and page-script setup
	const scriptContext = computed(() => {
		// Resources and currentRoute are proxies so scripts can destructure them once and still see the current values
		return {
			...currentResourceProxies(),
			...pageScriptBindings.value,
			...globalUtils,
			socket: useSocket(),
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
		const matches = value.matchAll(DYNAMIC_EXPRESSION_CONTENT_REGEX)

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
			if (match[0] === value.trim()) {
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

	return reactive({
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
		applyPageScriptHotUpdate,
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
	})
}

export type PageScope = ReturnType<typeof createPageScope>


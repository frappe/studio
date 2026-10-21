import type { Operators } from "@/types"
export type ResourceType = "API Resource" | "Document List" | "Document"
export type Filters = Record<string, [Operators, any] | string | number | boolean | null>

interface BaseResource {
	/**	Child Table record name = Resource ID */
	resource_id: string
	resource_name: string
	resource_type: ResourceType
	/** Whether to automatically fetch data on first load */
	auto?: boolean
	transform?: string | null
	on_success?: string
	on_error?: string
	/** for Whitelisted methods */
	[key: string]: any
}

export interface DocumentResource extends BaseResource {
	resource_type: "Document"
	document_type: string
	document_name?: string
	whitelisted_methods?: string[]
	fetch_document_using_filters?: boolean
	filters?: Filters
}

export interface DocumentListResource extends BaseResource {
	resource_type: "Document List"
	document_type: string
	fields?: string[]
	filters?: Filters
	limit?: number | null
	sort_field?: string
	sort_order?: "" | "ASC" | "DESC"
}

export interface APIResource extends BaseResource {
	resource_type: "API Resource"
	url: string
	method: "GET" | "POST" | "PUT" | "DELETE"
	filters?: Filters
	params?: Record<string, any>
}

export type Resource = DocumentResource | DocumentListResource | APIResource

// result
export type DocumentResult = Record<string, any>
export type DataResult = Array<Record<string, any>>

// Live resources exposed to page scripts, separate from the saved definitions above.
export interface ResourceOperation<T = unknown> {
	data: T | null
	loading: boolean
	error: unknown
	promise: Promise<T | null | undefined> | null
	fetch: (...args: unknown[]) => Promise<T | null | undefined>
	reload: (...args: unknown[]) => Promise<T | null | undefined>
	submit: (...args: unknown[]) => Promise<T | null | undefined>
}

export interface APIResourceInstance extends ResourceOperation {
	auto?: boolean
	params: Record<string, unknown> | null | undefined
	previousData: unknown
	fetched: boolean
	url?: string
	method?: string
	update: (options: Record<string, unknown>) => void
	setData: (data: unknown) => void
	abort: () => void
	reset: () => void
}

export interface ListResourceInstance {
	auto?: boolean
	doctype: string
	data: DocumentResult[] | null
	originalData: DocumentResult[] | null
	dataMap: Record<string, DocumentResult>
	filters?: Partial<Filters>
	fields?: string[] | "*"
	orderBy?: string
	start: number
	pageLength: number
	hasPreviousPage: boolean
	hasNextPage: boolean
	previous: () => void
	next: () => void
	list: ResourceOperation<DocumentResult[]>
	fetchOne: ResourceOperation<DocumentResult[]>
	insert: ResourceOperation<DocumentResult>
	setValue: ResourceOperation<DocumentResult>
	delete: ResourceOperation
	runDocMethod: ResourceOperation
	fetch: ResourceOperation<DocumentResult[]>["fetch"]
	reload: ResourceOperation<DocumentResult[]>["reload"]
	update: (options: Record<string, unknown>) => void
	setData: (data: DocumentResult[] | ((current: DocumentResult[] | null) => DocumentResult[])) => void
	getRow: (name: string | number) => DocumentResult | undefined
}

export interface DocumentResourceInstance {
	auto?: boolean
	doctype: string
	name: string | null
	doc: DocumentResult | null
	get: ResourceOperation<DocumentResult>
	setValue: ResourceOperation<DocumentResult>
	setValueDebounced: ResourceOperation<DocumentResult>
	save: ResourceOperation<DocumentResult>
	delete: ResourceOperation<DocumentResult>
	reload: ResourceOperation<DocumentResult>["reload"]
	// These become available after the document name resolves.
	originalDoc?: DocumentResult | null
	isDirty?: boolean
	setDoc?: (doc: DocumentResult | ((current: DocumentResult | null) => DocumentResult)) => void
}

export type PageResource = APIResourceInstance | ListResourceInstance | DocumentResourceInstance

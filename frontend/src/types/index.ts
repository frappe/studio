import Block from "../utils/block"
import { VuePropDefault, VuePropType } from "@/types/vue"

export type ObjectLiteral = Record<string, any>

export type StyleValue = string | number | null | undefined

export interface BlockStyleMap {
	[key: string]: StyleValue
}

export interface BlockOptions {
	componentId?: string
	componentName: string
	componentProps?: Record<string, any>
	componentEvents?: Record<string, any>
	children?: Array<BlockOptions>
	baseStyles?: BlockStyleMap
	mobileStyles?: BlockStyleMap
	tabletStyles?: BlockStyleMap
	blockName?: string
	parentBlock?: Block | null
	[key: string]: any
}

export interface Breakpoint {
	icon: string;
	device: string;
	displayName: string;
	width: number;
	visible: boolean;
}

export interface CanvasProps {
	overlayElement: HTMLElement | null;
	background: string;
	scale: number;
	translateX: number;
	translateY: number;
	settingCanvas: boolean;
	scaling: boolean;
	panning: boolean;
	breakpoints: Breakpoint[];
}

export interface ContextMenuOption {
	label: string
	action: CallableFunction
	condition?: () => boolean
}

export interface ComponentProps {
	[key: string]: {
		type: string,
		default: VuePropDefault,
		inputType: string
	}
}

// controls
export type SelectOption = { value: string, label: string }

// dynamic data
export type ExpressionEvaluationContext = Record<string, any> | undefined

export interface FrappeUIComponents {
	[key: string]: {
		name: string,
		title: string,
		icon: string,
		initialState?: Record<string, any>,
		props?: Array<Record<string, any>>,
		emits?: Array<string> | Record<string, any>,
	}
}

export type DocTypeField = {
	fieldname: string
	fieldtype: string
	label: string
}
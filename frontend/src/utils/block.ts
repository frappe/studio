import { BlockOptions, BlockStyleMap } from "@/types"
import { clamp } from "@vueuse/core"
import { reactive, CSSProperties, nextTick } from 'vue'

import useStore from "@/store";
import components from "@/data/components";
import { getBlockCopy, kebabToCamelCase, numberToPx } from "./helpers";

export type styleProperty = keyof CSSProperties | `__${string}`;
class Block implements BlockOptions {
	componentId: string
	componentName: string
	blockName: string
	originalElement?: string | undefined
	children: BlockOptions[]
	parentBlock: Block | null
	baseStyles: BlockStyleMap
	mobileStyles: BlockStyleMap
	tabletStyles: BlockStyleMap

	constructor(options: BlockOptions) {
		this.componentName = options.componentName
		this.blockName = options.blockName || this.componentName
		this.originalElement = options.originalElement
		this.baseStyles = reactive(options.baseStyles || {})
		this.mobileStyles = reactive(options.mobileStyles || {});
		this.tabletStyles = reactive(options.tabletStyles || {});

		// generate ID
		if (!options.componentId) {
			this.componentId = this.generateComponentId()
		} else {
			this.componentId = options.componentId
		}

		// set up hierarchy
		this.parentBlock = options.parentBlock || null
		this.children = (options.children || []).map((child: BlockOptions) => {
			child.parentBlock = this;
			return reactive(new Block(child))
		})
	}

	generateComponentId(componentName?: string | null): string {
		return `${componentName || this.componentName}-${Math.random().toString(36).substring(2, 9)}`
	}

	addChild(child: BlockOptions, index?: number | null) {
		child.parentBlock = this
		if (index === undefined || index === null) {
			index = this.children.length
		}
		index = clamp(index, 0, this.children.length)

		this.children.splice(index, 0, child)
		return child
	}

	removeChild(child: Block) {
		const index = this.getChildIndex(child)
		if (index > -1) {
			this.children.splice(index, 1)
		}
	}

	getChildIndex(child: Block) {
		return this.children.findIndex((block) => block.componentId === child.componentId);
	}

	addChildAfter(child: BlockOptions, siblingBlock: Block) {
		const siblingIndex = this.getChildIndex(siblingBlock)
		return this.addChild(child, siblingIndex + 1)
	}

	hasChildren() {
		return this.children.length > 0
	}

	isRoot() {
		return this.componentId === "root" || this.originalElement === "body";
	}

	getParentBlock(): Block | null {
		return this.parentBlock || null;
	}

	getIcon() {
		if (this.isRoot()) return "Hash"
		return components.get(this.componentName)?.icon
	}

	getBlockDescription() {
		return this.blockName || this.originalElement
	}

	// styles
	getStyles(): BlockStyleMap {
		return { ...this.baseStyles }
	}

	getStyle(style: styleProperty) {
		return this.baseStyles[style]
	}

	setStyle(style: styleProperty, value: StyleValue) {
		const store = useStore()
		let styleObj = this.baseStyles
		style = kebabToCamelCase(style) as styleProperty

		if (store.activeBreakpoint === "mobile") {
			styleObj = this.mobileStyles
		} else if (store.activeBreakpoint === "tablet") {
			styleObj = this.tabletStyles
		}
		if (value === null || value === "") {
			delete styleObj[style]
			return;
		}
		styleObj[style] = value
	}

	toggleVisibility() {
		if (this.getStyle("display") === "none") {
			this.setStyle("display", this.getStyle("__last_display") || "flex");
			this.setStyle("__last_display", null);
		} else {
			this.setStyle("__last_display", this.getStyle("display"));
			this.setStyle("display", "none");
		}
	}

	isVisible() {
		return this.getStyle("display") !== "none"
	}

	// context menu
	duplicateBlock() {
		if (this.isRoot()) return

		const store = useStore()
		const blockCopy = getBlockCopy(this)
		const parentBlock = this.getParentBlock()

		if (blockCopy.getStyle("position") === "absolute") {
			// shift the block a bit
			const left = numberToPx(blockCopy.getStyle("left"));
			const top = numberToPx(blockCopy.getStyle("top"));
			blockCopy.setStyle("left", `${left + 20}px`);
			blockCopy.setStyle("top", `${top + 20}px`);
		}

		let child = null as Block | null;
		if (parentBlock) {
			child = parentBlock.addChildAfter(blockCopy, this);
		} else {
			child = store.canvas?.getRootBlock().addChild(blockCopy) as Block;
		}
		nextTick(() => {
			if (child) {
				store.selectBlock(child);
			}
		});
	}
}

export default Block
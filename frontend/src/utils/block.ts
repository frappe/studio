import { BlockOptions, BlockStyleMap, SlotOptions } from "@/types"
import { clamp } from "@vueuse/core"
import { reactive, CSSProperties, nextTick } from 'vue'

import useStudioStore from "@/stores/studioStore";
import components from "@/data/components";
import { copyObject, getBlockCopy, isObjectEmpty, kebabToCamelCase, numberToPx } from "./helpers";

import { StyleValue } from "@/types"
import { ComponentEvent } from "@/types/ComponentEvent"

export type styleProperty = keyof CSSProperties | `__${string}`;
class Block implements BlockOptions {
	componentId: string
	componentName: string
	componentProps: Record<string, any>
	componentSlots: Record<string, SlotOptions>
	componentEvents: Record<string, any>
	blockName: string
	originalElement?: string | undefined
	children: Block[]
	parentBlock: Block | null
	baseStyles: BlockStyleMap
	mobileStyles: BlockStyleMap
	tabletStyles: BlockStyleMap
	classes?: string[]
	parentSlotName?: string

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

		// get component props
		if (!options.componentProps) {
			this.componentProps = copyObject(components.get(options.componentName)?.initialState)
		} else {
			this.componentProps = options.componentProps
		}
		this.componentEvents = options.componentEvents || {}
		this.componentSlots = options.componentSlots || {}
		this.initializeSlots()
		if (options.parentSlotName) {
			this.parentSlotName = options.parentSlotName
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

	deleteBlock() {
		const parentBlock = this.getParentBlock()
		if (parentBlock) {
			parentBlock.removeChild(this)
		}
	}

	addChild(child: BlockOptions, index?: number | null) {
		if (child.parentSlotName) {
			return this.updateSlot(child.parentSlotName, child, index)
		}

		child.parentBlock = this
		index = this.getValidIndex(index, this.children.length)
		const childBlock = reactive(new Block(child))
		this.children.splice(index, 0, childBlock)
		childBlock.selectBlock()
		return childBlock
	}

	removeChild(child: Block) {
		const index = this.getChildIndex(child)
		if (index === -1) return

		if (child.isSlotBlock()) {
			(this.getSlotContent(child.parentSlotName!) as Block[]).splice(index, 1)
		} else {
			this.children.splice(index, 1)
		}
	}

	getChildIndex(child: Block) {
		if (child.parentSlotName) {
			return (
				this.getSlotContent(child.parentSlotName) as Block[]
			).findIndex((block) => block.componentId === child.componentId)
		}
		return this.children.findIndex((block) => block.componentId === child.componentId)
	}

	getValidIndex(index: number | null | undefined, arrayLength: number): number {
		if (index === undefined || index === null) {
			return arrayLength
		}
		return clamp(index, 0, arrayLength)
	  }

	addChildAfter(child: BlockOptions, siblingBlock: Block) {
		const siblingIndex = this.getChildIndex(siblingBlock)
		return this.addChild(child, siblingIndex + 1)
	}

	hasChildren() {
		return this.children.length > 0
	}

	canHaveChildren() {
		return ![
			"Dropdown",
			"FileUploader",
			"Divider",
			"FeatherIcon",
			"Avatar",
			// input components
			"Autocomplete",
			"Checkbox",
			"DatePicker",
			"DateTimePicker",
			"DateRangePicker",
			"FormControl",
			"Input",
			"Select",
			"Switch",
			"Textarea",
			"TextEditor",
			"TextInput",
			// studio components
			"Audio",
			"ImageView",
			"TextBlock",
		].includes(this.componentName)
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
		const store = useStudioStore()
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

	isFlex() {
		return this.getStyle("display") === "flex"
	}

	isGrid() {
		return this.getStyle("display") === "grid"
	}

	getPadding() {
		const padding = this.getStyle("padding") || "0px";

		const paddingTop = this.getStyle("paddingTop");
		const paddingBottom = this.getStyle("paddingBottom");
		const paddingLeft = this.getStyle("paddingLeft");
		const paddingRight = this.getStyle("paddingRight");

		if (!paddingTop && !paddingBottom && !paddingLeft && !paddingRight) {
			return padding;
		}

		if (
			paddingTop &&
			paddingBottom &&
			paddingTop === paddingBottom &&
			paddingTop === paddingRight &&
			paddingTop === paddingLeft
		) {
			return paddingTop;
		}

		if (paddingTop && paddingLeft && paddingTop === paddingBottom && paddingLeft === paddingRight) {
			return `${paddingTop} ${paddingLeft}`;
		} else {
			return `${paddingTop || padding} ${paddingRight || padding} ${paddingBottom || padding} ${
				paddingLeft || padding
			}`;
		}
	}

	setPadding(padding: string) {
		// reset padding
		this.setStyle("padding", null);
		this.setStyle("paddingTop", null);
		this.setStyle("paddingBottom", null);
		this.setStyle("paddingLeft", null);
		this.setStyle("paddingRight", null);

		if (!padding) {
			return;
		}

		const paddingArray = padding.split(" ");

		if (paddingArray.length === 1) {
			this.setStyle("padding", paddingArray[0]);
		} else if (paddingArray.length === 2) {
			this.setStyle("paddingTop", paddingArray[0]);
			this.setStyle("paddingBottom", paddingArray[0]);
			this.setStyle("paddingLeft", paddingArray[1]);
			this.setStyle("paddingRight", paddingArray[1]);
		} else if (paddingArray.length === 3) {
			this.setStyle("paddingTop", paddingArray[0]);
			this.setStyle("paddingLeft", paddingArray[1]);
			this.setStyle("paddingRight", paddingArray[1]);
			this.setStyle("paddingBottom", paddingArray[2]);
		} else if (paddingArray.length === 4) {
			this.setStyle("paddingTop", paddingArray[0]);
			this.setStyle("paddingRight", paddingArray[1]);
			this.setStyle("paddingBottom", paddingArray[2]);
			this.setStyle("paddingLeft", paddingArray[3]);
		}
	}

	setMargin(margin: string) {
		// reset margin
		this.setStyle("margin", null);
		this.setStyle("marginTop", null);
		this.setStyle("marginBottom", null);
		this.setStyle("marginLeft", null);
		this.setStyle("marginRight", null);

		if (!margin) {
			return;
		}

		const marginArray = margin.split(" ");

		if (marginArray.length === 1) {
			this.setStyle("margin", marginArray[0]);
		} else if (marginArray.length === 2) {
			this.setStyle("marginTop", marginArray[0]);
			this.setStyle("marginBottom", marginArray[0]);
			this.setStyle("marginLeft", marginArray[1]);
			this.setStyle("marginRight", marginArray[1]);
		} else if (marginArray.length === 3) {
			this.setStyle("marginTop", marginArray[0]);
			this.setStyle("marginLeft", marginArray[1]);
			this.setStyle("marginRight", marginArray[1]);
			this.setStyle("marginBottom", marginArray[2]);
		} else if (marginArray.length === 4) {
			this.setStyle("marginTop", marginArray[0]);
			this.setStyle("marginRight", marginArray[1]);
			this.setStyle("marginBottom", marginArray[2]);
			this.setStyle("marginLeft", marginArray[3]);
		}
	}

	getMargin() {
		const margin = this.getStyle("margin") || "0px";

		const marginTop = this.getStyle("marginTop");
		const marginBottom = this.getStyle("marginBottom");
		const marginLeft = this.getStyle("marginLeft");
		const marginRight = this.getStyle("marginRight");

		if (!marginTop && !marginBottom && !marginLeft && !marginRight) {
			return margin;
		}

		if (
			marginTop &&
			marginBottom &&
			marginTop === marginBottom &&
			marginTop === marginRight &&
			marginTop === marginLeft
		) {
			return marginTop;
		}

		if (marginTop && marginLeft && marginTop === marginBottom && marginLeft === marginRight) {
			return `${marginTop} ${marginLeft}`;
		} else {
			return `${marginTop || margin} ${marginRight || margin} ${marginBottom || margin} ${
				marginLeft || margin
			}`;
		}
	}

	// context menu
	duplicateBlock() {
		if (this.isRoot()) return

		const store = useStudioStore()
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
			child = parentBlock.addChildAfter(blockCopy, this) as Block;
		} else {
			child = store.canvas?.getRootBlock().addChild(blockCopy) as Block;
		}
		nextTick(() => {
			if (child) {
				store.selectBlock(child, null);
			}
		});
	}

	selectBlock() {
		const store = useStudioStore();
		nextTick(() => {
			store.selectBlock(this, null);
		});
	}

	// component props
	setProp(propName: string, value: any) {
		this.componentProps[propName] = value
	}

	// component slots
	initializeSlots() {
		Object.entries(this.componentSlots).forEach(([slotName, slot]) => {
			if (!slot.slotId) {
				slot.slotId = this.generateSlotId(slotName)
			}
			slot.parentBlockId = this.componentId

			if (Array.isArray(slot.slotContent)) {
				slot.slotContent = slot.slotContent.map((block) => {
					block.parentBlock = this
					return reactive(new Block(block))
				})
			}
		})
	}

	addSlot(slotName: string) {
		this.componentSlots[slotName] = {
			slotName: slotName,
			slotId: this.generateSlotId(slotName),
			slotContent: "",
			parentBlockId: this.componentId
		}
	}

	updateSlot(slotName: string, content: string | Block | BlockOptions, index?: number | null) {
		if (typeof content === "string") {
			this.componentSlots[slotName].slotContent = content
		} else {
			if (!Array.isArray(this.componentSlots[slotName].slotContent)) {
				this.componentSlots[slotName].slotContent = []
			}

			// for top-level blocks inside a slot
			content.parentSlotName = slotName
			content.parentBlock = this
			const slotContent = this.componentSlots[slotName].slotContent as Block[]
			index = this.getValidIndex(index, slotContent.length)
			const childBlock = reactive(new Block(content))
			slotContent.splice(index, 0, childBlock)
			childBlock.selectBlock()
		}
	}

	removeSlot(slotName: string) {
		delete this.componentSlots[slotName]
	}

	getSlot(slotName: string) {
		return this.componentSlots[slotName]
	}

	getSlotContent(slotName: string) {
		return this.componentSlots[slotName]?.slotContent
	}

	hasComponentSlots() {
		return !isObjectEmpty(this.componentSlots)
	}

	generateSlotId(slotName: string) {
		return `${this.componentId}:${slotName}`
	}

	isSlotEditable(slot: SlotOptions | undefined | null) {
		if (!slot) return false

		return Boolean(
			!this.isRoot()
			&& slot.slotId
			&& typeof slot.slotContent === "string"
		)
	}

	isSlotBlock() {
		return Boolean(this.parentSlotName)
	}

	// events
	addEvent(event: ComponentEvent) {
		const pageName = event.page
		if (pageName) {
			const store = useStudioStore()
			event.page = store.getAppPageRoute(pageName)
		}
		this.componentEvents[event.event] = event
	}

	removeEvent(event: ComponentEvent) {
		delete this.componentEvents[event.event]
	}
}

export default Block
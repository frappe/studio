import { pinia } from "../support/component"

import { setActivePinia } from "pinia"
import { createRouter, createMemoryHistory } from "vue-router"
// @ts-ignore
import { resourcesPlugin } from "frappe-ui"
import { spritePlugin } from "frappe-ui/icons"

import StudioCanvas from "@/components/StudioCanvas.vue"
import Block from "@/utils/block"
import { COMPONENTS } from "@/data/components"
import { getBlockInstance, getComponentBlock } from "@/utils/serializer"
import getBlockTemplate from "@/utils/blockTemplate"
import { registerGlobalComponents } from "@/globals"
import useCanvasStore from "@/stores/canvasStore"

// drags a component from the panel onto the block rendered at `componentId`
function dragOnto(componentId: string, componentName: string, shiftKey: boolean) {
	const dataTransfer = new DataTransfer()

	return cy
		.get(`.__studio_component__[data-component-id="${componentId}"]`)
		.first()
		.then(([element]) => {
			const canvasStore = useCanvasStore()
			canvasStore.handleDragStart({ target: element, dataTransfer } as unknown as DragEvent, componentName)

			const { left, top, width, height } = element.getBoundingClientRect()
			const options = {
				dataTransfer,
				shiftKey,
				force: true,
				clientX: left + width / 2,
				clientY: top + height / 2,
			}
			cy.wrap(element).trigger("dragover", options).trigger("drop", options)
			cy.then(() => canvasStore.handleDragEnd())
		})
}

// a new block is auto-selected on nextTick and its editor overlay would swallow the drop
function clearSelection(canvas: any) {
	cy.get(".editor").should("exist")
	cy.then(() => canvas.clearSelection())
	cy.get(".editor").should("not.exist")
}

describe("dropping a component on top of another block", () => {
	// exposed StudioCanvas instance (defineExpose) used as canvasStore.activeCanvas
	let canvas: any

	beforeEach(() => {
		// block prop/slot init reads Block.components (done in main.ts in the real app)
		Block.setComponents(COMPONENTS)

		setActivePinia(pinia)
		const router = createRouter({
			history: createMemoryHistory(),
			routes: [{ path: "/", component: { template: "<div />" } }],
		})

		const rootBlock = getBlockInstance(getBlockTemplate("body"))

		cy.viewport(1440, 900)
		cy.mount(StudioCanvas as any, {
			props: { componentTree: rootBlock },
			global: {
				plugins: [pinia, router, resourcesPlugin, spritePlugin, { install: registerGlobalComponents }],
			},
		}).then(({ wrapper }) => {
			canvas = wrapper.vm
			useCanvasStore().activeCanvas = canvas
		})

		cy.then(() => {
			canvas.canvasProps.scale = 1
			canvas.canvasProps.translateX = 0
			canvas.canvasProps.translateY = 0
		})
	})

	it("replaces the hovered block in place with shift", () => {
		let button: Block, badge: Block

		cy.then(() => {
			button = canvas.rootComponent.addChild(getComponentBlock("Button"))
			badge = canvas.rootComponent.addChild(getComponentBlock("Badge"))
		})

		clearSelection(canvas)

		cy.then(() => dragOnto(button.componentId, "Avatar", true))

		cy.then(() => {
			const children = canvas.rootComponent.children
			expect(children.map((child: Block) => child.componentName)).to.deep.equal(["Avatar", "Badge"])
			expect(canvas.rootComponent.getChildById(button.componentId)).to.be.null
			expect(children[1].componentId).to.equal(badge.componentId)
		})
	})

	it("drops into the hovered block without shift", () => {
		let container: Block

		cy.then(() => {
			container = canvas.rootComponent.addChild(getBlockInstance(getBlockTemplate("empty-component")))
		})

		clearSelection(canvas)

		cy.then(() => dragOnto(container.componentId, "Avatar", false))

		cy.then(() => {
			expect(canvas.rootComponent.children).to.have.length(1)
			expect(container.children.map((child: Block) => child.componentName)).to.deep.equal(["Avatar"])
		})
	})
})

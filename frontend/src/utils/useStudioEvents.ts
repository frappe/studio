import useStudioStore from "@/stores/studioStore"
import { useEventListener } from "@vueuse/core"
import blockController from "@/utils/blockController"
import { isCtrlOrCmd, isTargetEditable } from "@/utils/helpers"

const store = useStudioStore()

export function useStudioEvents() {
	useEventListener(document, "contextmenu", async (e) => {
		const target =
			<HTMLElement | null>(e.target as HTMLElement)?.closest("[data-component-layer-id]") ||
			(e.target as HTMLElement)?.closest("[data-component-id]")
		if (target) {
			const blockId = target.dataset.componentLayerId || target.dataset.componentId
			const block = store.activeCanvas?.findBlock(blockId as string)
			if (block) {
				store.selectBlock(block, e)

				const slotName = target.dataset.slotName
				if (slotName) {
					const slot = block.getSlot(slotName)
					if (slot) {
						store.selectSlot(slot)
					}
				}

				store.componentContextMenu?.showContextMenu(e, block)
			}
		}
	});

	useEventListener(document, "keydown", (e) => {
		if (isTargetEditable(e)) return

		// delete
		if ((e.key === "Backspace" || e.key === "Delete") && blockController.isAnyBlockSelected()) {
			for (const block of blockController.getSelectedBlocks()) {
				store.activeCanvas?.removeBlock(block, e.shiftKey)
			}
			clearSelection()
			e.stopPropagation()
			return
		}

		// duplicate
		if (e.key === "d" && isCtrlOrCmd(e)) {
			if (blockController.isAnyBlockSelected() && !blockController.multipleBlocksSelected()) {
				e.preventDefault();
				const block = blockController.getSelectedBlocks()[0];
				block.duplicateBlock();
			}
			return;
		}

		// undo
		if (e.key === "z" && isCtrlOrCmd(e) && !e.shiftKey && store.activeCanvas?.history?.canUndo()) {
			store.activeCanvas?.history.undo()
			e.preventDefault()
			return;
		}

		// redo
		if (e.key === "z" && e.shiftKey && isCtrlOrCmd(e) && store.activeCanvas?.history?.canRedo) {
			store.activeCanvas?.history.redo();
			e.preventDefault();
			return;
		}
	})

}

const clearSelection = () => {
	blockController.clearSelection();
	if (document.activeElement instanceof HTMLElement) {
		document.activeElement.blur();
	}
};
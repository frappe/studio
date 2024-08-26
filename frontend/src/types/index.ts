type StyleValue = string | number | null | undefined

interface BlockStyleMap {
	[key: string]: StyleValue
}

interface BlockOptions {
	componentId: string
	componentName: string
	children: BlockOptions[]
	baseStyles: BlockStyleMap
}

interface Breakpoint {
	icon: string;
	device: string;
	displayName: string;
	width: number;
	visible: boolean;
}

interface CanvasProps {
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
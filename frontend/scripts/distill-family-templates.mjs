// Distill the editor's canonical family compositions (familyTemplates.ts —
// what dropping List / SettingsDialog / Sidebar onto the canvas inserts) into
// studio/ai/family_templates.json, in the AI's compact block schema, so
// describe_component and the prompts teach the SAME structure the editor
// builds. Run via `yarn sync-family-templates` — chained into
// upgrade-frappeui-submodule so the scaffolds refresh with the library.

import { readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

const esbuild = await import(join(repo, "frontend", "node_modules", "esbuild", "lib", "main.js"))
const templatesSource = readFileSync(
	join(repo, "frontend", "src", "utils", "blockTemplate", "familyTemplates.ts"),
	"utf-8",
)
// Type-only imports erase; nothing else in the module reaches outside the file.
const js = esbuild.transformSync(templatesSource.replace(/^import type .*$/gm, ""), {
	loader: "ts",
	format: "esm",
}).code
const module_ = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"))

const compact = (block) => {
	const out = {}
	if (block.componentName) out.name = block.componentName
	if (block.originalElement) out.originalElement = block.originalElement
	if (block.blockName) out.label = block.blockName
	if (block.componentProps && Object.keys(block.componentProps).length) out.props = block.componentProps
	if (block.baseStyles && Object.keys(block.baseStyles).length) out.style = block.baseStyles
	if (block.classes?.length) out.classes = block.classes
	if (block.children?.length) out.c = block.children.map(compact)
	if (block.componentSlots) {
		const slots = {}
		for (const [slotName, slot] of Object.entries(block.componentSlots)) {
			slots[slotName] = (slot.slotContent ?? []).map(compact)
		}
		if (Object.keys(slots).length) out.slots = slots
	}
	return out
}

const scaffolds = {}
for (const [family, template] of Object.entries(module_.familyTemplates)) {
	scaffolds[family] = compact(template())
}
const scaffoldFile = join(repo, "studio", "ai", "family_templates.json")
writeFileSync(scaffoldFile, JSON.stringify(scaffolds, null, "\t") + "\n")
console.log(`family_templates.json: ${Object.keys(scaffolds).join(", ")}`)

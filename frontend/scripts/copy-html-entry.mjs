import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { EDITOR_RUNTIME_ENTRIES } from "../vite/editorRuntime.js"

const frontendRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const builtHtml = path.resolve(frontendRoot, "../studio/public/frontend/index.html")
const templateHtml = path.resolve(frontendRoot, "../studio/www/studio.html")
const runtimeEntries = path.resolve(frontendRoot, "../studio/public/frontend/editor-runtime.json")
const marker = "<!-- studio-editor-import-map -->"
const importMap = '<script type="importmap">{{ studio_editor_import_map | safe }}</script>'

const html = fs.readFileSync(builtHtml, "utf8")
if (!html.includes(marker)) throw new Error(`Missing ${marker} in built Studio HTML`)
fs.writeFileSync(templateHtml, html.replace(marker, importMap))
fs.writeFileSync(runtimeEntries, JSON.stringify(EDITOR_RUNTIME_ENTRIES, null, "\t") + "\n")

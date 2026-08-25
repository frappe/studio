import fs from "fs"
import path from "path"
import { CompletedConfig, createFormatter, createParser, createProgram, SchemaGenerator } from "ts-json-schema-generator"
import { SVGElementParser, VueComponentParser, RouteLocationParser, HTMLElementParser, FunctionTypeParser, SlotsParser, ThisTypeParser } from "./customParser.js"

interface TypeFile {
	filePath: string
	componentName: string
	// whether the source also exports `<componentName>Slots` / `<componentName>Emits`
	hasSlots?: boolean
	hasEmits?: boolean
}

// `expected`: components found in source (so their JSON is current and should be
// kept even if generation fails this run). `written`: components whose schema was
// (re)generated successfully. The caller uses these to prune only JSONs whose
// component no longer exists — never one that merely failed to generate.
interface ExtractResult {
	expected: string[]
	written: string[]
}

function tsToJSON(
	srcFolder: string,
	destFolder: string,
	skipFolders: string[] | null = null,
	tsconfig = "",
	folderScan = false,
	perComponent = false,
	skipComponents: string[] | null = null,
): ExtractResult {
	// Get project root (where package.json is)
	const root = process.cwd()
	const inputDirPath = path.resolve(root, srcFolder)
	const outputDirPath = path.resolve(root, destFolder)
	const tsconfigPath = tsconfig ? path.resolve(root, tsconfig) : ""

	const typeFiles = perComponent
		? findComponentTypeFiles(inputDirPath, skipFolders, skipComponents)
		: findTypeFiles(inputDirPath, folderScan, skipFolders)

	let config = {
		skipTypeCheck: true,
		expose: "none", // only include explicitly requested types
		topRef: true, // add top-level $ref
		// carry JSDoc through: prop descriptions + @default land in the schemas, so the
		// props panel and the AI read the same words the component author wrote
		jsDoc: "extended",
		additionalProperties: false,
	} as CompletedConfig

	if (tsconfigPath) {
		config["tsconfig"] = tsconfig ? path.resolve(root, tsconfig) : ""
	}

	const written: string[] = []
	for (const { filePath, componentName, hasSlots, hasEmits } of typeFiles) {
		config["path"] = filePath

		if (generateComponentSchema(config, componentName, Boolean(hasSlots), Boolean(hasEmits), outputDirPath)) {
			written.push(componentName)
			continue
		}
		if (perComponent) continue

		// Barrel type files with no `<Component>Props` (e.g. Charts) fall back to
		// exporting every type they declare.
		console.warn(`Failed to generate schema for ${componentName}Props, trying wildcard type`)
		try {
			try {
				generateSchema({ ...config, type: "*" } as CompletedConfig, componentName, outputDirPath)
			} catch {
				generateSchema({ ...config, type: "*", jsDoc: "basic" } as CompletedConfig, componentName, outputDirPath)
			}
			console.log(`Generated types for ${componentName} saved to ${componentName}.json`)
			written.push(componentName)
		} catch (error) {
			console.error(`Failed to generate schema for ${componentName}:`, error)
		}
	}

	return { expected: typeFiles.map((t) => t.componentName), written }
}

function findTypeFiles(dir: string, folderScan: boolean, skipFolders: string[] | null = null): TypeFile[] {
	const typeFiles: TypeFile[] = []

	if (folderScan) {
		// component-per-folder structure: types.ts files in subdirectories of components
		function scanDirectory(currentDir: string) {
			const items = fs.readdirSync(currentDir, { withFileTypes: true })
			for (const item of items) {
				const fullPath = path.join(currentDir, item.name)
				if (item.isDirectory()) {
					if (skipFolders && skipFolders.includes(item.name)) {
						continue
					}
					scanDirectory(fullPath)
				} else if (item.isFile() && item.name === "types.ts" && currentDir !== dir) {
					// skip a shared `types.ts` sitting directly in the components root
					// (it is not a component, e.g. @framework/ui's cross-component types)
					const componentName = path.basename(path.dirname(fullPath))
					typeFiles.push(typeFileEntry(fullPath, componentName))
				}
			}
		}

		scanDirectory(dir)
	} else {
		// studio structure: individual .ts files in types folder
		const files = fs.readdirSync(dir).filter((file) => file.endsWith(".ts"))
		for (const file of files) {
			const filePath = path.join(dir, file)
			const componentName = path.basename(file, ".ts")
			typeFiles.push(typeFileEntry(filePath, componentName))
		}
	}

	return typeFiles
}

function typeFileEntry(filePath: string, componentName: string): TypeFile {
	const source = fs.readFileSync(filePath, "utf-8")
	return {
		filePath,
		componentName,
		hasSlots: exportsType(source, `${componentName}Slots`),
		hasEmits: exportsType(source, `${componentName}Emits`),
	}
}

// perComponent (@framework/ui): a folder can host several components (Notifications,
// ActivityTimeline, FileUpload, …), so drive extraction off the `.vue` files. A
// component is extracted when a `types.ts` exports `<Component>Props`; `<Component>Slots`
// is picked up too when present. The type usually lives in a sibling `types.ts`, but
// grouped widgets (e.g. Composer's EmailComposer/CommentComposer subfolders) declare
// theirs in an ancestor barrel `types.ts` — that declaring file is the schema-generation
// entry (`filePath`). `skipComponents` excludes private cores that aren't studio blocks.
function findComponentTypeFiles(
	dir: string,
	skipFolders: string[] | null = null,
	skipComponents: string[] | null = null,
): TypeFile[] {
	const typeFiles: TypeFile[] = []

	function scanDirectory(currentDir: string) {
		const items = fs.readdirSync(currentDir, { withFileTypes: true })
		const vueFiles = items
			.filter((i) => i.isFile() && i.name.endsWith(".vue") && !i.name.endsWith(".story.vue"))
			.map((i) => path.basename(i.name, ".vue"))

		for (const componentName of vueFiles) {
			if (skipComponents && skipComponents.includes(componentName)) continue
			const typesFile = findComponentTypesFile(currentDir, componentName, dir)
			if (!typesFile) continue
			typeFiles.push({
				filePath: typesFile.path,
				componentName,
				hasSlots: exportsType(typesFile.source, `${componentName}Slots`),
				hasEmits: exportsType(typesFile.source, `${componentName}Emits`),
			})
		}

		for (const item of items) {
			if (item.isDirectory() && !(skipFolders && skipFolders.includes(item.name))) {
				scanDirectory(path.join(currentDir, item.name))
			}
		}
	}

	scanDirectory(dir)
	return typeFiles
}

// The `types.ts` that declares this component's `<Component>Props` — its own folder or
// the nearest ancestor up to `rootDir`. Returned with its source (so the caller can reuse
// it for the `Slots` check), or null when no such file declares it.
function findComponentTypesFile(
	startDir: string,
	componentName: string,
	rootDir: string,
): { path: string; source: string } | null {
	let currentDir = startDir
	while (true) {
		const typesPath = path.join(currentDir, "types.ts")
		if (fs.existsSync(typesPath)) {
			const source = fs.readFileSync(typesPath, "utf-8")
			if (exportsType(source, `${componentName}Props`)) return { path: typesPath, source }
		}
		if (currentDir === rootDir) return null
		const parent = path.dirname(currentDir)
		if (parent === currentDir) return null
		currentDir = parent
	}
}

function exportsType(source: string, typeName: string): boolean {
	return new RegExp(`export\\s+(?:interface|type)\\s+${typeName}\\b`).test(source)
}

function generateSchema(config: CompletedConfig, componentName: string, outputDirPath: string) {
	const schema = buildSchema(config)
	writeSchema(schema, componentName, outputDirPath)
}

// Emit one `<Component>.json` holding `<Component>Props` and (when present)
// `<Component>Slots` / `<Component>Emits` under `definitions`, so the consumer
// can read any of them.
function generateComponentSchema(
	config: CompletedConfig,
	componentName: string,
	hasSlots: boolean,
	hasEmits: boolean,
	outputDirPath: string,
): boolean {
	const definitions: Record<string, any> = {}
	try {
		Object.assign(definitions, buildDefinitions(config, `${componentName}Props`))
	} catch (error) {
		console.error(`Failed to generate Props schema for ${componentName}: ${errorMessage(error)}`)
		return false
	}

	for (const [flag, kind] of [
		[hasSlots, "Slots"],
		[hasEmits, "Emits"],
	] as const) {
		if (!flag) continue
		try {
			Object.assign(definitions, buildDefinitions(config, `${componentName}${kind}`))
		} catch (error) {
			// e.g. a generic `<Component>Slots<T>` can't be resolved by bare name — the
			// component keeps its Props schema and loses only this section.
			console.warn(`Skipped ${kind} schema for ${componentName}: ${errorMessage(error)}`)
		}
	}

	writeSchema({ $schema: "http://json-schema.org/draft-07/schema#", definitions }, componentName, outputDirPath)
	console.log(`Generated types for ${componentName} saved to ${componentName}.json`)
	return true
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

// Some upstream JSDoc breaks the "extended" annotations parser (it evaluates tag
// bodies as TS expressions — inline casts or `this` types throw). Those types
// fall back to "basic": descriptions survive, only tag extras (@default) are lost.
function buildDefinitions(config: CompletedConfig, typeName: string): Record<string, any> {
	try {
		return buildSchema({ ...config, type: typeName }).definitions ?? {}
	} catch (error) {
		const basic = { ...config, type: typeName, jsDoc: "basic" } as CompletedConfig
		const definitions = buildSchema(basic).definitions ?? {}
		console.warn(`${typeName}: extended JSDoc failed (${errorMessage(error)}) — kept descriptions only`)
		return definitions
	}
}

function buildSchema(config: CompletedConfig) {
	const program = createProgram(config)
	const parser = createParser(program, config, (prs) => {
		prs.addNodeParser(new SVGElementParser())
		prs.addNodeParser(new VueComponentParser())
		prs.addNodeParser(new RouteLocationParser())
		prs.addNodeParser(new HTMLElementParser())
		prs.addNodeParser(new FunctionTypeParser())
		prs.addNodeParser(new SlotsParser())
		prs.addNodeParser(new ThisTypeParser())
	})
	const formatter = createFormatter(config)
	const generator = new SchemaGenerator(program, parser, formatter, config)
	return generator.createSchema(config.type)
}

function writeSchema(schema: unknown, componentName: string, outputDirPath: string) {
	if (!fs.existsSync(outputDirPath)) {
		fs.mkdirSync(outputDirPath, { recursive: true })
	}
	const outputFilePath = path.resolve(outputDirPath, `${componentName}.json`)
	fs.writeFileSync(outputFilePath, JSON.stringify(schema, null, 2))
}

export default tsToJSON

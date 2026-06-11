#!/usr/bin/env node
"use strict"

const path = require("path")
const fs = require("fs")
const { parseRouter } = require("./phases/router-parser")
const { buildComponentMap, classify } = require("./phases/classifier")
const { parseVueFile } = require("./phases/template-walker")
const { analyzeScript } = require("./phases/script-analyzer")

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1]
      i++
    }
  }
  return args
}

async function main() {
  const { "app-name": appName, "app-path": appSrcPath } = parseArgs(process.argv.slice(2))

  if (!appName || !appSrcPath) {
    process.stderr.write("Usage: node index.js --app-name <name> --app-path <src-path>\n")
    process.exit(1)
  }

  if (!fs.existsSync(appSrcPath)) {
    process.stderr.write(`App src path not found: ${appSrcPath}\n`)
    process.exit(1)
  }

  const warnings = []
  const componentMap = buildComponentMap(appSrcPath)
  const processedComponents = new Map() // component_id → component record

  const routes = parseRouter(appSrcPath)
  const pages = []

  for (const route of routes) {
    if (shouldSkipPage(route.name)) continue

    const blockTree = parsePage(route.filePath, componentMap, processedComponents, warnings, appSrcPath)
    const scriptData = safeAnalyze(route.filePath)

    pages.push({
      page_name: route.pageName,
      page_title: route.pageTitle,
      route: route.routePath,
      source_file: relative(appSrcPath, route.filePath),
      draft_blocks: blockTree ? [blockTree] : [],
      resources: scriptData.resources,
      variables: scriptData.variables,
      watchers: scriptData.watchers,
    })
  }

  const manifest = {
    app: appName,
    app_title: toTitle(appName),
    base_route: `/${appName}`,
    pages,
    components: Array.from(processedComponents.values()),
    warnings,
  }

  process.stdout.write(JSON.stringify(manifest))
}

function parsePage(filePath, componentMap, processedComponents, warnings, appSrcPath) {
  try {
    return parseVueFile(filePath, componentMap, warnings, (tag, filePath) => {
      ensureComponent(tag, filePath, componentMap, processedComponents, warnings, appSrcPath)
    })
  } catch (err) {
    warnings.push(`Failed to parse ${relative(appSrcPath, filePath)}: ${err.message}`)
    return null
  }
}

function ensureComponent(tag, filePath, componentMap, processedComponents, warnings, appSrcPath) {
  const componentId = toComponentId(tag)
  if (processedComponents.has(componentId)) return

  // Reserve the slot before recursing to break cycles
  processedComponents.set(componentId, null)

  const scriptData = safeAnalyze(filePath)
  // Build localName → studioInputName map for prop rewriting.
  // defineProps props: localName === studioInputName.
  // defineModel vars: localName (e.g. "viewControls") → model_prop (e.g. "modelValue").
  const propNames = new Map()
  for (const p of scriptData.props || []) {
    if (!p.input_name) continue
    propNames.set(p.input_name, p.model_prop || p.input_name)
  }
  let block = null

  try {
    block = parseVueFile(filePath, componentMap, warnings, (childTag, childPath) => {
      ensureComponent(childTag, childPath, componentMap, processedComponents, warnings, appSrcPath)
    }, { isComponentContext: true, propNames })
  } catch (err) {
    warnings.push(`Failed to parse component ${tag}: ${err.message}`)
  }

  processedComponents.set(componentId, {
    component_id: componentId,
    component_name: tag,
    source_file: relative(appSrcPath, filePath),
    block: block || {},
    inputs: scriptData.props,
  })
}

function safeAnalyze(filePath) {
  try {
    return analyzeScript(filePath)
  } catch (_) {
    return { resources: [], variables: [], watchers: [], props: [] }
  }
}

function shouldSkipPage(name) {
  const skip = new Set(["InvalidPage", "NotPermitted", "NotFound", "Error"])
  return skip.has(name)
}

function toComponentId(name) {
  return name.replace(/([A-Z])/g, "-$1").toLowerCase().replace(/^-/, "")
}

function toTitle(str) {
  return str.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

function relative(base, full) {
  return path.relative(base, full)
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n${err.stack}\n`)
  process.exit(1)
})

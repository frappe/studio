"use strict"

const babelParser = require("@babel/parser")
const traverse = require("@babel/traverse").default
const { parse: parseSFC } = require("@vue/compiler-sfc")
const { resolveInputType } = require("../mappings/prop-types")
const fs = require("fs")

const RESOURCE_CREATORS = new Set(["createResource", "createListResource", "createDocumentResource"])

/**
 * Analyse a .vue file's <script setup> block.
 * Returns { resources, variables, watchers, props }.
 */
function analyzeScript(filePath) {
  const source = fs.readFileSync(filePath, "utf8")
  const { descriptor } = parseSFC(source, { filename: filePath })

  const scriptBlock = descriptor.scriptSetup || descriptor.script
  if (!scriptBlock) {
    return { resources: [], variables: [], watchers: [], props: [] }
  }

  const ast = babelParser.parse(scriptBlock.content, {
    sourceType: "module",
    plugins: ["typescript", "jsx", "decorators-legacy"],
    errorRecovery: true,
  })

  const resources = []
  const variables = []
  const watchers = []
  const props = []

  traverse(ast, {
    CallExpression(nodePath) {
      const name = getCalleeName(nodePath.node)

      if (RESOURCE_CREATORS.has(name)) {
        const resource = extractResource(name, nodePath)
        if (resource) resources.push(resource)
        return
      }

      if (name === "ref" || name === "shallowRef") {
        const variable = extractVariable(nodePath)
        if (variable) variables.push(variable)
        return
      }

      if (name === "reactive") {
        const variable = extractVariable(nodePath, "Object")
        if (variable) variables.push(variable)
        return
      }

      if (name === "watch" || name === "watchEffect") {
        const watcher = extractWatcher(nodePath)
        if (watcher) watchers.push(watcher)
        return
      }

      if (name === "defineProps") {
        props.push(...extractProps(nodePath))
      }

      // defineModel() creates a prop alias (modelValue by default) referenced by a local var name
      if (name === "defineModel") {
        const model = extractModel(nodePath)
        if (model) props.push(model)
      }
    },
  })

  return { resources, variables, watchers, props }
}

function getCalleeName(node) {
  if (node.callee.type === "Identifier") return node.callee.name
  if (node.callee.type === "MemberExpression") return node.callee.property.name
  return null
}

function extractResource(creatorName, nodePath) {
  const args = nodePath.node.arguments
  const optionsNode = args && args[0]
  if (!optionsNode || optionsNode.type !== "ObjectExpression") return null

  const opts = objectToPlain(optionsNode)
  const varName = getDeclaratorName(nodePath)

  if (creatorName === "createListResource") {
    return {
      resource_name: varName || opts.doctype || "list",
      resource_type: "Document List",
      document_type: opts.doctype || "",
      fields: opts.fields || null,
      filters: opts.filters || null,
      auto: 1,
    }
  }

  if (creatorName === "createDocumentResource") {
    return {
      resource_name: varName || opts.doctype || "doc",
      resource_type: "Document",
      document_type: opts.doctype || "",
      document_name: opts.name || "",
      auto: 1,
    }
  }

  // createResource → API Resource
  return {
    resource_name: varName || opts.url || "resource",
    resource_type: "API Resource",
    url: opts.url || "",
    method: opts.method || "POST",
    auto: opts.auto ? 1 : 0,
  }
}

function extractVariable(nodePath, forceType = null) {
  const varName = getDeclaratorName(nodePath)
  if (!varName) return null

  const args = nodePath.node.arguments
  const initialNode = args && args[0]
  const initialValue = initialNode ? getLiteralValue(initialNode) : ""
  const variableType = forceType || inferType(initialNode)

  return {
    variable_name: varName,
    variable_type: variableType,
    initial_value: initialValue !== undefined ? String(initialValue) : "",
  }
}

function extractWatcher(nodePath) {
  const args = nodePath.node.arguments
  if (!args || args.length < 1) return null

  const source = args[0] ? getSourceString(args[0]) : ""
  const handler = args[1] ? getSourceString(args[1]) : ""
  const opts = args[2] && args[2].type === "ObjectExpression" ? objectToPlain(args[2]) : {}

  return {
    source,
    script: handler,
    immediate: opts.immediate ? 1 : 0,
    deep: opts.deep ? 1 : 0,
  }
}

function extractProps(nodePath) {
  const args = nodePath.node.arguments
  if (!args || !args[0]) return []

  // defineProps({ myProp: { type: String, default: '' } })
  if (args[0].type === "ObjectExpression") {
    return args[0].properties.map((prop) => {
      const name = prop.key ? (prop.key.name || prop.key.value) : "unknown"
      const opts = prop.value && prop.value.type === "ObjectExpression" ? objectToPlain(prop.value) : {}
      const vuePropType = opts.type || "String"
      return {
        input_name: name,
        type: resolveInputType(vuePropType),
        required: opts.required ? 1 : 0,
        default: opts.default !== undefined ? String(opts.default) : "",
      }
    })
  }

  return []
}

// defineModel('name', opts?) or defineModel(opts?) — extracts as a prop with
// input_name = local variable name and model_prop = underlying prop ('modelValue' by default).
function extractModel(nodePath) {
  const varName = getDeclaratorName(nodePath)
  if (!varName) return null

  const args = nodePath.node.arguments
  // First string arg is the model name (prop suffix): defineModel('title', opts)
  // Without it, the prop is 'modelValue'
  const firstArg = args && args[0]
  const modelProp = firstArg && firstArg.type === "StringLiteral"
    ? `modelValue:${firstArg.value}`
    : "modelValue"

  return {
    input_name: varName,
    model_prop: modelProp,
    type: "Object",
    required: 0,
    default: "",
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getDeclaratorName(nodePath) {
  const parent = nodePath.parent
  if (parent && parent.type === "VariableDeclarator" && parent.id) {
    return parent.id.name || null
  }
  return null
}

function getLiteralValue(node) {
  if (!node) return ""
  if (node.type === "StringLiteral") return node.value
  if (node.type === "NumericLiteral") return node.value
  if (node.type === "BooleanLiteral") return node.value
  if (node.type === "NullLiteral") return null
  return ""
}

function inferType(node) {
  if (!node) return "String"
  if (node.type === "StringLiteral") return "String"
  if (node.type === "NumericLiteral") return "Number"
  if (node.type === "BooleanLiteral") return "Boolean"
  if (node.type === "ObjectExpression" || node.type === "ArrayExpression") return "Object"
  return "String"
}

function objectToPlain(objectNode) {
  const result = {}
  for (const prop of objectNode.properties || []) {
    if (prop.type !== "ObjectProperty" && prop.type !== "Property") continue
    const key = prop.key ? (prop.key.name || prop.key.value) : null
    if (!key) continue
    result[key] = getLiteralValue(prop.value)
  }
  return result
}

function getSourceString(node) {
  if (!node) return ""
  if (node.type === "Identifier") return node.name
  if (node.type === "MemberExpression") {
    return `${getSourceString(node.object)}.${getSourceString(node.property)}`
  }
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
    return "/* function */"
  }
  return getLiteralValue(node) !== "" ? String(getLiteralValue(node)) : ""
}

module.exports = { analyzeScript }

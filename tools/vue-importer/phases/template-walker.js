"use strict"

const { parse: parseSFC } = require("@vue/compiler-sfc")
const { parse: parseTemplate, NodeTypes, ElementTypes } = require("@vue/compiler-dom")
const { classify } = require("./classifier")
const fs = require("fs")

let _idCounter = 0
function generateId() {
  return `imp-${(++_idCounter).toString(36)}`
}

/**
 * Parse a .vue file and return a Studio block tree.
 * onCustomComponent(tag, filePath) is called whenever a custom component is encountered.
 * isComponentContext: true when parsing a component definition (not a page) — suppresses
 *   component-local v-if conditions and rewrites prop references to inputs.propName,
 *   matching Studio's evaluation context for custom components.
 * propNames: Set of prop names from defineProps (only used when isComponentContext is true).
 * Returns null if the file has no template.
 */
function parseVueFile(filePath, componentMap, warnings, onCustomComponent, { isComponentContext = false, propNames = new Map() } = {}) {
  const source = fs.readFileSync(filePath, "utf8")
  const { descriptor } = parseSFC(source, { filename: filePath })
  if (!descriptor.template) return null

  // @vue/compiler-dom parse() returns the RootNode directly, not { ast }
  const ast = parseTemplate(descriptor.template.content, {
    parseMode: "html",
    errorRecovery: true,
  })

  const ctx = { componentMap, warnings, onCustomComponent, isComponentContext, propNames }
  const children = walkChildren(ast.children, ctx)
  return buildRootBlock(children)
}

// HTML tags that Studio treats as containers (can have children)
const CONTAINER_ELEMENTS = new Set([
  "div", "section", "article", "main", "footer", "nav", "span",
  "form", "ul", "ol", "li", "figure", "aside", "details",
])
const HEADER_ELEMENTS = new Set(["header", "thead", "th"])

function getOriginalElement(tag) {
  if (CONTAINER_ELEMENTS.has(tag)) return "div"
  if (HEADER_ELEMENTS.has(tag)) return "header"
  return undefined
}

function buildRootBlock(children) {
  return {
    // "root" is Studio's sentinel value for isRoot() — required for canHaveChildren()
    componentId: "root",
    componentName: "Container",
    originalElement: "div",
    componentProps: {},
    componentEvents: {},
    componentSlots: {},
    attributes: {},
    children,
    classes: [],
    baseStyles: {},
    rawStyles: {},
    mobileStyles: {},
    tabletStyles: {},
  }
}

function walkChildren(nodes, ctx) {
  const blocks = []
  for (const node of nodes || []) {
    const block = walkNode(node, ctx)
    if (block) blocks.push(block)
  }
  return blocks
}

function walkNode(node, ctx) {
  // Text nodes → TextBlock with static text
  if (node.type === NodeTypes.TEXT) {
    const content = (node.content || "").trim()
    return content ? makeTextBlock(content) : null
  }

  // Interpolation nodes → TextBlock with dynamic expression
  if (node.type === NodeTypes.INTERPOLATION) {
    const expr = rewriteForComponent(getExpressionString(node.content), ctx)
    return expr ? makeTextBlock(`{{ ${expr} }}`) : null
  }

  if (node.type === NodeTypes.IF) return walkIfNode(node, ctx)
  if (node.type === NodeTypes.FOR) return walkForNode(node, ctx)
  if (node.type !== NodeTypes.ELEMENT) return null

  // <template> with v-slot — recurse into it directly
  if (node.tag === "template" && node.tagType === ElementTypes.TEMPLATE) {
    const children = walkChildren(node.children, ctx)
    return children.length === 1 ? children[0] : null
  }

  // <Teleport> — transparent in Studio: render children inline
  if (node.tag === "Teleport" || node.tag === "teleport") {
    const children = walkChildren(node.children, ctx)
    if (children.length === 0) return null
    if (children.length === 1) return children[0]
    return makeContainer(children)
  }

  // <slot> — render fallback children (shown when no slot content is provided)
  if (node.tagType === ElementTypes.SLOT) {
    if (!node.children?.length) return null
    const children = walkChildren(node.children, ctx)
    if (children.length === 0) return null
    if (children.length === 1) return children[0]
    return makeContainer(children)
  }

  return buildBlock(node, ctx)
}

function walkIfNode(ifNode, ctx) {
  const branch = ifNode.branches && ifNode.branches[0]
  if (!branch) return null

  const condition = branch.condition ? getExpressionString(branch.condition) : null
  const children = walkChildren(branch.children, ctx)
  const block = children[0] || null

  // In component context, v-if conditions reference component-local reactive state
  // (e.g. showHeader, isMobileView) that don't exist as Studio page variables.
  // Setting them as visibilityCondition would always hide the block in the editor.
  if (block && condition && !ctx.isComponentContext) {
    block.visibilityCondition = condition
  }
  return block
}

function makeContainer(children) {
  return {
    componentId: generateId(),
    componentName: "Container",
    originalElement: "div",
    componentProps: {},
    componentEvents: {},
    componentSlots: {},
    attributes: {},
    children,
    classes: [],
    baseStyles: {},
    rawStyles: {},
    mobileStyles: {},
    tabletStyles: {},
  }
}

function makeTextBlock(text) {
  return {
    componentId: generateId(),
    componentName: "TextBlock",
    componentProps: { text },
    componentEvents: {},
    componentSlots: {},
    attributes: {},
    children: [],
    classes: [],
    baseStyles: {},
    rawStyles: {},
    mobileStyles: {},
    tabletStyles: {},
  }
}

function walkForNode(forNode, ctx) {
  const source = forNode.source ? getExpressionString(forNode.source) : ""
  const children = walkChildren(forNode.children, ctx)
  return {
    componentId: generateId(),
    componentName: "Repeater",
    componentProps: { dataSource: source },
    componentEvents: {},
    componentSlots: {},
    attributes: {},
    children,
    classes: [],
    baseStyles: {},
    rawStyles: {},
    mobileStyles: {},
    tabletStyles: {},
  }
}

function buildBlock(node, ctx) {
  const { componentMap, warnings, onCustomComponent } = ctx
  const classification = classify(node.tag, componentMap)

  if (classification.type === "skip") return null

  if (classification.type === "custom" && onCustomComponent && classification.filePath) {
    onCustomComponent(node.tag, classification.filePath)
  }

  const isTextBlock = classification.studioName === "TextBlock"
  const componentProps = extractProps(node, ctx)

  if (isTextBlock) {
    // Populate text and tag props; text nodes are handled by walkNode so skip children.
    const text = extractTextContent(node, ctx)
    if (text) componentProps.text = text
    componentProps.tag = node.tag
  }

  const block = {
    componentId: generateId(),
    componentName: classification.studioName,
    originalElement: classification.type === "standard" ? getOriginalElement(node.tag) : undefined,
    componentProps,
    componentEvents: extractEvents(node),
    componentSlots: extractNamedSlots(node, ctx),
    attributes: extractHtmlAttributes(node),
    // TextBlock text is in props; walking children would create duplicate TextBlocks
    children: isTextBlock ? [] : walkChildren(node.children, ctx),
    classes: extractClasses(node),
    visibilityCondition: ctx.isComponentContext ? undefined : extractVisibility(node),
    baseStyles: extractInlineStyles(node),
    rawStyles: {},
    mobileStyles: {},
    tabletStyles: {},
    isStudioComponent: classification.type === "custom",
  }

  return block
}

// Extract all text/interpolation content from an element's children into a Studio string.
// Returns null if there is no text content.
function extractTextContent(node, ctx) {
  const parts = []
  for (const child of node.children || []) {
    if (child.type === NodeTypes.TEXT) {
      const t = child.content.trim()
      if (t) parts.push(t)
    } else if (child.type === NodeTypes.INTERPOLATION) {
      const expr = rewriteForComponent(getExpressionString(child.content), ctx)
      if (expr) parts.push(`{{ ${expr} }}`)
    } else if (child.type === NodeTypes.COMPOUND_EXPRESSION) {
      for (const piece of child.children || []) {
        if (typeof piece === "string") {
          const t = piece.trim()
          if (t && t !== "+") parts.push(t)
        } else if (piece && piece.type === NodeTypes.INTERPOLATION) {
          const expr = rewriteForComponent(getExpressionString(piece.content), ctx)
          if (expr) parts.push(`{{ ${expr} }}`)
        } else if (piece && piece.type === NodeTypes.SIMPLE_EXPRESSION) {
          parts.push(`{{ ${rewriteForComponent(piece.content, ctx)} }}`)
        }
      }
    }
  }
  return parts.length ? parts.join(" ").trim() : null
}

// ─── Prop / event extraction ───────────────────────────────────────────────

function extractProps(node, ctx) {
  const props = {}
  for (const prop of node.props || []) {
    if (prop.type === NodeTypes.ATTRIBUTE) {
      // static: label="Save"
      if (prop.name !== "class" && prop.name !== "style") {
        props[prop.name] = prop.value ? prop.value.content : true
      }
    } else if (prop.type === NodeTypes.DIRECTIVE && prop.name === "bind" && prop.arg) {
      // dynamic: :label="expr"
      const argName = getExpressionString(prop.arg)
      if (argName && argName !== "class" && argName !== "style") {
        const expr = prop.exp ? rewriteForComponent(getExpressionString(prop.exp), ctx) : null
        props[argName] = expr ? `{{ ${expr} }}` : null
      }
    } else if (prop.type === NodeTypes.DIRECTIVE && prop.name === "model") {
      // v-model
      const expr = prop.exp ? rewriteForComponent(getExpressionString(prop.exp), ctx) : null
      props["modelValue"] = expr ? `{{ ${expr} }}` : null
    }
  }
  return props
}

function extractEvents(node) {
  const events = {}
  for (const prop of node.props || []) {
    if (prop.type === NodeTypes.DIRECTIVE && prop.name === "on" && prop.arg) {
      const eventName = getExpressionString(prop.arg)
      if (eventName) {
        events[eventName] = prop.exp ? getExpressionString(prop.exp) : ""
      }
    }
  }
  return events
}

function extractClasses(node) {
  const classes = []
  for (const prop of node.props || []) {
    // static: class="flex items-center"
    if (prop.type === NodeTypes.ATTRIBUTE && prop.name === "class") {
      classes.push(...(prop.value ? prop.value.content.split(/\s+/).filter(Boolean) : []))
    }
    // dynamic: :class="['flex', condition && 'gap-2']" or :class="{ flex: true }"
    if (prop.type === NodeTypes.DIRECTIVE && prop.name === "bind" &&
        prop.arg && getExpressionString(prop.arg) === "class" && prop.exp) {
      const expr = getExpressionString(prop.exp)
      // Extract quoted string literals — these are the static Tailwind classes
      const matches = expr.match(/'([^']+)'|"([^"]+)"/g) || []
      for (const m of matches) {
        const cls = m.slice(1, -1).trim()
        classes.push(...cls.split(/\s+/).filter(Boolean))
      }
    }
  }
  return [...new Set(classes)] // deduplicate
}

function extractInlineStyles(node) {
  for (const prop of node.props || []) {
    // static: style="display: flex; gap: 8px"
    if (prop.type === NodeTypes.ATTRIBUTE && prop.name === "style") {
      return parseCssString(prop.value ? prop.value.content : "")
    }
    // dynamic: :style="{ top: top, width: '100px' }"
    if (prop.type === NodeTypes.DIRECTIVE && prop.name === "bind" &&
        prop.arg && getExpressionString(prop.arg) === "style" && prop.exp) {
      return parseDynamicStyleExpr(getExpressionString(prop.exp))
    }
  }
  return {}
}

// Parse "display: flex; gap: 8px" into { display: "flex", gap: "8px" }
function parseCssString(styleStr) {
  const styles = {}
  if (!styleStr) return styles
  for (const decl of styleStr.split(";")) {
    const colonIdx = decl.indexOf(":")
    if (colonIdx < 0) continue
    const key = decl.slice(0, colonIdx).trim()
    const value = decl.slice(colonIdx + 1).trim()
    if (key && value) {
      // Convert kebab-case to camelCase for Vue :style compatibility
      styles[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value
    }
  }
  return styles
}

// Extract static string literal values from a :style object expression.
// Handles { top: top, width: '100%' } → { width: "100%" }
function parseDynamicStyleExpr(expr) {
  const styles = {}
  // Match  key: 'value'  or  key: "value"  pairs
  const re = /(\w+)\s*:\s*['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(expr)) !== null) {
    const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    styles[key] = m[2]
  }
  return styles
}

function extractVisibility(node) {
  for (const prop of node.props || []) {
    if (prop.type === NodeTypes.DIRECTIVE && (prop.name === "if" || prop.name === "show")) {
      return prop.exp ? getExpressionString(prop.exp) : null
    }
  }
  return null
}

function extractHtmlAttributes(node) {
  const attrs = {}
  for (const prop of node.props || []) {
    if (prop.type === NodeTypes.ATTRIBUTE && !["class", "style"].includes(prop.name)) {
      attrs[prop.name] = prop.value ? prop.value.content : true
    }
  }
  return attrs
}

function extractNamedSlots(node, ctx) {
  const slots = {}
  for (const child of node.children || []) {
    if (child.type !== NodeTypes.ELEMENT || child.tag !== "template") continue
    const slotProp = child.props && child.props.find(
      (p) => p.type === NodeTypes.DIRECTIVE && p.name === "slot"
    )
    if (!slotProp) continue
    const slotName = slotProp.arg ? getExpressionString(slotProp.arg) : "default"
    slots[slotName] = {
      slotId: generateId(),
      slotName,
      slotContent: walkChildren(child.children, ctx),
    }
  }
  return slots
}

// When parsing a component template, prop identifiers must be rewritten to inputs.propName
// because Studio's evaluation context for custom components is { inputs: { propName: value } }.
// propNames: Map<localName, studioInputName> built from defineProps + defineModel.
function rewriteForComponent(expr, ctx) {
  if (!ctx || !ctx.isComponentContext || !ctx.propNames || !ctx.propNames.size) return expr
  let result = expr
  for (const [localName, studioName] of ctx.propNames) {
    // Replace standalone identifiers only — skip already-prefixed inputs.xxx or member chains
    result = result.replace(
      new RegExp(`(?<!inputs\\.)(?<![.\\w])\\b${localName}\\b`, "g"),
      `inputs.${studioName}`
    )
  }
  return result
}

function getExpressionString(node) {
  if (!node) return ""
  if (node.type === NodeTypes.SIMPLE_EXPRESSION) return node.content
  if (node.type === NodeTypes.COMPOUND_EXPRESSION) {
    return node.children.map((c) => (typeof c === "string" ? c : getExpressionString(c))).join("")
  }
  return ""
}

module.exports = { parseVueFile }

"use strict"

const fs = require("fs")
const path = require("path")
const babelParser = require("@babel/parser")

const ROUTER_CANDIDATES = [
  path.join("router.js"),
  path.join("router", "index.js"),
  path.join("router", "index.ts"),
  path.join("router.ts"),
]

/**
 * Find and parse the router file in appSrcPath.
 * Returns an array of { name, routePath, filePath } page descriptors.
 */
function parseRouter(appSrcPath) {
  const routerFile = findRouterFile(appSrcPath)
  if (!routerFile) {
    return []
  }

  const source = fs.readFileSync(routerFile, "utf8")
  const ast = babelParser.parse(source, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
    errorRecovery: true,
  })

  return extractRoutes(ast, appSrcPath)
}

function findRouterFile(appSrcPath) {
  for (const candidate of ROUTER_CANDIDATES) {
    const full = path.join(appSrcPath, candidate)
    if (fs.existsSync(full)) {
      return full
    }
  }
  return null
}

function extractRoutes(ast, appSrcPath) {
  const routes = []

  function visit(node) {
    if (!node || typeof node !== "object") return

    if (isRouteObject(node)) {
      const route = extractRoute(node, appSrcPath)
      if (route) routes.push(route)
    }

    for (const key of Object.keys(node)) {
      if (key === "type" || key === "loc" || key === "start" || key === "end") continue
      const child = node[key]
      if (Array.isArray(child)) {
        child.forEach(visit)
      } else if (child && typeof child === "object" && child.type) {
        visit(child)
      }
    }
  }

  visit(ast.program)
  return routes
}

function isRouteObject(node) {
  if (node.type !== "ObjectExpression") return false
  const props = node.properties || []
  return props.some((p) => p.key && (p.key.name === "path" || p.key.value === "path"))
}

function extractRoute(node, appSrcPath) {
  const props = {}
  for (const prop of node.properties || []) {
    if (!prop.key) continue
    const key = prop.key.name || prop.key.value
    props[key] = prop.value
  }

  const routePath = getStringValue(props.path)
  const name = getStringValue(props.name)
  if (!routePath || !name) return null

  const filePath = resolveComponentFile(props.component, appSrcPath)
  if (!filePath) return null

  return {
    name,
    routePath,
    filePath,
    pageName: slugify(name),
    pageTitle: titleCase(name),
  }
}

function resolveComponentFile(componentNode, appSrcPath) {
  if (!componentNode) return null

  // () => import('@/pages/Foo.vue')
  if (componentNode.type === "ArrowFunctionExpression") {
    const body = componentNode.body
    if (body && body.type === "CallExpression") {
      return resolveImport(body, appSrcPath)
    }
  }

  // import('@/pages/Foo.vue')
  if (componentNode.type === "CallExpression") {
    return resolveImport(componentNode, appSrcPath)
  }

  return null
}

function resolveImport(callNode, appSrcPath) {
  const arg = callNode.arguments && callNode.arguments[0]
  if (!arg || arg.type !== "StringLiteral") return null

  const importPath = arg.value.replace(/^@\//, "")
  const full = path.join(appSrcPath, importPath)
  return fs.existsSync(full) ? full : null
}

function getStringValue(node) {
  if (!node) return null
  if (node.type === "StringLiteral") return node.value
  if (node.type === "TemplateLiteral" && node.quasis.length === 1) {
    return node.quasis[0].value.raw
  }
  return null
}

function slugify(str) {
  return str.replace(/([A-Z])/g, "-$1").toLowerCase().replace(/^-/, "").replace(/\s+/g, "-")
}

function titleCase(str) {
  return str.replace(/([A-Z])/g, " $1").trim()
}

module.exports = { parseRouter }

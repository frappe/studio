"use strict"

const fs = require("fs")
const path = require("path")
const { resolveComponentName } = require("../mappings/component-names")

// Standard component names from Studio's constants — kept in sync with studio/constants.py
const STANDARD_COMPONENT_NAMES = new Set([
  // frappe-ui
  "Alert", "Autocomplete", "Avatar", "Badge", "Button", "Breadcrumbs",
  "Checkbox", "Calendar", "Combobox", "DatePicker", "TimePicker",
  "DateTimePicker", "DateRangePicker", "MonthPicker", "Dialog", "Divider",
  "Dropdown", "ErrorMessage", "FeatherIcon", "FileUploader", "FormLabel",
  "FormControl", "ListView", "MultiSelect", "Progress", "Rating",
  "Select", "Sidebar", "Switch", "Tabs", "TabButtons", "Textarea",
  "TextInput", "TextEditor", "Tooltip", "Tree",
  "AxisChart", "NumberChart", "DonutChart",
  // frappe
  "Filter", "Link",
  // studio built-in
  "Container", "FitContainer", "Repeater", "HTML", "Header", "SplitView",
  "AvatarCard", "CardList", "Audio", "ImageView", "TextBlock",
  "AppHeader", "BottomTabs", "MarkdownEditor",
])

/**
 * Build a map of component name → source file path by scanning the app's
 * components directory. This lets the walker recurse into custom components.
 */
function buildComponentMap(appSrcPath) {
  const componentsDir = path.join(appSrcPath, "components")
  const map = new Map()

  if (!fs.existsSync(componentsDir)) {
    return map
  }

  function scan(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        scan(fullPath)
      } else if (entry.isFile() && entry.name.endsWith(".vue")) {
        const name = entry.name.slice(0, -4)
        if (!map.has(name)) {
          map.set(name, fullPath)
        }
      }
    }
  }

  scan(componentsDir)
  return map
}

/**
 * Classify a component name.
 * Returns { type: 'standard' | 'custom' | 'skip', studioName, filePath? }
 */
function classify(tag, componentMap) {
  const studioName = resolveComponentName(tag)

  if (studioName === null) {
    return { type: "skip" }
  }

  if (STANDARD_COMPONENT_NAMES.has(studioName)) {
    return { type: "standard", studioName }
  }

  // Not a standard name — look for a custom Vue file.
  // Use component_id (kebab-case) as componentName so Studio's componentStore
  // can fetch and cache the Studio Component by its Frappe document name.
  const filePath = componentMap.get(tag)
  if (filePath) {
    return { type: "custom", studioName: toComponentId(tag), filePath }
  }

  // Unknown — treat as a generic container so the block tree isn't broken
  return { type: "standard", studioName: "Container" }
}

function toComponentId(name) {
  return name.replace(/([A-Z])/g, "-$1").toLowerCase().replace(/^-/, "")
}

module.exports = { buildComponentMap, classify }

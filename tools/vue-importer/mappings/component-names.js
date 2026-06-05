"use strict"

// Maps Vue component names that differ from Studio's registry names.
// Keys are names found in Vue source; values are Studio registry names.
// A null value means skip the component (don't create a block for it).
const COMPONENT_NAME_MAP = {
  // frappe-ui aliases that apps commonly use
  Input: "TextInput",
  FormControl: "TextInput",
  ErrorMessage: null,

  // CRM wraps frappe-ui's Autocomplete — map to Combobox (Studio's name)
  // If the wrapped component is used directly, honour the standard name
  Autocomplete: "Combobox",

  // HTML layout elements → Container
  div: "Container",
  section: "Container",
  main: "Container",
  article: "Container",
  aside: "Container",
  header: "Header",
  footer: "Container",
  nav: "Container",
  ul: "Container",
  ol: "Container",
  li: "Container",
  span: "Container",
  p: "TextBlock",
  h1: "TextBlock",
  h2: "TextBlock",
  h3: "TextBlock",
  h4: "TextBlock",
  h5: "TextBlock",
  h6: "TextBlock",
  a: "TextBlock",
  img: "ImageView",
  audio: "Audio",
  form: "Container",
  label: "TextBlock",
  strong: "TextBlock",
  em: "TextBlock",
  br: null,
  hr: "Divider",
}

/**
 * Resolve the Studio component name for a Vue tag.
 * Returns null if the element should be skipped.
 * Returns the original name if no mapping exists (assumed to be a valid Studio name).
 */
function resolveComponentName(tag) {
  if (Object.prototype.hasOwnProperty.call(COMPONENT_NAME_MAP, tag)) {
    return COMPONENT_NAME_MAP[tag]
  }
  return tag
}

module.exports = { resolveComponentName }

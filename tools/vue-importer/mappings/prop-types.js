"use strict"

// Maps Vue prop constructor names to Studio Component Input types.
const VUE_PROP_TYPE_MAP = {
  String: "String",
  Number: "Number",
  Boolean: "Boolean",
  Object: "Object",
  Array: "Object",   // Studio has no Array type
  Function: "String",
  Date: "String",
  Symbol: "String",
  RegExp: "String",
}

function resolveInputType(vuePropType) {
  return VUE_PROP_TYPE_MAP[vuePropType] || "String"
}

module.exports = { resolveInputType }

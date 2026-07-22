import { app } from "../../../scripts/app.js";

/*
 * ComfyUI / LiteGraph frontend extension
 * Visual slot reorder - 1.0.0
 *
 * Stable base preserved: v1.1.4 output link synchronization.
 *
 * Current scope:
 * - outputs: stable v1.1.4 behavior preserved
 * - inputs: automatic structural mode with safeguards and local policy
 * - no global node allowlist: node sides are validated structurally
 * - separate storage in node.properties.__slot_order.output / input
 * - restore canonical order before prompt generation/serialization
 *
 * Important:
 * LiteGraph draws ports from node.outputs / node.inputs.
 * To change only the display without breaking ComfyUI execution,
 * the arrays are temporarily reordered on the UI side, then restored to
 * canonical order before execution/save.
 */

const EXT_NAME = "ComfyUI.VisualSlotReorder";
const EXT_VERSION = "1.0.0";
const DEBUG = false;
const SHOW_UNSUPPORTED_REASON = false;
const ORDER_PROP = "__slot_order";
const POLICY_PROP = "__vsr_policy";
const SLOT_HEIGHT = LiteGraph.NODE_SLOT_HEIGHT || 20;
const OUTPUT_HITBOX_LEFT_RATIO = 0.25;
const OUTPUT_HITBOX_RIGHT_PAD = 34;
const OUTPUT_HITBOX_MIN_LEFT = 6;

const ENABLE_INPUT_REORDER = true;
const INPUT_HITBOX_RIGHT_RATIO = 0.75;
const INPUT_HITBOX_LEFT_PAD = 34;
const INPUT_HITBOX_MIN_RIGHT = 120;
const KEY_SEP = "\u001f";

/*
 * Structural policy model
 *
 * No global allowlist or denylist is used.
 * Reorder support is decided per node side from the current workflow structure:
 * - at least two useful visual ports;
 * - stable name+type slot identities;
 * - no duplicate name+type keys;
 * - no local node-side policy disabling the side.
 *
 * Local exclusions are stored in the workflow itself through node.properties.__vsr_policy.
 */

function debugLog(...args) {
  if (DEBUG) console.debug?.(`[${EXT_NAME}]`, ...args);
}

function markDirty(node) {
  try { node?.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
  try { app.canvas?.setDirty?.(true, true); } catch (_) {}
}

function setReorderCursor(cursor) {
  const canvasElement = app.canvas?.canvas;
  if (!canvasElement?.style) return;

  if (cursor) {
    if (!canvasElement.__vosrCursorActive) {
      canvasElement.__vosrPreviousCursor = canvasElement.style.cursor || "";
      canvasElement.__vosrCursorActive = true;
    }

    if (canvasElement.style.cursor !== cursor) {
      canvasElement.style.cursor = cursor;
    }
    return;
  }

  if (canvasElement.__vosrCursorActive) {
    canvasElement.style.cursor = canvasElement.__vosrPreviousCursor || "";
    canvasElement.__vosrCursorActive = false;
    canvasElement.__vosrPreviousCursor = "";
  }
}

function updateReorderCursor() {
  let hasHover = false;

  for (const node of currentGraphNodes()) {
    if (node?.__vosrDrag) {
      setReorderCursor("grabbing");
      return;
    }

    if (node?.__vosrHover != null) {
      hasHover = true;
    }
  }

  setReorderCursor(hasHover ? "grab" : null);
}

function currentGraphNodes() {
  return app.graph?._nodes || app.canvas?.graph?._nodes || [];
}

function clearTransientNodeState(node, options = {}) {
  const clearHover = options.hover !== false;
  const clearDrag = options.drag === true;
  let changed = false;

  if (clearHover && node?.__vosrHover != null) {
    node.__vosrHover = null;
    changed = true;
  }

  if (clearDrag && node?.__vosrDrag) {
    node.__vosrDrag = null;
    changed = true;
  }

  if (changed) {
    updateReorderCursor();
    markDirty(node);
  }
  return changed;
}

function clearAllTransientStates(options = {}) {
  let changed = false;
  for (const node of currentGraphNodes()) {
    changed = clearTransientNodeState(node, options) || changed;
  }
  updateReorderCursor();
  if (changed) markDirty({ graph: app.graph || app.canvas?.graph });
}

let hoverCleanupRaf = 0;
let lastPointerShift = false;

function cleanupInvalidHoverStates() {
  hoverCleanupRaf = 0;

  const canvas = app.canvas;
  const graphMouse = canvas?.graph_mouse;

  for (const node of currentGraphNodes()) {
    if (node?.__vosrHover == null) continue;

    if (!lastPointerShift || !Array.isArray(graphMouse)) {
      clearTransientNodeState(node, { hover: true });
      continue;
    }

    const localX = graphMouse[0] - (node.pos?.[0] || 0);
    const localY = graphMouse[1] - (node.pos?.[1] || 0);
    const currentHover = reorderSlotAt(node, localX, localY);

    if (!sameHover(currentHover, node.__vosrHover)) {
      clearTransientNodeState(node, { hover: true });
    }
  }
}

function scheduleHoverCleanup(event) {
  lastPointerShift = !!event?.shiftKey;

  if (hoverCleanupRaf) return;

  const raf = window.requestAnimationFrame || ((fn) => window.setTimeout(fn, 16));
  hoverCleanupRaf = raf(cleanupInvalidHoverStates);
}

function installTransientStateCleanup() {
  if (app.__visualOutputSlotOrderTransientCleanupInstalled) return;

  const installOnCanvasElement = () => {
    const canvasElement = app.canvas?.canvas;
    if (!canvasElement || canvasElement.__visualOutputSlotOrderTransientCleanupInstalled) return false;

    canvasElement.addEventListener("pointermove", scheduleHoverCleanup, { passive: true });
    canvasElement.addEventListener("mouseleave", () => clearAllTransientStates({ hover: true }), { passive: true });
    canvasElement.addEventListener("pointercancel", () => clearAllTransientStates({ hover: true, drag: true }), { passive: true });

    canvasElement.__visualOutputSlotOrderTransientCleanupInstalled = true;
    return true;
  };

  installOnCanvasElement();

  window.addEventListener("keyup", (event) => {
    if (event?.key === "Shift") clearAllTransientStates({ hover: true });
  });

  window.addEventListener("blur", () => clearAllTransientStates({ hover: true, drag: true }));
  document.addEventListener("pointerup", () => clearAllTransientStates({ drag: true }));

  app.__visualOutputSlotOrderTransientCleanupInstalled = true;
}

function findLink(graph, id) {
  if (!graph || id == null) return null;

  if (graph._links?.get) return graph._links.get(id);
  if (graph.links?.get) return graph.links.get(id);

  if (Array.isArray(graph._links)) return graph._links[id] ?? null;
  if (Array.isArray(graph.links)) return graph.links[id] ?? null;

  return graph._links?.[id] ?? graph.links?.[id] ?? null;
}

function slotKey(slot) {
  const name = String(slot?.name ?? "");
  const type = String(slot?.type ?? "");
  return `${name}${KEY_SEP}${type}`;
}

function keyLabel(key) {
  return String(key).split(KEY_SEP).join("|");
}

function makeHover(side, index) {
  if (!side || index == null || index < 0) return null;
  return { side, index };
}

function sameHover(a, b) {
  if (a == null && b == null) return true;
  if (!a || !b) return false;
  return a.side === b.side && a.index === b.index;
}

function outputKeys(node) {
  return (node.outputs || []).map(slotKey);
}

function inputKeys(node) {
  return (node.inputs || []).map(slotKey);
}

function hasDuplicateKeys(keys) {
  return new Set(keys).size !== keys.length;
}

function ensureNodeProperties(node) {
  if (!node || typeof node !== "object") return null;
  if (!node.properties || typeof node.properties !== "object") node.properties = {};
  return node.properties;
}

function getNodePolicyRoot(node) {
  const root = node?.properties?.[POLICY_PROP];
  return root && typeof root === "object" && !Array.isArray(root) ? root : null;
}

function normalizePolicyMode(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    value = value.mode;
  }

  const mode = String(value || "auto").toLowerCase();
  if (mode === "disabled" || mode === "enabled" || mode === "auto") return mode;
  return "auto";
}

function getNodeSidePolicyMode(node, side) {
  if (side !== "input" && side !== "output") return "auto";
  const root = getNodePolicyRoot(node);
  if (!root || !Object.prototype.hasOwnProperty.call(root, side)) return "auto";
  return normalizePolicyMode(root[side]);
}

function hasNodeSidePolicy(node, side) {
  const root = getNodePolicyRoot(node);
  return !!root && Object.prototype.hasOwnProperty.call(root, side);
}

function hasAnyNodePolicy(root) {
  if (!root || typeof root !== "object") return false;
  return Object.prototype.hasOwnProperty.call(root, "input")
    || Object.prototype.hasOwnProperty.call(root, "output");
}

function cleanupEmptyPolicyRoot(node) {
  const root = getNodePolicyRoot(node);
  if (!root || hasAnyNodePolicy(root)) return false;
  if (node?.properties && Object.prototype.hasOwnProperty.call(node.properties, POLICY_PROP)) {
    delete node.properties[POLICY_PROP];
    return true;
  }
  return false;
}

function sidePolicyLabel(node, side) {
  const mode = getNodeSidePolicyMode(node, side);
  return hasNodeSidePolicy(node, side) ? mode : "auto";
}

function outputStructuralUnsupportedReason(node) {
  if (!node) return "missing_node";
  if (!Array.isArray(node.outputs) || node.outputs.length < 2) return "less_than_two_outputs";

  const keys = outputKeys(node);
  if (keys.length !== node.outputs.length) return "invalid_output_keys";
  if (hasDuplicateKeys(keys)) return "duplicate_output_name_type";

  return null;
}

function outputReorderUnsupportedReason(node) {
  if (!node) return "missing_node";

  const policyMode = getNodeSidePolicyMode(node, "output");
  if (policyMode === "disabled") return "policy_disabled_output";

  return outputStructuralUnsupportedReason(node);
}

function isOutputReorderSupported(node) {
  return outputReorderUnsupportedReason(node) == null;
}

function debugUnsupportedNode(node, context) {
  if (!DEBUG && !SHOW_UNSUPPORTED_REASON) return;

  const reason = outputReorderUnsupportedReason(node);
  if (!reason || reason === "less_than_two_outputs") return;

  debugLog(
    "unsupported output reorder",
    context || "",
    node?.title || node?.type || "<unknown>",
    reason
  );
}

function inputReorderUnsupportedReason(node) {
  if (!ENABLE_INPUT_REORDER) return "input_reorder_disabled";
  if (!node) return "missing_node";

  const policyMode = getNodeSidePolicyMode(node, "input");
  if (policyMode === "disabled") return "policy_disabled_input";

  /*
   * No input allowlist.
   * Auto support is the normal mode: an input side is enabled whenever it
   * passes the structural gates. Explicit "enabled" policy uses the same gates;
   * it does not bypass structural safety checks.
   */
  return inputStructuralUnsupportedReason(node);
}

function isInputReorderSupported(node) {
  return inputReorderUnsupportedReason(node) == null;
}

function debugUnsupportedInputNode(node, context) {
  if (!DEBUG && !SHOW_UNSUPPORTED_REASON) return;

  const reason = inputReorderUnsupportedReason(node);
  if (!reason || reason === "less_than_two_inputs" || reason === "less_than_two_connectable_inputs") return;

  debugLog(
    "unsupported input reorder",
    context || "",
    node?.title || node?.type || "<unknown>",
    reason
  );
}

function sameArray(a, b) {
  return Array.isArray(a)
    && Array.isArray(b)
    && a.length === b.length
    && a.every((v, i) => v === b[i]);
}

function sameKeySet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function getOrderRoot(node, create = false) {
  if (!node.properties) {
    if (!create) return null;
    node.properties = {};
  }

  const existing = node.properties[ORDER_PROP];
  if (existing && typeof existing === "object") return existing;

  if (!create) return null;

  node.properties[ORDER_PROP] = {};
  return node.properties[ORDER_PROP];
}

function cleanupEmptyOrderRoot(node, root) {
  if (root && typeof root === "object" && !Object.keys(root).length) {
    delete node.properties?.[ORDER_PROP];
  }
}

function normalizeLegacyState(node, root, side) {
  /*
   * Possible legacy format:
   *   __slot_order.output = [0, 2, 1]
   *   __slot_order.input = [3, 0, 1, 2, ...]
   *
   * Alpha3b rule:
   *   - identity arrays [0, 1, 2] are removed;
   *   - only truly customized legacy arrays are migrated.
   * This avoids recreating neutral metadata on nodes that were never reordered.
   */
  if (!root || (side !== "output" && side !== "input")) return null;

  const legacy = root[side];
  if (!Array.isArray(legacy)) return root[side];

  const slots = side === "output" ? (node.outputs || []) : (node.inputs || []);
  const keys = side === "output" ? outputKeys(node) : inputKeys(node);

  if (!keys.length || legacy.length !== slots.length) {
    delete root[side];
    cleanupEmptyOrderRoot(node, root);
    return null;
  }

  if (isIdentityIndexArray(legacy, keys.length)) {
    delete root[side];
    cleanupEmptyOrderRoot(node, root);
    return null;
  }

  const visual = legacy.map(i => keys[i]).filter(Boolean);
  if (visual.length !== keys.length || !sameKeySet(visual, keys)) {
    delete root[side];
    cleanupEmptyOrderRoot(node, root);
    return null;
  }

  const state = {
    version: 1,
    canonical: [...keys],
    visual,
  };
  root[side] = state;
  return state;
}

function ensureOutputOrderState(node, context = "state", options = {}) {
  const create = options.create === true;

  if (!isOutputReorderSupported(node)) {
    debugUnsupportedNode(node, context);
    return null;
  }

  const currentKeys = outputKeys(node);
  const root = getOrderRoot(node, create);
  if (!root) return null;

  normalizeLegacyState(node, root, "output");

  let state = root.output;

  if (
    !state
    || typeof state !== "object"
    || !Array.isArray(state.canonical)
    || !Array.isArray(state.visual)
    || !sameKeySet(currentKeys, state.canonical)
    || !sameKeySet(state.visual, state.canonical)
  ) {
    if (!create) return null;

    state = {
      version: 1,
      canonical: [...currentKeys],
      visual: [...currentKeys],
    };
    root.output = state;
  }

  return state;
}

function ensureInputOrderState(node, context = "state", options = {}) {
  const create = options.create === true;

  if (!isInputReorderSupported(node)) {
    debugUnsupportedInputNode(node, context);
    return null;
  }

  const currentKeys = inputKeys(node);
  const root = getOrderRoot(node, create);
  if (!root) return null;

  normalizeLegacyState(node, root, "input");

  let state = root.input;

  if (
    !state
    || typeof state !== "object"
    || !Array.isArray(state.canonical)
    || !Array.isArray(state.visual)
    || !sameKeySet(currentKeys, state.canonical)
    || !sameKeySet(state.visual, state.canonical)
  ) {
    if (!create) return null;

    state = {
      version: 1,
      canonical: [...currentKeys],
      visual: [...currentKeys],
    };
    root.input = state;
  }

  return state;
}

function getCurrentOutputIndexByKey(node, key) {
  return (node.outputs || []).findIndex(slot => slotKey(slot) === key);
}

function getCurrentInputIndexByKey(node, key) {
  return (node.inputs || []).findIndex(slot => slotKey(slot) === key);
}

function reorderArrayInPlace(arr, fromIdx, toIdx) {
  if (!arr || fromIdx === toIdx) return false;
  if (fromIdx < 0 || toIdx < 0 || fromIdx >= arr.length || toIdx >= arr.length) return false;

  const [item] = arr.splice(fromIdx, 1);
  arr.splice(toIdx, 0, item);
  return true;
}

function eachGraphLink(graph, callback) {
  if (!graph || typeof callback !== "function") return;

  const seen = new Set();
  const sources = [graph._links, graph.links];

  for (const source of sources) {
    if (!source) continue;

    if (typeof source.entries === "function") {
      for (const [rawId, link] of source.entries()) {
        if (!link) continue;
        const id = link.id ?? rawId;
        if (seen.has(id)) continue;
        seen.add(id);
        callback(link, id);
      }
      continue;
    }

    if (Array.isArray(source)) {
      for (let rawId = 0; rawId < source.length; rawId++) {
        const link = source[rawId];
        if (!link) continue;
        const id = link.id ?? rawId;
        if (seen.has(id)) continue;
        seen.add(id);
        callback(link, id);
      }
      continue;
    }

    if (typeof source === "object") {
      for (const [rawId, link] of Object.entries(source)) {
        if (!link) continue;
        const id = link.id ?? rawId;
        if (seen.has(id)) continue;
        seen.add(id);
        callback(link, id);
      }
    }
  }
}

function sameNodeId(a, b) {
  return a === b || String(a) === String(b);
}

function captureOutputLinkIdsByKey(node) {
  const graph = node?.graph;
  const byKey = new Map();

  if (!node?.outputs) return byKey;

  /*
   * Capture BEFORE the order changes.
   * slot.links are the primary source: they represent the attachment to the
   * logical slot. graph.links is used as a supplement because some versions/extensions
   * may leave slot.links partially desynchronized on the drawing side.
   */
  node.outputs.forEach((slot, index) => {
    const key = slotKey(slot);
    const ids = new Set();

    if (Array.isArray(slot?.links)) {
      for (const linkId of slot.links) ids.add(linkId);
    }

    byKey.set(key, ids);
  });

  eachGraphLink(graph, (link, linkId) => {
    if (!sameNodeId(link?.origin_id, node.id)) return;

    const originSlot = Number(link.origin_slot);
    if (!Number.isInteger(originSlot)) return;

    const slot = node.outputs[originSlot];
    if (!slot) return;

    const key = slotKey(slot);
    const ids = byKey.get(key);
    if (!ids) return;

    ids.add(link.id ?? linkId);
  });

  return byKey;
}

function syncOutputLinksToSlotObjects(node, linkIdsByKey) {
  const graph = node?.graph;
  if (!graph || !node?.outputs) return;

  node.outputs.forEach((slot, visualIndex) => {
    const key = slotKey(slot);
    const capturedIds = linkIdsByKey?.get(key) || new Set();
    const nextLinks = [];
    const seen = new Set();

    for (const linkId of capturedIds) {
      if (seen.has(linkId)) continue;
      seen.add(linkId);
      nextLinks.push(linkId);

      const link = findLink(graph, linkId);
      if (!link) continue;

      /*
       * The link remains attached to the same logical slot, identified by name+type.
       * After visual reordering, update the LiteGraph index used
       * for link drawing. This step is intentionally local to the node.
       */
      link.origin_id = node.id;
      link.origin_slot = visualIndex;
    }

    slot.links = nextLinks.length ? nextLinks : null;
  });
}

function applyOutputOrder(node, wantedKeys, options = {}) {
  if (!node?.outputs || !Array.isArray(wantedKeys)) return false;
  if (wantedKeys.length !== node.outputs.length) return false;

  const currentKeys = outputKeys(node);
  if (!sameKeySet(currentKeys, wantedKeys)) return false;
  if (sameArray(currentKeys, wantedKeys)) return false;

  const linkIdsByKey = captureOutputLinkIdsByKey(node);
  const byKey = new Map(node.outputs.map(slot => [slotKey(slot), slot]));
  const ordered = wantedKeys.map(key => byKey.get(key));

  if (ordered.some(slot => !slot)) return false;

  node.outputs.length = 0;
  ordered.forEach(slot => node.outputs.push(slot));

  node.outputs.forEach((slot, index) => {
    slot.slot_index = index;
  });

  syncOutputLinksToSlotObjects(node, linkIdsByKey);

  if (!options.silent) {
    /*
     * Do not recompute node.size here.
     * Reordering outputs does not change the number of slots;
     * computeSize() brings some nodes back to their minimum size and destroys
     * the user's manual resizing.
     */
    markDirty(node);
  }

  return true;
}

function restoreVisualOutputOrder(node) {
  const state = ensureOutputOrderState(node, "restore_visual");
  if (!state) return false;
  return applyOutputOrder(node, state.visual);
}

function canonicalizeOutputOrder(node, options = {}) {
  const state = ensureOutputOrderState(node, "canonicalize");
  if (!state) return false;
  return applyOutputOrder(node, state.canonical, options);
}

function moveVisualOutput(node, fromVisualIndex, toVisualIndex) {
  const graph = node.graph;
  const state = ensureOutputOrderState(node, "move", { create: true });
  if (!graph || !state) return false;

  const currentKeys = outputKeys(node);
  if (fromVisualIndex === toVisualIndex) return false;
  if (fromVisualIndex < 0 || toVisualIndex < 0) return false;
  if (fromVisualIndex >= currentKeys.length || toVisualIndex >= currentKeys.length) return false;

  const movedKey = currentKeys[fromVisualIndex];

  if (typeof graph.beforeChange === "function") {
    try { graph.beforeChange(node); } catch (_) {}
  }

  const visualKeys = [...currentKeys];
  reorderArrayInPlace(visualKeys, fromVisualIndex, toVisualIndex);

  /*
   * Storage uses name+type identity, not index alone.
   * Load Checkpoint example:
   *   MODEL|MODEL, CLIP|CLIP, VAE|VAE
   */
  state.visual = visualKeys;

  const changed = applyOutputOrder(node, visualKeys);

  if (changed) {
    debugLog(
      "output moved",
      node.title || node.type,
      keyLabel(movedKey),
      "from",
      fromVisualIndex,
      "to",
      toVisualIndex
    );
  }

  if (typeof graph.afterChange === "function") {
    try { graph.afterChange(node); } catch (_) {}
  }

  return changed;
}

function captureInputLinkIdsByKey(node) {
  const graph = node?.graph;
  const byKey = new Map();

  if (!node?.inputs) return byKey;

  /*
   * Capture BEFORE the order changes.
   * LiteGraph inputs normally use a single link per slot: slot.link.
   * graph.links is used as a supplement to recover a possible drawing state
   * that is partially desynchronized.
   */
  node.inputs.forEach((slot) => {
    const key = slotKey(slot);
    const ids = new Set();

    if (slot?.link != null) {
      const link = findLink(graph, slot.link);
      if (!link || sameNodeId(link?.target_id, node.id)) ids.add(slot.link);
    }

    byKey.set(key, ids);
  });

  eachGraphLink(graph, (link, linkId) => {
    if (!sameNodeId(link?.target_id, node.id)) return;

    const targetSlot = Number(link.target_slot);
    if (!Number.isInteger(targetSlot)) return;

    const slot = node.inputs[targetSlot];
    if (!slot) return;

    const key = slotKey(slot);
    const ids = byKey.get(key);
    if (!ids) return;

    ids.add(link.id ?? linkId);
  });

  return byKey;
}

function syncInputLinksToSlotObjects(node, linkIdsByKey) {
  const graph = node?.graph;
  if (!graph || !node?.inputs) return;

  node.inputs.forEach((slot, visualIndex) => {
    const key = slotKey(slot);
    const capturedIds = linkIdsByKey?.get(key) || new Set();
    let assignedLinkId = null;

    for (const linkId of capturedIds) {
      const link = findLink(graph, linkId);
      if (!link) continue;

      assignedLinkId = link.id ?? linkId;

      /*
       * The link remains attached to the same logical input, identified by name+type.
       * After visual reordering, update the LiteGraph index used
       * for link drawing and prompt validation while in visual mode.
       */
      link.target_id = node.id;
      link.target_slot = visualIndex;
      break;
    }

    slot.link = assignedLinkId;
  });
}

function applyInputOrder(node, wantedKeys, options = {}) {
  if (!node?.inputs || !Array.isArray(wantedKeys)) return false;
  if (wantedKeys.length !== node.inputs.length) return false;

  const currentKeys = inputKeys(node);
  if (!sameKeySet(currentKeys, wantedKeys)) return false;
  if (sameArray(currentKeys, wantedKeys)) return false;

  const linkIdsByKey = captureInputLinkIdsByKey(node);
  const byKey = new Map(node.inputs.map(slot => [slotKey(slot), slot]));
  const ordered = wantedKeys.map(key => byKey.get(key));

  if (ordered.some(slot => !slot)) return false;

  node.inputs.length = 0;
  ordered.forEach(slot => node.inputs.push(slot));

  node.inputs.forEach((slot, index) => {
    slot.slot_index = index;
  });

  syncInputLinksToSlotObjects(node, linkIdsByKey);

  if (!options.silent) markDirty(node);

  return true;
}

function restoreVisualInputOrder(node) {
  const state = ensureInputOrderState(node, "restore_visual_input");
  if (!state) return false;
  return applyInputOrder(node, state.visual);
}

function canonicalizeInputOrder(node, options = {}) {
  const state = ensureInputOrderState(node, "canonicalize_input");
  if (!state) return false;
  return applyInputOrder(node, state.canonical, options);
}

function moveVisualInput(node, fromVisualIndex, toVisualIndex) {
  const graph = node.graph;
  const state = ensureInputOrderState(node, "move_input", { create: true });
  if (!graph || !state) return false;

  const currentKeys = inputKeys(node);
  if (fromVisualIndex === toVisualIndex) return false;
  if (fromVisualIndex < 0 || toVisualIndex < 0) return false;
  if (fromVisualIndex >= currentKeys.length || toVisualIndex >= currentKeys.length) return false;

  const movedKey = currentKeys[fromVisualIndex];

  if (typeof graph.beforeChange === "function") {
    try { graph.beforeChange(node); } catch (_) {}
  }

  const visualKeys = [...currentKeys];
  reorderArrayInPlace(visualKeys, fromVisualIndex, toVisualIndex);
  state.visual = visualKeys;

  const changed = applyInputOrder(node, visualKeys);

  if (changed) {
    debugLog(
      "input moved",
      node.title || node.type,
      keyLabel(movedKey),
      "from",
      fromVisualIndex,
      "to",
      toVisualIndex
    );
  }

  if (typeof graph.afterChange === "function") {
    try { graph.afterChange(node); } catch (_) {}
  }

  return changed;
}


function getSlotOrderStateForSide(node, side, context = "reset") {
  if (side === "output") return ensureOutputOrderState(node, context);
  if (side === "input") return ensureInputOrderState(node, context);
  return null;
}

function applyCanonicalOrderForSide(node, side, state, options = {}) {
  if (!state?.canonical) return false;
  if (side === "output") return applyOutputOrder(node, state.canonical, options);
  if (side === "input") return applyInputOrder(node, state.canonical, options);
  return false;
}

function getNodeSlotOrderRoot(node) {
  const root = node?.properties?.[ORDER_PROP];
  return root && typeof root === "object" ? root : null;
}

function removeSlotOrderSideMetadata(node, side) {
  const root = getNodeSlotOrderRoot(node);
  if (!root || !Object.prototype.hasOwnProperty.call(root, side)) return false;
  delete root[side];
  cleanupEmptyOrderRoot(node, root);
  return true;
}

function nodeHasSlotOrderMetadata(node) {
  const root = getNodeSlotOrderRoot(node);
  return !!root && (
    Object.prototype.hasOwnProperty.call(root, "input")
    || Object.prototype.hasOwnProperty.call(root, "output")
  );
}

function sideHasCustomVisualSlotOrder(node, side) {
  const root = getNodeSlotOrderRoot(node);
  if (!root || !Object.prototype.hasOwnProperty.call(root, side)) return false;

  const value = root[side];

  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (Array.isArray(value.canonical) && Array.isArray(value.visual)) {
      return !sameArray(value.visual, value.canonical);
    }
    return true;
  }

  if (Array.isArray(value)) {
    return !isIdentityIndexArray(value, value.length);
  }

  return value != null;
}

function nodeHasResettableVisualSlotOrder(node) {
  return sideHasCustomVisualSlotOrder(node, "input") || sideHasCustomVisualSlotOrder(node, "output");
}

function resetVisualSlotOrderSide(node, side, options = {}) {
  const state = getSlotOrderStateForSide(node, side, `reset_${side}`);
  const hadMetadata = !!getNodeSlotOrderRoot(node)?.[side];

  let changed = false;
  let removed = false;

  if (state) {
    changed = applyCanonicalOrderForSide(node, side, state, options);
    removed = removeSlotOrderSideMetadata(node, side);
  } else if (hadMetadata && options.removeInvalidMetadata === true) {
    /*
     * Explicit reset action only.
     * If the side metadata cannot be normalized, remove the VSR metadata rather
     * than keeping a stale visual order. We do not attempt to reorder slots when
     * the side cannot be safely identified.
     */
    removed = removeSlotOrderSideMetadata(node, side);
  }

  return { side, changed, removed };
}

function resetNodeVisualSlotOrder(node, options = {}) {
  const graph = node?.graph || app.graph || app.canvas?.graph;
  const sides = Array.isArray(options.sides) ? options.sides : ["output", "input"];
  const useHistory = options.history !== false;

  if (!node || !sides.length) {
    return {
      version: EXT_VERSION,
      nodeId: node?.id ?? null,
      nodeType: node?.type ?? null,
      changedSides: 0,
      removedSides: 0,
      results: [],
    };
  }

  if (useHistory && typeof graph?.beforeChange === "function") {
    try { graph.beforeChange(node); } catch (_) {}
  }

  const results = [];
  try {
    for (const side of sides) {
      if (side !== "input" && side !== "output") continue;
      results.push(resetVisualSlotOrderSide(node, side, {
        silent: options.silent === true,
        removeInvalidMetadata: options.removeInvalidMetadata !== false,
      }));
    }
  } finally {
    if (useHistory && typeof graph?.afterChange === "function") {
      try { graph.afterChange(node); } catch (_) {}
    }
  }

  const changedSides = results.filter(result => result.changed).length;
  const removedSides = results.filter(result => result.removed).length;

  if (changedSides || removedSides) markDirty(node);

  return {
    version: EXT_VERSION,
    nodeId: node.id,
    nodeType: node.type,
    title: node.title || node.type,
    changedSides,
    removedSides,
    results,
  };
}

function resetWorkflowVisualSlotOrder(graph = app.graph || app.canvas?.graph, options = {}) {
  const nodes = graph?._nodes || [];
  const results = [];

  if (typeof graph?.beforeChange === "function") {
    try { graph.beforeChange(); } catch (_) {}
  }

  try {
    for (const node of nodes) {
      if (!nodeHasSlotOrderMetadata(node)) continue;
      const result = resetNodeVisualSlotOrder(node, {
        ...options,
        history: false,
        silent: options.silent === true,
        removeInvalidMetadata: options.removeInvalidMetadata !== false,
      });
      if (result.changedSides || result.removedSides) results.push(result);
    }
  } finally {
    if (typeof graph?.afterChange === "function") {
      try { graph.afterChange(); } catch (_) {}
    }
  }

  const changedSides = results.reduce((sum, result) => sum + result.changedSides, 0);
  const removedSides = results.reduce((sum, result) => sum + result.removedSides, 0);

  if (changedSides || removedSides) markDirty({ graph });

  const report = {
    version: EXT_VERSION,
    nodeCount: results.length,
    changedSides,
    removedSides,
    results,
  };

  console.info(`[${EXT_NAME}] resetWorkflowVisualSlotOrder`, report);
  return report;
}

function resetNodeVisualSlotOrderWithConfirmation(node) {
  if (!node) return null;

  if (!nodeHasSlotOrderMetadata(node)) {
    window.alert?.("ComfyUI Visual Slot Reorder\n\nThis node has no VSR visual order metadata to reset.");
    return {
      version: EXT_VERSION,
      cancelled: false,
      nodeId: node.id,
      nodeType: node.type,
      changedSides: 0,
      removedSides: 0,
      results: [],
    };
  }

  const title = node.title || node.type || `#${node.id}`;
  const message = [
    `ComfyUI Visual Slot Reorder ${EXT_VERSION}`,
    "",
    `Reset visual slot order for this node?`,
    "",
    `#${node.id} ${title}`,
    "",
    "This restores the default/canonical port order for this node and removes its VSR metadata.",
    "Links and execution order are preserved by key-based link sync.",
    "",
    "Continue?",
  ].join("\n");

  if (!window.confirm?.(message)) {
    return {
      version: EXT_VERSION,
      cancelled: true,
      nodeId: node.id,
      nodeType: node.type,
      changedSides: 0,
      removedSides: 0,
      results: [],
    };
  }

  const result = resetNodeVisualSlotOrder(node);
  window.alert?.([
    "ComfyUI Visual Slot Reorder",
    "",
    `Reset ${result.removedSides} side(s) on node #${node.id}.`,
    "",
    "Save the workflow manually to keep the reset JSON.",
  ].join("\n"));
  return result;
}

function resetWorkflowVisualSlotOrderWithConfirmation() {
  const before = getSlotOrderMetadataReport();
  const customEntries = before.entries.filter(entry => entry.reason === "custom_visual_order");

  if (!customEntries.length) {
    window.alert?.("ComfyUI Visual Slot Reorder\n\nNo custom visual slot orders found in the current workflow.");
    return {
      version: EXT_VERSION,
      cancelled: false,
      nodeCount: 0,
      changedSides: 0,
      removedSides: 0,
      before,
      after: before,
      results: [],
    };
  }

  const message = [
    `ComfyUI Visual Slot Reorder ${EXT_VERSION}`,
    "",
    `Reset ${customEntries.length} custom visual slot order entries in the current workflow?`,
    "",
    "This restores default/canonical port order and removes VSR visual-order metadata.",
    "Links and execution order are preserved by key-based link sync.",
    "",
    "After reset, save the workflow manually to keep the reset JSON.",
    "",
    "Continue?",
  ].join("\n");

  if (!window.confirm?.(message)) {
    return {
      version: EXT_VERSION,
      cancelled: true,
      nodeCount: 0,
      changedSides: 0,
      removedSides: 0,
      before,
      after: before,
      results: [],
    };
  }

  const result = resetWorkflowVisualSlotOrder();
  const after = getSlotOrderMetadataReport();
  window.alert?.([
    "ComfyUI Visual Slot Reorder",
    "",
    `Reset ${result.removedSides} visual-order side(s) on ${result.nodeCount} node(s).`,
    "",
    "Save the workflow manually to keep the reset JSON.",
  ].join("\n"));

  return {
    ...result,
    cancelled: false,
    before,
    after,
  };
}


const VSR_CONTEXT_MENU_ACTION_GUARD_MS = 450;
let lastVsrContextMenuAction = null;

function runNodeContextPolicyMenuAction(node, actionKey, callback) {
  const now = typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
  const key = `${node?.id ?? "<missing>"}:${actionKey}`;

  if (lastVsrContextMenuAction
    && lastVsrContextMenuAction.key === key
    && now - lastVsrContextMenuAction.time < VSR_CONTEXT_MENU_ACTION_GUARD_MS) {
    const result = {
      version: EXT_VERSION,
      ok: true,
      changed: false,
      ignoredDuplicate: true,
      reason: "duplicate_context_menu_action_guard",
      nodeId: node?.id,
      nodeType: node?.type,
      actionKey,
    };
    console.warn(`[${EXT_NAME}] ignored duplicate context-menu action`, result);
    return result;
  }

  lastVsrContextMenuAction = { key, time: now };
  return callback();
}

function getNodeContextPolicyEntries(node) {
  if (!node) return [];

  const entries = [];
  const inputPolicyMode = getNodeSidePolicyMode(node, "input");
  const outputPolicyMode = getNodeSidePolicyMode(node, "output");
  const inputStructuralReason = inputStructuralUnsupportedReason(node);
  const outputStructuralReason = outputStructuralUnsupportedReason(node);
  const inputSupported = isInputReorderSupported(node);
  const outputSupported = isOutputReorderSupported(node);
  const inputExplicit = hasNodeSidePolicy(node, "input");
  const outputExplicit = hasNodeSidePolicy(node, "output");

  const hasEntry = (content) => entries.some(entry => entry?.content === content);
  const pushEntry = (content, callback, disabled = false) => {
    if (hasEntry(content)) return;
    entries.push({ content, callback, disabled: !!disabled });
  };

  /*
   * v1.2.6:
   * Minimal state-driven menu. Do not display grey status rows and do not show
   * the opposite action for the current state. Each side exposes only one useful
   * action:
   * - currently enabled/supported -> Disable
   * - disabled by policy          -> Enable, only when the structure is safe
   * A single "Clear VSR policy" entry is shown only when a local policy exists.
   */
  if (inputPolicyMode === "disabled" && inputStructuralReason == null) {
    pushEntry(
      "VSR: Enable input reorder for this node",
      () => runNodeContextPolicyMenuAction(node, "input:enabled", () => setNodeVsrPolicy(node, "input", "enabled")),
    );
  } else if (inputSupported) {
    pushEntry(
      "VSR: Disable input reorder for this node",
      () => runNodeContextPolicyMenuAction(node, "input:disabled", () => setNodeVsrPolicy(node, "input", "disabled")),
    );
  }

  if (outputPolicyMode === "disabled" && outputStructuralReason == null) {
    pushEntry(
      "VSR: Enable output reorder for this node",
      () => runNodeContextPolicyMenuAction(node, "output:enabled", () => setNodeVsrPolicy(node, "output", "enabled")),
    );
  } else if (outputSupported) {
    pushEntry(
      "VSR: Disable output reorder for this node",
      () => runNodeContextPolicyMenuAction(node, "output:disabled", () => setNodeVsrPolicy(node, "output", "disabled")),
    );
  }

  if (inputExplicit || outputExplicit) {
    pushEntry(
      "VSR: Clear VSR policy for this node",
      () => runNodeContextPolicyMenuAction(node, "all:clear", () => clearNodeVsrPolicy(node)),
    );
  }

  return entries;
}

function getContextMenuEntryLabel(entry) {
  if (typeof entry === "string") return entry.trim();
  if (!entry || typeof entry !== "object") return "";
  const value = entry.content ?? entry.title ?? entry.label ?? entry.name ?? entry.text;
  return typeof value === "string" ? value.trim() : "";
}

function normalizeContextMenuContent(content) {
  return typeof content === "string" ? content.trim() : "";
}

function isVisualSlotReorderContextMenuLabel(label) {
  const text = normalizeContextMenuContent(label);
  if (!text) return false;

  return text === "VSR: Reset visual slot order"
    || text === "VSR: Disable input reorder for this node"
    || text === "VSR: Disable output reorder for this node"
    || text === "VSR: Enable input reorder for this node"
    || text === "VSR: Enable output reorder for this node"
    || text === "VSR: Clear input reorder policy for this node"
    || text === "VSR: Clear output reorder policy for this node"
    || text === "VSR: Clear VSR policy for this node"
    || text.startsWith("VSR input reorder:")
    || text.startsWith("VSR output reorder:");
}

function isVisualSlotReorderContextMenuContent(content) {
  return isVisualSlotReorderContextMenuLabel(content);
}

function isVisualSlotReorderContextMenuEntry(entry) {
  return isVisualSlotReorderContextMenuLabel(getContextMenuEntryLabel(entry));
}

function removeStaleVisualSlotReorderContextMenuEntries(menuOptions) {
  if (!Array.isArray(menuOptions)) return 0;

  let removed = 0;
  for (let i = menuOptions.length - 1; i >= 0; i--) {
    const entry = menuOptions[i];
    if (isVisualSlotReorderContextMenuEntry(entry)) {
      menuOptions.splice(i, 1);
      removed++;
    }
  }

  // Avoid leaving duplicate separators when stale entries were removed.
  for (let i = menuOptions.length - 1; i >= 0; i--) {
    const prev = menuOptions[i - 1];
    const current = menuOptions[i];
    const next = menuOptions[i + 1];
    if (current === null && (prev == null || next == null || i === 0 || i === menuOptions.length - 1)) {
      menuOptions.splice(i, 1);
    }
  }

  return removed;
}

function installNodeContextMenuReset(nodeType) {
  const proto = nodeType?.prototype;
  if (!proto || proto.__visualSlotReorderContextMenuPatched) return;

  const originalGetExtraMenuOptions = proto.getExtraMenuOptions;

  proto.getExtraMenuOptions = function visualSlotReorderGetExtraMenuOptions(canvas, options) {
    const result = typeof originalGetExtraMenuOptions === "function"
      ? originalGetExtraMenuOptions.apply(this, arguments)
      : undefined;

    const menuOptions = Array.isArray(options) ? options : arguments[1];
    if (!Array.isArray(menuOptions)) return result;

    // ComfyUI Desktop can keep/reuse native menu arrays through Vue/LiteGraph
    // layers. Remove previously injected VSR entries first, then rebuild from
    // the current node state so the menu never exposes stale policy actions.
    removeStaleVisualSlotReorderContextMenuEntries(menuOptions);

    const entries = [];

    /*
     * Strictly conditional reset entry: only nodes that currently have a custom
     * VSR visual order get the reset action. This avoids polluting native
     * LiteGraph menus on nodes unrelated to the extension.
     */
    if (nodeHasResettableVisualSlotOrder(this)) {
      entries.push({
        content: "VSR: Reset visual slot order",
        callback: () => resetNodeVisualSlotOrderWithConfirmation(this),
      });
    }

    entries.push(...getNodeContextPolicyEntries(this));

    const existingLabels = new Set(menuOptions.map(getContextMenuEntryLabel).filter(Boolean));
    const uniqueEntries = entries.filter(entry => {
      const label = getContextMenuEntryLabel(entry);
      if (!label) return false;
      if (existingLabels.has(label)) return false;
      existingLabels.add(label);
      return true;
    });

    if (!uniqueEntries.length) return result;

    if (menuOptions.length && menuOptions[menuOptions.length - 1] !== null) menuOptions.push(null);
    menuOptions.push(...uniqueEntries);

    return result;
  };

  proto.__visualSlotReorderContextMenuPatched = true;
  proto.__visualSlotReorderResetContextPatched = true;
}

function eventToLocal(node, event, localPos) {
  if (Array.isArray(localPos)) return localPos;

  /*
   * Depending on the LiteGraph/ComfyUI Desktop version, event.canvasX/Y may or
   * may not exist. Keep a fallback through canvas.ds.
   */
  const ds = app.canvas?.ds;
  if (!ds || event?.canvasX == null || event?.canvasY == null) return null;

  return [
    (event.canvasX - ds.offset[0]) / ds.scale - (node.pos?.[0] || 0),
    (event.canvasY - ds.offset[1]) / ds.scale - (node.pos?.[1] || 0),
  ];
}


function widgetValueAt(node, localX, localY) {
  if (!node?.widgets?.length) return null;

  const nodeWidth = node.size?.[0] || 160;
  const defaultHeight = LiteGraph.NODE_WIDGET_HEIGHT || 20;

  for (const widget of node.widgets) {
    if (!widget || widget.disabled || widget.hidden) continue;

    const y = Number.isFinite(widget.y)
      ? widget.y
      : (Number.isFinite(widget.last_y) ? widget.last_y : null);

    if (y == null) continue;

    let height = widget.height;
    if (!Number.isFinite(height) || height <= 0) {
      try {
        const computed = widget.computeSize?.(nodeWidth);
        if (Array.isArray(computed) && Number.isFinite(computed[1])) height = computed[1];
      } catch (_) {}
    }

    if (!Number.isFinite(height) || height <= 0) height = defaultHeight;

    /*
     * LiteGraph/ComfyUI widgets usually occupy the node's usable width.
     * This guard is intentionally broad: VSR should not capture
     * clicks on input/value areas, even while Shift is held.
     */
    const left = 8;
    const right = Math.max(left, nodeWidth - 8);
    const top = y - 3;
    const bottom = y + height + 3;

    if (localX >= left && localX <= right && localY >= top && localY <= bottom) {
      return widget;
    }
  }

  return null;
}

function isWidgetValueHit(node, localX, localY) {
  return widgetValueAt(node, localX, localY) != null;
}

function outputSlotAt(node, localX, localY) {
  if (!node?.outputs?.length) return -1;

  const nodeX = node.pos?.[0] || 0;
  const nodeY = node.pos?.[1] || 0;
  const halfH = SLOT_HEIGHT / 2 + 3;

  for (let i = 0; i < node.outputs.length; i++) {
    try {
      const pos = node.getConnectionPos(false, i);
      if (!pos) continue;

      const x = pos[0] - nodeX;
      const y = pos[1] - nodeY;

      /*
       * Enlarged selection area on the output row.
       * The original output behavior required Shift, so the label can be covered
       * without interfering with normal node movement.
       *
       * Avoid starting fully from the left edge to reduce confusion
       * with inputs on mixed input/output nodes.
       */
      const nodeWidth = node.size?.[0] || 160;
      const leftLimit = Math.max(OUTPUT_HITBOX_MIN_LEFT, nodeWidth * OUTPUT_HITBOX_LEFT_RATIO);
      const rightLimit = nodeWidth + OUTPUT_HITBOX_RIGHT_PAD;
      const nearX = localX >= leftLimit && localX <= rightLimit;
      const nearY = Math.abs(localY - y) <= halfH;

      if (nearX && nearY) return i;
    } catch (_) {}
  }

  return -1;
}

function inputSlotAt(node, localX, localY) {
  if (!node?.inputs?.length) return -1;

  const nodeX = node.pos?.[0] || 0;
  const nodeY = node.pos?.[1] || 0;
  const halfH = SLOT_HEIGHT / 2 + 3;

  for (let i = 0; i < node.inputs.length; i++) {
    try {
      const pos = node.getConnectionPos(true, i);
      if (!pos) continue;

      const y = pos[1] - nodeY;
      const nodeWidth = node.size?.[0] || 160;
      const leftLimit = -INPUT_HITBOX_LEFT_PAD;
      const rightLimit = Math.min(
        nodeWidth - 6,
        Math.max(INPUT_HITBOX_MIN_RIGHT, nodeWidth * INPUT_HITBOX_RIGHT_RATIO)
      );
      const nearX = localX >= leftLimit && localX <= rightLimit;
      const nearY = Math.abs(localY - y) <= halfH;

      if (nearX && nearY) return i;
    } catch (_) {}
  }

  return -1;
}

function reorderSlotAt(node, localX, localY) {
  if (isOutputReorderSupported(node)) {
    const outputIndex = outputSlotAt(node, localX, localY);
    if (outputIndex >= 0) return makeHover("output", outputIndex);
  }

  if (isInputReorderSupported(node)) {
    const inputIndex = inputSlotAt(node, localX, localY);
    if (inputIndex >= 0) return makeHover("input", inputIndex);
  }

  return null;
}

function drawRoundedRect(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
    return;
  }

  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

function slotDisplayText(slot) {
  return String(
    slot?.label ??
    slot?.localized_name ??
    slot?.name ??
    slot?.type ??
    ""
  );
}

function measureSlotTextWidth(ctx, slot) {
  try {
    const text = slotDisplayText(slot);
    if (!text) return 0;
    return Math.ceil(ctx.measureText(text).width || 0);
  } catch (_) {
    return 0;
  }
}

function compactSlotHighlightRect(node, ctx, side, visualIndex) {
  const isInput = side === "input";
  const slots = isInput ? (node.inputs || []) : (node.outputs || []);
  const slot = slots[visualIndex];
  if (!slot) return null;

  const pos = node.getConnectionPos(isInput, visualIndex);
  if (!pos) return null;

  const nodeX = node.pos?.[0] || 0;
  const nodeY = node.pos?.[1] || 0;
  const nodeWidth = node.size?.[0] || 160;
  const localX = pos[0] - nodeX;
  const y = (pos[1] - nodeY) - SLOT_HEIGHT / 2;

  /*
   * Keep the classic LiteGraph feedback compact, like the Nodes 2.0 DOM
   * highlight. The rectangle covers the port area plus the visible label only;
   * it no longer spans the full node width.
   */
  const textWidth = measureSlotTextWidth(ctx, slot);
  const maxWidth = Math.max(42, nodeWidth - 12);
  const w = Math.min(maxWidth, Math.max(46, textWidth + 34));

  if (isInput) {
    const x = Math.max(4, Math.min(localX - 4, nodeWidth - w - 4));
    return { x, y, w, h: SLOT_HEIGHT };
  }

  const x = Math.max(4, Math.min(localX - w + 4, nodeWidth - w + 4));
  return { x, y, w, h: SLOT_HEIGHT };
}

function drawCompactSlotHighlight(node, ctx, side, visualIndex, hoverOnly = false) {
  try {
    const rect = compactSlotHighlightRect(node, ctx, side, visualIndex);
    if (!rect) return;

    ctx.save();
    ctx.beginPath();
    drawRoundedRect(ctx, rect.x, rect.y, rect.w, rect.h, 5);
    ctx.fillStyle = hoverOnly ? "rgba(60,140,255,0.06)" : "rgba(60,140,255,0.16)";
    ctx.strokeStyle = hoverOnly ? "rgba(60,140,255,0.30)" : "rgba(60,140,255,0.55)";
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  } catch (_) {}
}

function drawOutputHighlight(node, ctx, visualIndex, hoverOnly = false) {
  if (visualIndex < 0 || visualIndex >= (node.outputs || []).length) return;
  drawCompactSlotHighlight(node, ctx, "output", visualIndex, hoverOnly);
}

function drawInputHighlight(node, ctx, visualIndex, hoverOnly = false) {
  if (visualIndex < 0 || visualIndex >= (node.inputs || []).length) return;
  drawCompactSlotHighlight(node, ctx, "input", visualIndex, hoverOnly);
}

function drawSlotHighlight(node, ctx, hover, hoverOnly = false) {
  if (!hover) return;

  if (hover.side === "output") {
    drawOutputHighlight(node, ctx, hover.index, hoverOnly);
  } else if (hover.side === "input") {
    drawInputHighlight(node, ctx, hover.index, hoverOnly);
  }
}



/*
 * Nodes 2.0 DOM drag compatibility layer.
 *
 * The classic LiteGraph path is intentionally left unchanged. Nodes 2.0 renders
 * slots as DOM elements using .lg-slot / .lg-slot--input / .lg-slot--output
 * inside a [data-node-id] node wrapper. This layer only listens to DOM pointer
 * events and only consumes them when a reorder modifier is held and the pointer
 * starts on a supported slot.
 */
const NODES2_SLOT_SELECTOR = ".lg-slot";
const NODES2_INPUT_SLOT_SELECTOR = ".lg-slot.lg-slot--input";
const NODES2_OUTPUT_SLOT_SELECTOR = ".lg-slot.lg-slot--output";
const NODES2_NODE_SELECTOR = "[data-node-id]";
const NODES2_HIGHLIGHT_STYLE_ID = "visual-slot-reorder-nodes2-highlight-style";
const NODES2_HOVER_CLASS = "vsr-nodes2-slot-hover";
const NODES2_DRAG_CLASS = "vsr-nodes2-slot-drag";

const nodes2DomDragState = {
  vKeyDown: false,
  drag: null,
  hoverSlotEl: null,
  dragSlotEl: null,
  lastStatus: null,
};

function isEditableDomTarget(target) {
  if (!target || typeof target.closest !== "function") return false;
  return !!target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']");
}

function installNodes2HighlightStyles() {
  if (typeof document === "undefined" || document.getElementById(NODES2_HIGHLIGHT_STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = NODES2_HIGHLIGHT_STYLE_ID;
  style.textContent = `
    .lg-slot.${NODES2_HOVER_CLASS},
    .lg-slot.${NODES2_DRAG_CLASS} {
      border-radius: 8px;
      outline-offset: 1px;
      transition: background-color 80ms ease, box-shadow 80ms ease, outline-color 80ms ease;
    }

    .lg-slot.${NODES2_HOVER_CLASS} {
      outline: 1px solid rgba(60, 140, 255, 0.68);
      background-color: rgba(60, 140, 255, 0.10);
      box-shadow: inset 0 0 0 1px rgba(60, 140, 255, 0.20);
    }

    .lg-slot.${NODES2_DRAG_CLASS} {
      outline: 1px solid rgba(60, 140, 255, 0.95);
      background-color: rgba(60, 140, 255, 0.18);
      box-shadow: inset 0 0 0 1px rgba(60, 140, 255, 0.34), 0 0 0 1px rgba(60, 140, 255, 0.18);
    }

    .lg-slot.${NODES2_HOVER_CLASS} .text-node-component-slot-text,
    .lg-slot.${NODES2_DRAG_CLASS} .text-node-component-slot-text {
      text-shadow: 0 0 6px rgba(60, 140, 255, 0.45);
    }

    .lg-slot.${NODES2_HOVER_CLASS} .slot-dot,
    .lg-slot.${NODES2_DRAG_CLASS} .slot-dot {
      box-shadow: 0 0 0 2px rgba(60, 140, 255, 0.55), 0 0 8px rgba(60, 140, 255, 0.38);
    }
  `;
  document.head?.appendChild(style);
}

function clearNodes2SlotElementClass(slotEl, className) {
  try { slotEl?.classList?.remove(className); } catch (_) {}
}

function setNodes2HoverSlot(slotEl) {
  if (nodes2DomDragState.drag) return;

  const previous = nodes2DomDragState.hoverSlotEl;
  if (previous === slotEl) return;

  clearNodes2SlotElementClass(previous, NODES2_HOVER_CLASS);
  nodes2DomDragState.hoverSlotEl = slotEl || null;

  try { slotEl?.classList?.add(NODES2_HOVER_CLASS); } catch (_) {}
}

function setNodes2DragSlot(slotEl) {
  const previous = nodes2DomDragState.dragSlotEl;
  if (previous === slotEl) return;

  clearNodes2SlotElementClass(previous, NODES2_DRAG_CLASS);
  nodes2DomDragState.dragSlotEl = slotEl || null;

  try { slotEl?.classList?.add(NODES2_DRAG_CLASS); } catch (_) {}
}

function clearNodes2VisualSlotState() {
  clearNodes2SlotElementClass(nodes2DomDragState.hoverSlotEl, NODES2_HOVER_CLASS);
  clearNodes2SlotElementClass(nodes2DomDragState.dragSlotEl, NODES2_DRAG_CLASS);
  nodes2DomDragState.hoverSlotEl = null;
  nodes2DomDragState.dragSlotEl = null;

  if (typeof document !== "undefined") {
    try {
      document.querySelectorAll(`.${NODES2_HOVER_CLASS}, .${NODES2_DRAG_CLASS}`).forEach(slotEl => {
        slotEl.classList.remove(NODES2_HOVER_CLASS, NODES2_DRAG_CLASS);
      });
    } catch (_) {}
  }
}

function isNodes2SlotInfoSupported(info) {
  if (!info?.node || !info?.nodeEl || !info?.slotEl) return false;
  if (!isNodes2SideSupported(info.node, info.side)) return false;
  return getNodes2SlotIndex(info.nodeEl, info.slotEl, info.side) >= 0;
}

function getGraphNodeById(nodeId) {
  if (nodeId == null) return null;
  return currentGraphNodes().find(node => String(node?.id) === String(nodeId)) || null;
}

function getNodes2SlotSide(slotEl) {
  if (!slotEl?.classList) return null;
  if (slotEl.classList.contains("lg-slot--input")) return "input";
  if (slotEl.classList.contains("lg-slot--output")) return "output";
  return null;
}

function getNodes2SlotInfoFromTarget(target) {
  if (!target || typeof target.closest !== "function") return null;

  const slotEl = target.closest(NODES2_SLOT_SELECTOR);
  if (!slotEl) return null;

  const nodeEl = slotEl.closest(NODES2_NODE_SELECTOR);
  if (!nodeEl) return null;

  const side = getNodes2SlotSide(slotEl);
  if (side !== "input" && side !== "output") return null;

  const nodeId = nodeEl.getAttribute("data-node-id");
  const node = getGraphNodeById(nodeId);
  if (!node) return null;

  return { node, nodeId, nodeEl, slotEl, side };
}

function getNodes2SlotElements(nodeEl, side) {
  if (!nodeEl || (side !== "input" && side !== "output")) return [];
  const selector = side === "input" ? NODES2_INPUT_SLOT_SELECTOR : NODES2_OUTPUT_SLOT_SELECTOR;
  return Array.from(nodeEl.querySelectorAll(selector))
    .filter(slotEl => slotEl.closest(NODES2_NODE_SELECTOR) === nodeEl);
}

function getNodes2SlotIndex(nodeEl, slotEl, side) {
  const slots = getNodes2SlotElements(nodeEl, side);
  return slots.indexOf(slotEl);
}

function getNodes2SlotAtPoint(clientX, clientY, nodeEl, side) {
  if (!nodeEl || (side !== "input" && side !== "output")) return null;

  const elements = typeof document.elementsFromPoint === "function"
    ? document.elementsFromPoint(clientX, clientY)
    : [];

  for (const element of elements) {
    const slotEl = typeof element.closest === "function" ? element.closest(NODES2_SLOT_SELECTOR) : null;
    if (!slotEl) continue;
    if (slotEl.closest(NODES2_NODE_SELECTOR) !== nodeEl) continue;
    if (getNodes2SlotSide(slotEl) !== side) continue;
    return slotEl;
  }

  return null;
}

function isNodes2SideSupported(node, side) {
  if (side === "input") return isInputReorderSupported(node);
  if (side === "output") return isOutputReorderSupported(node);
  return false;
}

function isNodes2ReorderModifierActive(event) {
  return !!event?.shiftKey || nodes2DomDragState.vKeyDown === true;
}

function consumeNodes2ReorderEvent(event) {
  try { event.preventDefault?.(); } catch (_) {}
  try { event.stopPropagation?.(); } catch (_) {}
  try { event.stopImmediatePropagation?.(); } catch (_) {}
}

function startNodes2DomDrag(event, info) {
  const { node, nodeEl, slotEl, side } = info || {};
  if (!node || !nodeEl || !slotEl) return false;
  if (!isNodes2SideSupported(node, side)) return false;

  const visualIndex = getNodes2SlotIndex(nodeEl, slotEl, side);
  if (visualIndex < 0) return false;

  const slots = side === "input" ? (node.inputs || []) : (node.outputs || []);
  const slot = slots[visualIndex];
  if (!slot) return false;

  const drag = {
    side,
    node,
    nodeId: String(node.id),
    nodeEl,
    key: slotKey(slot),
    index: visualIndex,
    pointerId: event.pointerId,
    startedAt: Date.now(),
  };

  nodes2DomDragState.drag = drag;
  node.__vosrDrag = {
    side,
    index: visualIndex,
    key: drag.key,
    nodes2: true,
  };

  setNodes2HoverSlot(null);
  setNodes2DragSlot(slotEl);

  consumeNodes2ReorderEvent(event);
  setReorderCursor("grabbing");
  markDirty(node);
  return true;
}

function moveNodes2DomDrag(event) {
  const drag = nodes2DomDragState.drag;
  if (!drag) return false;
  if (drag.pointerId != null && event.pointerId != null && drag.pointerId !== event.pointerId) return false;

  const node = drag.node;
  if (!node) {
    finishNodes2DomDrag(event, { silent: true });
    return false;
  }

  const overSlotEl = getNodes2SlotAtPoint(event.clientX, event.clientY, drag.nodeEl, drag.side);
  if (overSlotEl) {
    setNodes2DragSlot(overSlotEl);
    const overIndex = getNodes2SlotIndex(drag.nodeEl, overSlotEl, drag.side);

    if (overIndex >= 0 && overIndex !== drag.index) {
      if (drag.side === "output") {
        const fromIndex = getCurrentOutputIndexByKey(node, drag.key);
        if (fromIndex >= 0 && moveVisualOutput(node, fromIndex, overIndex)) {
          drag.index = overIndex;
          if (node.__vosrDrag) node.__vosrDrag.index = overIndex;
        }
      } else if (drag.side === "input") {
        const fromIndex = getCurrentInputIndexByKey(node, drag.key);
        if (fromIndex >= 0 && moveVisualInput(node, fromIndex, overIndex)) {
          drag.index = overIndex;
          if (node.__vosrDrag) node.__vosrDrag.index = overIndex;
        }
      }
    }
  }

  consumeNodes2ReorderEvent(event);
  return true;
}

function finishNodes2DomDrag(event, options = {}) {
  const drag = nodes2DomDragState.drag;
  if (!drag) return false;
  if (drag.pointerId != null && event?.pointerId != null && drag.pointerId !== event.pointerId) return false;

  const node = drag.node;

  if (node?.__vosrDrag?.nodes2) {
    node.__vosrDrag = null;
  }

  nodes2DomDragState.drag = null;
  clearNodes2VisualSlotState();
  updateReorderCursor();
  if (node) markDirty(node);

  if (!options.silent && event) consumeNodes2ReorderEvent(event);
  return true;
}

function getNodes2DomStatus() {
  const nodeElements = typeof document !== "undefined"
    ? document.querySelectorAll(`${NODES2_NODE_SELECTOR}.lg-node, .lg-node${NODES2_NODE_SELECTOR}`)
    : [];
  const inputSlots = typeof document !== "undefined" ? document.querySelectorAll(NODES2_INPUT_SLOT_SELECTOR) : [];
  const outputSlots = typeof document !== "undefined" ? document.querySelectorAll(NODES2_OUTPUT_SLOT_SELECTOR) : [];

  const status = {
    version: EXT_VERSION,
    domLayerInstalled: !!app.__visualSlotReorderNodes2DomDragInstalled,
    nodes2DomDetected: nodeElements.length > 0 && (inputSlots.length > 0 || outputSlots.length > 0),
    nodeElements: nodeElements.length,
    inputSlots: inputSlots.length,
    outputSlots: outputSlots.length,
    vKeyDown: nodes2DomDragState.vKeyDown,
    activeDrag: !!nodes2DomDragState.drag,
    activeDragSide: nodes2DomDragState.drag?.side || null,
    hoverActive: !!nodes2DomDragState.hoverSlotEl,
    dragHighlightActive: !!nodes2DomDragState.dragSlotEl,
    highlightStyleInstalled: typeof document !== "undefined" && !!document.getElementById(NODES2_HIGHLIGHT_STYLE_ID),
    shortcuts: {
      classic: "Shift + drag",
      nodes2: "Shift + drag or V + drag",
    },
  };

  nodes2DomDragState.lastStatus = status;
  return status;
}

function installNodes2DevTools() {
  const api = window.ReorderNodes || (window.ReorderNodes = {});
  const dev = api.__dev && typeof api.__dev === "object" ? api.__dev : {};
  if (!api.__dev || Object.getOwnPropertyDescriptor(api, "__dev")?.enumerable) {
    Object.defineProperty(api, "__dev", {
      value: dev,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }

  const nodes2 = dev.nodes2 && typeof dev.nodes2 === "object" ? dev.nodes2 : {};
  Object.defineProperty(dev, "nodes2", {
    value: nodes2,
    enumerable: false,
    configurable: true,
    writable: true,
  });

  Object.defineProperty(nodes2, "getStatus", {
    value: getNodes2DomStatus,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function installNodes2DomDrag() {
  if (app.__visualSlotReorderNodes2DomDragInstalled) return;

  installNodes2HighlightStyles();

  const onKeyDown = (event) => {
    if (isEditableDomTarget(event.target)) return;
    if (String(event.key || "").toLowerCase() === "v") {
      nodes2DomDragState.vKeyDown = true;
    }
  };

  const onKeyUp = (event) => {
    if (String(event.key || "").toLowerCase() === "v") {
      nodes2DomDragState.vKeyDown = false;
    }
    if (String(event.key || "").toLowerCase() === "v" || event.key === "Shift") {
      setNodes2HoverSlot(null);
    }
  };

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    if (!isNodes2ReorderModifierActive(event)) return;
    if (isEditableDomTarget(event.target)) return;

    const info = getNodes2SlotInfoFromTarget(event.target);
    if (!info) return;

    startNodes2DomDrag(event, info);
  };

  const onPointerMove = (event) => {
    if (nodes2DomDragState.drag) {
      moveNodes2DomDrag(event);
      return;
    }

    if (!isNodes2ReorderModifierActive(event) || isEditableDomTarget(event.target)) {
      setNodes2HoverSlot(null);
      return;
    }

    const info = getNodes2SlotInfoFromTarget(event.target);
    setNodes2HoverSlot(isNodes2SlotInfoSupported(info) ? info.slotEl : null);
  };

  const onPointerUp = (event) => {
    if (!nodes2DomDragState.drag) return;
    finishNodes2DomDrag(event);
  };

  const onPointerCancel = (event) => {
    if (!nodes2DomDragState.drag) return;
    finishNodes2DomDrag(event);
  };

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", () => {
    nodes2DomDragState.vKeyDown = false;
    finishNodes2DomDrag(null, { silent: true });
    clearNodes2VisualSlotState();
  });

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("pointercancel", onPointerCancel, true);

  app.__visualSlotReorderNodes2DomDragInstalled = true;
}
function installOnNode(node) {
  if (!node || node.__visualSlotOrderInstalled) return;

  const supportsOutput = isOutputReorderSupported(node);
  const supportsInput = isInputReorderSupported(node);

  if (!supportsOutput) debugUnsupportedNode(node, "install");
  if (!supportsInput) debugUnsupportedInputNode(node, "install");
  if (!supportsOutput && !supportsInput) return;

  node.__visualSlotOrderInstalled = true;
  node.__visualOutputSlotOrderInstalled = true;

  const originalMouseDown = node.onMouseDown;
  node.onMouseDown = function visualSlotReorderMouseDown(event, localPos, canvas) {
    if (this.__vosrHover != null) {
      this.__vosrHover = null;
      updateReorderCursor();
      markDirty(this);
    }

    /*
     * SHIFT + drag.
     * Outputs : stable v1.1.4.
     * Inputs : automatic structural support with local policy guard.
     */
    if (event?.shiftKey) {
      const lp = eventToLocal(this, event, localPos);
      if (lp && !isWidgetValueHit(this, lp[0], lp[1])) {
        const hit = reorderSlotAt(this, lp[0], lp[1]);

        if (hit?.side === "output") {
          this.__vosrDrag = {
            side: "output",
            index: hit.index,
            key: slotKey(this.outputs[hit.index]),
          };
          updateReorderCursor();
          markDirty(this);
          return true;
        }

        if (hit?.side === "input") {
          this.__vosrDrag = {
            side: "input",
            index: hit.index,
            key: slotKey(this.inputs[hit.index]),
          };
          updateReorderCursor();
          markDirty(this);
          return true;
        }
      }
    }

    return originalMouseDown?.call(this, event, localPos, canvas);
  };

  const originalMouseMove = node.onMouseMove;
  node.onMouseMove = function visualSlotReorderMouseMove(event, localPos, canvas) {
    const lp = eventToLocal(this, event, localPos);

    if (this.__vosrDrag) {
      if (lp) {
        if (this.__vosrDrag.side === "output") {
          const overIndex = outputSlotAt(this, lp[0], lp[1]);

          if (overIndex >= 0 && overIndex !== this.__vosrDrag.index) {
            const fromIndex = getCurrentOutputIndexByKey(this, this.__vosrDrag.key);

            if (fromIndex >= 0 && moveVisualOutput(this, fromIndex, overIndex)) {
              this.__vosrDrag.index = overIndex;
            }
          }
        } else if (this.__vosrDrag.side === "input") {
          const overIndex = inputSlotAt(this, lp[0], lp[1]);

          if (overIndex >= 0 && overIndex !== this.__vosrDrag.index) {
            const fromIndex = getCurrentInputIndexByKey(this, this.__vosrDrag.key);

            if (fromIndex >= 0 && moveVisualInput(this, fromIndex, overIndex)) {
              this.__vosrDrag.index = overIndex;
            }
          }
        }
      }

      return true;
    }

    if (event?.shiftKey && lp && !isWidgetValueHit(this, lp[0], lp[1])) {
      const hover = reorderSlotAt(this, lp[0], lp[1]);

      if (!sameHover(hover, this.__vosrHover)) {
        this.__vosrHover = hover;
        updateReorderCursor();
        markDirty(this);
      }
    } else if (this.__vosrHover != null) {
      this.__vosrHover = null;
      updateReorderCursor();
      markDirty(this);
    }

    return originalMouseMove?.call(this, event, localPos, canvas);
  };

  const originalMouseUp = node.onMouseUp;
  node.onMouseUp = function visualSlotReorderMouseUp(event, localPos, canvas) {
    if (this.__vosrDrag) {
      this.__vosrDrag = null;
      updateReorderCursor();
      markDirty(this);
      return true;
    }

    return originalMouseUp?.call(this, event, localPos, canvas);
  };

  const originalDrawForeground = node.onDrawForeground;
  node.onDrawForeground = function visualSlotReorderDrawForeground(ctx) {
    originalDrawForeground?.call(this, ctx);

    if (this.__vosrDrag) {
      if (this.__vosrDrag.side === "output") {
        const idx = getCurrentOutputIndexByKey(this, this.__vosrDrag.key);
        drawSlotHighlight(this, ctx, makeHover("output", idx), false);
      } else if (this.__vosrDrag.side === "input") {
        const idx = getCurrentInputIndexByKey(this, this.__vosrDrag.key);
        drawSlotHighlight(this, ctx, makeHover("input", idx), false);
      }
    } else if (this.__vosrHover != null) {
      drawSlotHighlight(this, ctx, this.__vosrHover, true);
    }
  };

  /*
   * If the node has just been loaded from a workflow containing __slot_order,
   * restore the requested visual order for each supported side.
   */
  if (supportsOutput) restoreVisualOutputOrder(node);
  if (supportsInput) restoreVisualInputOrder(node);
}

function collectNodesWithCustomOutputOrder(graph) {
  const nodes = graph?._nodes || [];
  return nodes.filter(node => {
    const state = ensureOutputOrderState(node, "collect_output");
    return state && !sameArray(outputKeys(node), state.canonical);
  });
}

function collectNodesWithCustomInputOrder(graph) {
  const nodes = graph?._nodes || [];
  return nodes.filter(node => {
    const state = ensureInputOrderState(node, "collect_input");
    return state && !sameArray(inputKeys(node), state.canonical);
  });
}

let canonicalDepth = 0;

function captureAndCanonicalizeOutputOrder(graph) {
  const changedNodes = [];
  const nodes = collectNodesWithCustomOutputOrder(graph);

  for (const node of nodes) {
    const state = ensureOutputOrderState(node, "capture_output");
    if (!state) continue;

    if (canonicalizeOutputOrder(node, { silent: true })) {
      changedNodes.push({
        side: "output",
        node,
        visual: [...state.visual],
      });
    }
  }

  return changedNodes;
}

function captureAndCanonicalizeInputOrder(graph) {
  const changedNodes = [];
  const nodes = collectNodesWithCustomInputOrder(graph);

  for (const node of nodes) {
    const state = ensureInputOrderState(node, "capture_input");
    if (!state) continue;

    if (canonicalizeInputOrder(node, { silent: true })) {
      changedNodes.push({
        side: "input",
        node,
        visual: [...state.visual],
      });
    }
  }

  return changedNodes;
}

function captureAndCanonicalizeSlotOrder(graph) {
  return [
    ...captureAndCanonicalizeOutputOrder(graph),
    ...captureAndCanonicalizeInputOrder(graph),
  ];
}

function restoreCapturedVisualSlotOrder(changedNodes) {
  for (const entry of changedNodes) {
    if (entry.side === "output") {
      applyOutputOrder(entry.node, entry.visual, { silent: true });
      markDirty(entry.node);
    } else if (entry.side === "input") {
      applyInputOrder(entry.node, entry.visual, { silent: true });
      markDirty(entry.node);
    }
  }
}

function withCanonicalSlotOrder(graph, fn) {
  if (!graph || canonicalDepth > 0) {
    return fn();
  }

  canonicalDepth++;
  const changedNodes = [];

  try {
    changedNodes.push(...captureAndCanonicalizeSlotOrder(graph));
    return fn();
  } finally {
    restoreCapturedVisualSlotOrder(changedNodes);
    canonicalDepth--;
  }
}

async function withCanonicalSlotOrderAsync(graph, fn) {
  if (!graph || canonicalDepth > 0) {
    return await fn();
  }

  canonicalDepth++;
  const changedNodes = [];

  try {
    changedNodes.push(...captureAndCanonicalizeSlotOrder(graph));

    /*
     * Important: queuePrompt is asynchronous in several ComfyUI versions.
     * Wait for prompt construction/sending to fully finish before
     * restoring visual order, otherwise validation still receives the visual
     * indexes and produces swapped MODEL/CLIP/VAE errors.
     */
    return await fn();
  } finally {
    restoreCapturedVisualSlotOrder(changedNodes);
    canonicalDepth--;
  }
}

function patchGraphSerialization() {
  if (LGraph.prototype.__visualOutputSlotOrderSerializePatched) return;

  const originalSerialize = LGraph.prototype.serialize;
  if (typeof originalSerialize !== "function") return;

  LGraph.prototype.serialize = function visualOutputSlotOrderSerialize(...args) {
    return withCanonicalSlotOrder(this, () => originalSerialize.apply(this, args));
  };

  LGraph.prototype.__visualOutputSlotOrderSerializePatched = true;
}

function patchGraphConfigure() {
  if (LGraph.prototype.__visualOutputSlotOrderConfigurePatched) return;

  const originalConfigure = LGraph.prototype.configure;
  if (typeof originalConfigure !== "function") return;

  LGraph.prototype.configure = function visualOutputSlotOrderConfigure(...args) {
    const result = originalConfigure.apply(this, args);

    /*
     * Strictly after configure: nodes and links exist.
     * The visual order can therefore be restored and origin_slot adjusted for drawing.
     */
    for (const node of this._nodes || []) {
      installOnNode(node);
      if (isOutputReorderSupported(node)) restoreVisualOutputOrder(node);
      if (isInputReorderSupported(node)) restoreVisualInputOrder(node);
    }

    markDirty({ graph: this });
    return result;
  };

  LGraph.prototype.__visualOutputSlotOrderConfigurePatched = true;
}

function patchPromptExecution() {
  if (app.__visualOutputSlotOrderPromptPatched) return;

  /*
   * The most precise hook: graphToPrompt, if present in this version.
   * This avoids leaving the canvas in canonical order for the entire queuePrompt call.
   */
  if (typeof app.graphToPrompt === "function") {
    const originalGraphToPrompt = app.graphToPrompt;
    app.graphToPrompt = function visualOutputSlotOrderGraphToPrompt(...args) {
      return withCanonicalSlotOrder(this.graph, () => originalGraphToPrompt.apply(this, args));
    };
  }

  /*
   * Fallback for versions where queuePrompt builds the prompt directly.
   */
  if (typeof app.queuePrompt === "function") {
    const originalQueuePrompt = app.queuePrompt;
    app.queuePrompt = async function visualOutputSlotOrderQueuePrompt(...args) {
      const graph = this.graph || app.graph;
      return await withCanonicalSlotOrderAsync(graph, () => originalQueuePrompt.apply(this, args));
    };
  }

  app.__visualOutputSlotOrderPromptPatched = true;
}



function isIdentityIndexArray(value, length) {
  return Array.isArray(value)
    && value.length === length
    && value.every((entry, index) => entry === index);
}

function isModernSlotOrderState(value) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Array.isArray(value.canonical)
    && Array.isArray(value.visual);
}

function describeSlotOrderEntry(node, side, value) {
  const slots = side === "output" ? (node.outputs || []) : (node.inputs || []);
  const keys = side === "output" ? outputKeys(node) : inputKeys(node);

  if (value == null) {
    return {
      side,
      status: "absent",
      removable: false,
      format: "none",
      reason: "no_metadata",
    };
  }

  if (Array.isArray(value)) {
    const removable = isIdentityIndexArray(value, slots.length);
    return {
      side,
      status: removable ? "neutral" : "keep",
      removable,
      format: "legacy_index_array",
      reason: removable ? "legacy_identity_order" : "legacy_custom_or_mismatch",
      currentSlotCount: slots.length,
      value: [...value],
    };
  }

  if (isModernSlotOrderState(value)) {
    const canonicalMatchesCurrent = sameKeySet(keys, value.canonical);
    const visualMatchesCanonical = sameArray(value.visual, value.canonical);
    const removable = canonicalMatchesCurrent && visualMatchesCanonical;

    return {
      side,
      status: removable ? "neutral" : "keep",
      removable,
      format: "modern_v1",
      reason: removable
        ? "visual_equals_canonical"
        : (!canonicalMatchesCurrent ? "canonical_mismatch_current_node" : "custom_visual_order"),
      currentKeys: [...keys],
      canonical: [...value.canonical],
      visual: [...value.visual],
    };
  }

  return {
    side,
    status: "keep",
    removable: false,
    format: typeof value,
    reason: "unknown_slot_order_format",
  };
}

function getSlotOrderMetadataReport(graph = app.graph || app.canvas?.graph) {
  const nodes = graph?._nodes || [];
  const entries = [];

  for (const node of nodes) {
    const root = node?.properties?.[ORDER_PROP];
    if (!root || typeof root !== "object") continue;

    const sides = [];
    if (Object.prototype.hasOwnProperty.call(root, "output")) sides.push("output");
    if (Object.prototype.hasOwnProperty.call(root, "input")) sides.push("input");

    if (!sides.length) {
      const isEmptyRoot = Object.keys(root).length === 0;
      entries.push({
        nodeId: node.id,
        nodeType: node.type,
        title: node.title || node.type,
        side: "root",
        status: isEmptyRoot ? "neutral" : "keep",
        removable: isEmptyRoot,
        format: isEmptyRoot ? "empty_root" : "unknown_root_keys",
        reason: isEmptyRoot ? "empty_slot_order_root" : "slot_order_root_has_unknown_keys",
      });
      continue;
    }

    for (const side of sides) {
      const description = describeSlotOrderEntry(node, side, root[side]);
      entries.push({
        nodeId: node.id,
        nodeType: node.type,
        title: node.title || node.type,
        ...description,
      });
    }
  }

  const removable = entries.filter(entry => entry.removable);
  const kept = entries.filter(entry => !entry.removable && entry.status !== "absent");

  return {
    version: EXT_VERSION,
    totalEntries: entries.length,
    removableEntries: removable.length,
    keptEntries: kept.length,
    entries,
    removable,
    kept,
  };
}

function printSlotOrderMetadataReport(report) {
  const rows = report.entries.map(entry => ({
    nodeId: entry.nodeId,
    nodeType: entry.nodeType,
    side: entry.side,
    removable: entry.removable,
    format: entry.format,
    reason: entry.reason,
  }));

  console.info(`[${EXT_NAME}] slot order metadata report`, {
    totalEntries: report.totalEntries,
    removableEntries: report.removableEntries,
    keptEntries: report.keptEntries,
  });

  if (rows.length) console.table?.(rows);
  return report;
}

function reportSlotOrderMetadata(graph = app.graph || app.canvas?.graph) {
  return printSlotOrderMetadataReport(getSlotOrderMetadataReport(graph));
}

function cleanSlotOrderMetadata(graph = app.graph || app.canvas?.graph) {
  const nodes = graph?._nodes || [];
  const removed = [];

  for (const node of nodes) {
    const root = node?.properties?.[ORDER_PROP];
    if (!root || typeof root !== "object") continue;

    for (const side of ["output", "input"]) {
      if (!Object.prototype.hasOwnProperty.call(root, side)) continue;

      const description = describeSlotOrderEntry(node, side, root[side]);
      if (!description.removable) continue;

      delete root[side];
      removed.push({
        nodeId: node.id,
        nodeType: node.type,
        title: node.title || node.type,
        side,
        format: description.format,
        reason: description.reason,
      });
    }

    if (!Object.keys(root).length) {
      delete node.properties[ORDER_PROP];
      removed.push({
        nodeId: node.id,
        nodeType: node.type,
        title: node.title || node.type,
        side: "root",
        format: "empty_root",
        reason: "removed_empty_slot_order_root",
      });
    }
  }

  if (removed.length) {
    markDirty({ graph });
  }

  console.info(`[${EXT_NAME}] cleanSlotOrderMetadata removed ${removed.length} metadata entries`);
  if (removed.length) console.table?.(removed);

  return {
    version: EXT_VERSION,
    removedCount: removed.length,
    removed,
    after: getSlotOrderMetadataReport(graph),
  };
}


function compactSlotOrderEntryLine(entry) {
  const title = entry.title && entry.title !== entry.nodeType ? ` (${entry.title})` : "";
  return `#${entry.nodeId} ${entry.nodeType}${title} ${entry.side} - ${entry.reason}`;
}

function buildSlotOrderMetadataSummary(report, includeDetails = true) {
  const custom = report.entries.filter(entry => entry.reason === "custom_visual_order");
  const removable = report.removable || [];
  const lines = [
    `ComfyUI Visual Slot Reorder ${EXT_VERSION}`,
    "",
    `Total metadata entries: ${report.totalEntries}`,
    `Custom visual orders kept: ${custom.length}`,
    `Removable entries: ${report.removableEntries}`,
  ];

  if (!includeDetails) return lines.join("\n");

  if (custom.length) {
    lines.push("", "Custom orders:");
    custom.slice(0, 20).forEach(entry => lines.push(`- ${compactSlotOrderEntryLine(entry)}`));
    if (custom.length > 20) lines.push(`- ... ${custom.length - 20} more`);
  }

  if (removable.length) {
    lines.push("", "Removable metadata:");
    removable.slice(0, 30).forEach(entry => lines.push(`- ${compactSlotOrderEntryLine(entry)}`));
    if (removable.length > 30) lines.push(`- ... ${removable.length - 30} more`);
  }

  if (!removable.length) {
    lines.push("", "Nothing to clean.");
  }

  return lines.join("\n");
}

function showSlotOrderMetadataReport() {
  const report = reportSlotOrderMetadata();
  window.alert?.(buildSlotOrderMetadataSummary(report, true));
  return report;
}

function buildSlotOrderMetadataExportText(report) {
  return [
    buildSlotOrderMetadataSummary(report, true),
    "",
    "JSON:",
    JSON.stringify(report, null, 2),
  ].join("\n");
}

function fallbackCopyTextToClipboard(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.cssText = [
    "position: fixed",
    "left: -9999px",
    "top: 0",
    "opacity: 0",
  ].join(";");
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let ok = false;
  try { ok = document.execCommand?.("copy") === true; }
  finally { textarea.remove(); }

  return ok;
}

async function copyTextToClipboard(text, label) {
  let copied = false;
  let method = "fallback";

  if (navigator?.clipboard?.writeText && window.isSecureContext !== false) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      method = "navigator.clipboard";
    } catch (error) {
      console.warn(`[${EXT_NAME}] navigator.clipboard.writeText failed, trying fallback`, error);
    }
  }

  if (!copied) copied = fallbackCopyTextToClipboard(text);

  if (!copied) {
    window.alert?.(`${label} could not be copied automatically. See the browser console for details.`);
    console.info(`[${EXT_NAME}] ${label}`, text);
    return {
      version: EXT_VERSION,
      copied: false,
      label,
      text,
    };
  }

  window.alert?.(`${label} copied to clipboard.`);
  return {
    version: EXT_VERSION,
    copied: true,
    method,
    label,
    length: text.length,
  };
}

async function copySlotOrderMetadataReport() {
  const report = reportSlotOrderMetadata();
  const text = buildSlotOrderMetadataExportText(report);
  return copyTextToClipboard(text, "VSR metadata report");
}

function cleanSlotOrderMetadataWithConfirmation() {
  const before = getSlotOrderMetadataReport();

  if (!before.removableEntries) {
    window.alert?.("ComfyUI Visual Slot Reorder\n\nNo unused slot metadata found. Nothing to clean.");
    return {
      version: EXT_VERSION,
      cancelled: false,
      removedCount: 0,
      before,
      after: before,
    };
  }

  const message = [
    `ComfyUI Visual Slot Reorder ${EXT_VERSION}`,
    "",
    `${before.removableEntries} unused slot metadata entries can be removed.`,
    "This should not affect links, execution, or custom visual slot orders.",
    "",
    "Custom visual orders will be kept.",
    "",
    "After cleaning, save the workflow manually to keep the cleaned JSON.",
    "",
    "Continue?",
  ].join("\n");

  if (!window.confirm?.(message)) {
    return {
      version: EXT_VERSION,
      cancelled: true,
      removedCount: 0,
      before,
      after: before,
    };
  }

  const result = cleanSlotOrderMetadata();
  window.alert?.([
    "ComfyUI Visual Slot Reorder",
    "",
    `Removed ${result.removedCount} unused metadata entries.`,
    "",
    "Save the workflow manually to keep the cleaned JSON.",
  ].join("\n"));

  return result;
}


function getSelectedOrHoveredNodes(graph = app.graph || app.canvas?.graph) {
  const selected = app.canvas?.selected_nodes;
  let nodes = [];

  if (selected) {
    if (Array.isArray(selected)) {
      nodes = selected;
    } else if (selected instanceof Set) {
      nodes = Array.from(selected);
    } else if (typeof selected === "object") {
      nodes = Object.values(selected);
    }
  }

  nodes = nodes.filter(node => node && typeof node === "object" && node.id != null);

  if (!nodes.length) {
    nodes = (graph?._nodes || []).filter(node => node?.selected || node?.flags?.selected);
  }

  if (!nodes.length && app.canvas?.node_over) {
    nodes = [app.canvas.node_over];
  }

  const seen = new Set();
  return nodes.filter(node => {
    if (!node || node.id == null || seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}

function toPlainVector2(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.length >= 2 ? [value[0], value[1]] : [...value];
  if (typeof value === "object" && 0 in value && 1 in value) return [value[0], value[1]];
  return value;
}

function inputSlotHasWidget(slot) {
  return !!slot?.widget?.name;
}

function inputSlotHasLink(slot) {
  return slot?.link != null;
}

function isInputSlotConnectableForScan(slot) {
  // The safety scan distinguishes real visual connection ports from widget-backed
  // parameter entries. A widget-backed entry is only treated as connectable when
  // it is currently linked, because ComfyUI may expose converted widget inputs
  // through the same slot structure.
  return !!slot && (!inputSlotHasWidget(slot) || inputSlotHasLink(slot));
}

function inputSlotKindForScan(slot) {
  return isInputSlotConnectableForScan(slot) ? "connectable" : "widget";
}

function inputSlotStatsForScan(node) {
  const slots = node?.inputs || [];
  let connectable = 0;
  let widget = 0;
  let linked = 0;

  for (const slot of slots) {
    if (isInputSlotConnectableForScan(slot)) connectable += 1;
    if (inputSlotHasWidget(slot)) widget += 1;
    if (inputSlotHasLink(slot)) linked += 1;
  }

  return {
    total: slots.length,
    connectable,
    widget,
    linked,
  };
}

function slotVisualPortCountForScan(node, side) {
  if (side === "input") return inputSlotStatsForScan(node).connectable;
  return node?.outputs?.length || 0;
}

function formatSlotInfo(slot, index, side) {
  const base = {
    index,
    name: slot?.name ?? "",
    localizedName: slot?.localized_name ?? "",
    type: slot?.type ?? "",
    widget: slot?.widget?.name ?? "",
    shape: slot?.shape ?? "",
  };

  if (side === "input") {
    return {
      ...base,
      link: slot?.link == null ? "none" : String(slot.link),
      scanKind: inputSlotKindForScan(slot),
      scanConnectable: isInputSlotConnectableForScan(slot),
    };
  }

  return {
    ...base,
    links: Array.isArray(slot?.links) ? slot.links.map(link => String(link)) : [],
  };
}

function nodeOrderMetadataStatus(node, side) {
  const entry = node?.properties?.[ORDER_PROP]?.[side];
  if (entry == null) return "none";
  const description = describeSlotOrderEntry(node, side, entry);
  return `${description.format}:${description.reason}`;
}

function buildNodeInfoReport(nodes = getSelectedOrHoveredNodes()) {
  const items = nodes.map(node => {
    const outputReason = outputReorderUnsupportedReason(node);
    const inputReason = inputReorderUnsupportedReason(node);
    return {
      id: node.id,
      type: node.type,
      title: node.title || node.type,
      mode: node.mode,
      order: node.order,
      size: toPlainVector2(node.size),
      pos: toPlainVector2(node.pos),
      inputCount: node.inputs?.length || 0,
      outputCount: node.outputs?.length || 0,
      inputReorderSupported: inputReason == null,
      inputUnsupportedReason: inputReason,
      outputReorderSupported: outputReason == null,
      outputUnsupportedReason: outputReason,
      inputMetadata: nodeOrderMetadataStatus(node, "input"),
      outputMetadata: nodeOrderMetadataStatus(node, "output"),
      vsrPolicy: getNodePolicyRoot(node),
      inputPolicy: sidePolicyLabel(node, "input"),
      outputPolicy: sidePolicyLabel(node, "output"),
      inputs: (node.inputs || []).map((slot, index) => formatSlotInfo(slot, index, "input")),
      outputs: (node.outputs || []).map((slot, index) => formatSlotInfo(slot, index, "output")),
    };
  });

  return {
    version: EXT_VERSION,
    count: items.length,
    items,
  };
}

function printNodeInfoReport(report) {
  console.info(`[${EXT_NAME}] selected/hovered node info`, {
    count: report.count,
    version: report.version,
  });

  const nodeRows = report.items.map(item => ({
    id: item.id,
    type: item.type,
    title: item.title,
    inputs: item.inputCount,
    outputs: item.outputCount,
    inputReorder: item.inputReorderSupported ? "supported" : item.inputUnsupportedReason,
    outputReorder: item.outputReorderSupported ? "supported" : item.outputUnsupportedReason,
    inputMetadata: item.inputMetadata,
    outputMetadata: item.outputMetadata,
    inputPolicy: item.inputPolicy,
    outputPolicy: item.outputPolicy,
  }));

  if (nodeRows.length) console.table?.(nodeRows);

  for (const item of report.items) {
    console.groupCollapsed?.(`[${EXT_NAME}] node #${item.id} ${item.type}`);
    if (item.inputs.length) console.table?.(item.inputs.map(slot => ({ side: "input", ...slot })));
    if (item.outputs.length) console.table?.(item.outputs.map(slot => ({ side: "output", ...slot })));
    console.groupEnd?.();
  }

  return report;
}

function reportSelectedNodeInfo(nodes = getSelectedOrHoveredNodes()) {
  return printNodeInfoReport(buildNodeInfoReport(nodes));
}

function buildNodeInfoSummary(report) {
  const lines = [
    `ComfyUI Visual Slot Reorder ${EXT_VERSION}`,
    "",
    `Selected/hovered nodes: ${report.count}`,
  ];

  if (!report.count) {
    lines.push("", "Select a node first, or hover a node and open this report again.");
    return lines.join("\n");
  }

  for (const item of report.items.slice(0, 8)) {
    lines.push(
      "",
      `#${item.id} ${item.type}${item.title && item.title !== item.type ? ` (${item.title})` : ""}`,
      `Inputs: ${item.inputCount} | Outputs: ${item.outputCount}`,
      `Input reorder: ${item.inputReorderSupported ? "supported" : item.inputUnsupportedReason}`,
      `Output reorder: ${item.outputReorderSupported ? "supported" : item.outputUnsupportedReason}`,
      `Input metadata: ${item.inputMetadata}`,
      `Output metadata: ${item.outputMetadata}`,
      `Input policy: ${item.inputPolicy}`,
      `Output policy: ${item.outputPolicy}`,
    );

    if (item.inputs.length) {
      lines.push("Inputs:");
      item.inputs.slice(0, 12).forEach(slot => {
        lines.push(`  ${slot.index}: ${slot.name} <${slot.type}> link=${slot.link}`);
      });
      if (item.inputs.length > 12) lines.push(`  ... ${item.inputs.length - 12} more`);
    }

    if (item.outputs.length) {
      lines.push("Outputs:");
      item.outputs.slice(0, 12).forEach(slot => {
        lines.push(`  ${slot.index}: ${slot.name} <${slot.type}> links=${slot.links?.length ? slot.links.join(",") : "none"}`);
      });
      if (item.outputs.length > 12) lines.push(`  ... ${item.outputs.length - 12} more`);
    }
  }

  if (report.items.length > 8) lines.push("", `... ${report.items.length - 8} more selected nodes`);
  lines.push("", "Detailed tables are also printed in the browser console.");
  return lines.join("\n");
}

function showSelectedNodeInfo() {
  const report = reportSelectedNodeInfo();
  window.alert?.(buildNodeInfoSummary(report));
  return report;
}

function buildNodeInfoExportText(report) {
  return [
    buildNodeInfoSummary(report),
    "",
    "JSON:",
    JSON.stringify(report, null, 2),
  ].join("\n");
}

async function copySelectedNodeInfo() {
  const report = reportSelectedNodeInfo();
  const text = buildNodeInfoExportText(report);
  return copyTextToClipboard(text, "VSR selected node info");
}


function sideStructuralUnsupportedReason(node, side) {
  if (side === "input") return inputStructuralUnsupportedReason(node);
  if (side === "output") return outputStructuralUnsupportedReason(node);
  return "invalid_side";
}

function formatNodeRef(node) {
  if (!node) return "<no node>";
  const title = node.title && node.title !== node.type ? ` (${node.title})` : "";
  return `#${node.id} ${node.type}${title}`;
}

function applyVisualStateAfterPolicyChange(node, side, mode) {
  if (!node || (side !== "input" && side !== "output")) return null;

  if (mode === "disabled") {
    clearTransientNodeState(node, { hover: true, drag: true });
    return resetNodeVisualSlotOrder(node, {
      sides: [side],
      history: false,
      silent: true,
      removeInvalidMetadata: true,
    });
  }

  if (side === "output" && isOutputReorderSupported(node)) {
    restoreVisualOutputOrder(node);
  } else if (side === "input" && isInputReorderSupported(node)) {
    restoreVisualInputOrder(node);
  }

  clearTransientNodeState(node, { hover: true, drag: true });
  markDirty(node);
  return null;
}

function setNodeVsrPolicy(node, side, mode, options = {}) {
  if (!node) {
    return {
      version: EXT_VERSION,
      ok: false,
      changed: false,
      reason: "missing_node",
      side,
      mode,
    };
  }

  if (side !== "input" && side !== "output") {
    return {
      version: EXT_VERSION,
      ok: false,
      changed: false,
      reason: "invalid_side",
      nodeId: node.id,
      nodeType: node.type,
      side,
      mode,
    };
  }

  mode = normalizePolicyMode(mode);
  if (mode === "auto") return clearNodeVsrPolicy(node, side, options);

  if (mode === "enabled") {
    const structuralReason = sideStructuralUnsupportedReason(node, side);
    if (structuralReason) {
      return {
        version: EXT_VERSION,
        ok: false,
        changed: false,
        reason: `cannot_enable_${side}:${structuralReason}`,
        nodeId: node.id,
        nodeType: node.type,
        title: node.title || node.type,
        side,
        mode,
        structuralReason,
      };
    }
  }

  const beforeMode = getNodeSidePolicyMode(node, side);
  const beforeExplicit = hasNodeSidePolicy(node, side);

  const graph = node.graph || app.graph || app.canvas?.graph;
  const useHistory = options.history !== false;

  if (useHistory && typeof graph?.beforeChange === "function") {
    try { graph.beforeChange(node); } catch (_) {}
  }

  let visualReset = null;
  try {
    // Canonicalize and remove VSR visual order metadata before writing a disabled policy.
    // This avoids leaving a node visually reordered while the side is explicitly disabled.
    visualReset = applyVisualStateAfterPolicyChange(node, side, mode);

    const props = ensureNodeProperties(node);
    const root = props[POLICY_PROP] && typeof props[POLICY_PROP] === "object" && !Array.isArray(props[POLICY_PROP])
      ? props[POLICY_PROP]
      : {};

    root.version = 1;
    root[side] = mode;
    root.reason = String(options.reason || "manual_user_policy");
    root.updatedAt = new Date().toISOString();
    props[POLICY_PROP] = root;
  } finally {
    if (useHistory && typeof graph?.afterChange === "function") {
      try { graph.afterChange(node); } catch (_) {}
    }
  }

  const afterMode = getNodeSidePolicyMode(node, side);
  const changed = !beforeExplicit || beforeMode !== afterMode;
  markDirty(node);

  const result = {
    version: EXT_VERSION,
    ok: true,
    changed,
    nodeId: node.id,
    nodeType: node.type,
    title: node.title || node.type,
    side,
    mode: afterMode,
    previousMode: beforeExplicit ? beforeMode : "auto",
    policy: getNodePolicyRoot(node),
    visualReset,
    inputSupported: isInputReorderSupported(node),
    inputReason: inputReorderUnsupportedReason(node),
    outputSupported: isOutputReorderSupported(node),
    outputReason: outputReorderUnsupportedReason(node),
  };

  console.info(`[${EXT_NAME}] setNodeVsrPolicy`, result);
  return result;
}

function clearNodeVsrPolicy(node, side = null, options = {}) {
  if (!node) {
    return {
      version: EXT_VERSION,
      ok: false,
      changed: false,
      reason: "missing_node",
      side,
    };
  }

  if (side != null && side !== "input" && side !== "output") {
    return {
      version: EXT_VERSION,
      ok: false,
      changed: false,
      reason: "invalid_side",
      nodeId: node.id,
      nodeType: node.type,
      side,
    };
  }

  const root = getNodePolicyRoot(node);
  const before = root ? JSON.parse(JSON.stringify(root)) : null;
  const hadRoot = !!root;
  const graph = node.graph || app.graph || app.canvas?.graph;
  const useHistory = options.history !== false;

  if (useHistory && typeof graph?.beforeChange === "function") {
    try { graph.beforeChange(node); } catch (_) {}
  }

  let changed = false;
  try {
    if (root) {
      if (side == null) {
        delete node.properties[POLICY_PROP];
        changed = true;
      } else if (Object.prototype.hasOwnProperty.call(root, side)) {
        delete root[side];
        changed = true;
        cleanupEmptyPolicyRoot(node);
      }
    }

    if (side == null || side === "output") {
      if (isOutputReorderSupported(node)) restoreVisualOutputOrder(node);
    }
    if (side == null || side === "input") {
      if (isInputReorderSupported(node)) restoreVisualInputOrder(node);
    }
  } finally {
    if (useHistory && typeof graph?.afterChange === "function") {
      try { graph.afterChange(node); } catch (_) {}
    }
  }

  if (changed) markDirty(node);

  const result = {
    version: EXT_VERSION,
    ok: true,
    changed: hadRoot && changed,
    nodeId: node.id,
    nodeType: node.type,
    title: node.title || node.type,
    side: side || "all",
    previousPolicy: before,
    policy: getNodePolicyRoot(node),
    inputSupported: isInputReorderSupported(node),
    inputReason: inputReorderUnsupportedReason(node),
    outputSupported: isOutputReorderSupported(node),
    outputReason: outputReorderUnsupportedReason(node),
  };

  console.info(`[${EXT_NAME}] clearNodeVsrPolicy`, result);
  return result;
}

function applySelectedNodePolicy(side, mode, options = {}) {
  const nodes = getSelectedOrHoveredNodes();
  const results = nodes.map(node => setNodeVsrPolicy(node, side, mode, options));
  const okCount = results.filter(result => result.ok).length;
  const changedCount = results.filter(result => result.changed).length;

  const report = {
    version: EXT_VERSION,
    action: `${mode}_${side}_reorder`,
    selectedNodes: nodes.length,
    okCount,
    changedCount,
    results,
  };

  console.info(`[${EXT_NAME}] applySelectedNodePolicy`, report);
  return report;
}

function clearSelectedNodeVsrPolicy(side = null, options = {}) {
  const nodes = getSelectedOrHoveredNodes();
  const results = nodes.map(node => clearNodeVsrPolicy(node, side, options));
  const okCount = results.filter(result => result.ok).length;
  const changedCount = results.filter(result => result.changed).length;

  const report = {
    version: EXT_VERSION,
    action: side ? `clear_${side}_policy` : "clear_all_policy",
    selectedNodes: nodes.length,
    okCount,
    changedCount,
    results,
  };

  console.info(`[${EXT_NAME}] clearSelectedNodeVsrPolicy`, report);
  return report;
}

function disableSelectedNodeInputReorder() {
  return applySelectedNodePolicy("input", "disabled");
}

function disableSelectedNodeOutputReorder() {
  return applySelectedNodePolicy("output", "disabled");
}

function enableSelectedNodeInputReorder() {
  return applySelectedNodePolicy("input", "enabled");
}

function enableSelectedNodeOutputReorder() {
  return applySelectedNodePolicy("output", "enabled");
}

function clearSelectedNodeInputVsrPolicy() {
  return clearSelectedNodeVsrPolicy("input");
}

function clearSelectedNodeOutputVsrPolicy() {
  return clearSelectedNodeVsrPolicy("output");
}

function buildNodeVsrPolicyReport(nodes = getSelectedOrHoveredNodes()) {
  const items = nodes.map(node => ({
    nodeId: node.id,
    nodeType: node.type,
    title: node.title || node.type,
    policy: getNodePolicyRoot(node),
    inputPolicy: sidePolicyLabel(node, "input"),
    outputPolicy: sidePolicyLabel(node, "output"),
    inputSupported: isInputReorderSupported(node),
    inputReason: inputReorderUnsupportedReason(node),
    outputSupported: isOutputReorderSupported(node),
    outputReason: outputReorderUnsupportedReason(node),
    inputStructuralReason: inputStructuralUnsupportedReason(node),
    outputStructuralReason: outputStructuralUnsupportedReason(node),
    inputMetadata: nodeOrderMetadataStatus(node, "input"),
    outputMetadata: nodeOrderMetadataStatus(node, "output"),
  }));

  return {
    version: EXT_VERSION,
    count: items.length,
    items,
  };
}

function reportNodeVsrPolicy(nodes = getSelectedOrHoveredNodes()) {
  const report = buildNodeVsrPolicyReport(nodes);
  console.info(`[${EXT_NAME}] node VSR policy report`, report);
  if (report.items.length) console.table?.(report.items.map(item => ({
    nodeId: item.nodeId,
    nodeType: item.nodeType,
    inputPolicy: item.inputPolicy,
    outputPolicy: item.outputPolicy,
    inputReorder: item.inputSupported ? "supported" : item.inputReason,
    outputReorder: item.outputSupported ? "supported" : item.outputReason,
    inputStructural: item.inputStructuralReason || "safe",
    outputStructural: item.outputStructuralReason || "safe",
    inputMetadata: item.inputMetadata,
    outputMetadata: item.outputMetadata,
  })));
  return report;
}


function inputStructuralUnsupportedReason(node) {
  if (!node) return "missing_node";
  if (!Array.isArray(node.inputs) || node.inputs.length < 2) return "less_than_two_inputs";

  const stats = inputSlotStatsForScan(node);
  if (stats.connectable < 2) return "less_than_two_connectable_inputs";

  const keys = inputKeys(node);
  if (keys.length !== node.inputs.length) return "invalid_input_keys";
  if (hasDuplicateKeys(keys)) return "duplicate_input_name_type";

  return null;
}

function duplicateKeyDetails(keys) {
  const counts = new Map();
  for (const key of keys || []) counts.set(key, (counts.get(key) || 0) + 1);
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({ key, label: keyLabel(key), count }));
}

function isEmptySlotValue(value) {
  return value == null || String(value).trim() === "";
}

function slotSideKeys(node, side) {
  return side === "input" ? inputKeys(node) : outputKeys(node);
}

function slotSideArray(node, side) {
  return side === "input" ? (node.inputs || []) : (node.outputs || []);
}

function scanSlotMetadata(node, side, issues, warnings) {
  const root = node?.properties?.[ORDER_PROP];
  if (!root || typeof root !== "object" || !Object.prototype.hasOwnProperty.call(root, side)) {
    return "none";
  }

  const description = describeSlotOrderEntry(node, side, root[side]);
  const label = `${description.format}:${description.reason}`;

  if (
    description.reason === "canonical_mismatch_current_node"
    || description.reason === "unknown_slot_order_format"
    || description.reason === "legacy_custom_or_mismatch"
  ) {
    issues.push(`metadata_${description.reason}`);
  }

  if (description.removable) warnings.push(`metadata_${description.reason}`);
  return label;
}

function scanSlotLinks(graph, node, side, issues, warnings) {
  const slots = slotSideArray(node, side);
  if (!slots.length) return;

  if (side === "input") {
    slots.forEach((slot, index) => {
      if (slot?.link == null) return;
      const link = findLink(graph, slot.link);
      if (!link) {
        issues.push(`input_${index}_missing_link:${slot.link}`);
        return;
      }
      if (link.target_id != null && node.id != null && String(link.target_id) !== String(node.id)) {
        issues.push(`input_${index}_link_target_node_mismatch:${slot.link}`);
      }
      if (link.target_slot != null && Number(link.target_slot) !== index) {
        warnings.push(`input_${index}_link_target_slot_mismatch:${slot.link}->${link.target_slot}`);
      }
    });
    return;
  }

  slots.forEach((slot, index) => {
    const links = Array.isArray(slot?.links) ? slot.links : [];
    links.forEach(linkId => {
      const link = findLink(graph, linkId);
      if (!link) {
        issues.push(`output_${index}_missing_link:${linkId}`);
        return;
      }
      if (link.origin_id != null && node.id != null && String(link.origin_id) !== String(node.id)) {
        issues.push(`output_${index}_link_origin_node_mismatch:${linkId}`);
      }
      if (link.origin_slot != null && Number(link.origin_slot) !== index) {
        warnings.push(`output_${index}_link_origin_slot_mismatch:${linkId}->${link.origin_slot}`);
      }
    });
  });
}

function scanNodeSlotSide(graph, node, side) {
  const slots = slotSideArray(node, side);
  const keys = slotSideKeys(node, side);
  const issues = [];
  const warnings = [];

  if (!Array.isArray(side === "input" ? node.inputs : node.outputs)) {
    issues.push(`${side}_slots_not_array`);
  }

  if (slots.length < 2) warnings.push(`less_than_two_${side}s`);

  slots.forEach((slot, index) => {
    if (isEmptySlotValue(slot?.name)) warnings.push(`${side}_${index}_empty_name`);
    if (isEmptySlotValue(slot?.type)) warnings.push(`${side}_${index}_empty_type`);
  });

  const duplicates = duplicateKeyDetails(keys);
  if (duplicates.length) issues.push(`duplicate_${side}_name_type`);

  const metadata = scanSlotMetadata(node, side, issues, warnings);
  scanSlotLinks(graph, node, side, issues, warnings);

  const policyReason = side === "input"
    ? inputReorderUnsupportedReason(node)
    : outputReorderUnsupportedReason(node);
  const structuralReason = side === "input"
    ? inputStructuralUnsupportedReason(node)
    : outputStructuralUnsupportedReason(node);

  const policySupported = policyReason == null;
  const structurallySupported = structuralReason == null && !issues.length;
  const inputStats = side === "input" ? inputSlotStatsForScan(node) : null;
  const visualPortCount = slotVisualPortCountForScan(node, side);
  const interesting = visualPortCount >= 2;

  let category = "not_interesting";
  if (issues.length) {
    category = "risky";
  } else if (policySupported) {
    category = interesting ? "enabled" : "not_interesting";
  } else if (interesting && structurallySupported) {
    category = "structurally_safe_disabled_by_policy";
  } else if (interesting) {
    category = "unsupported";
  }

  return {
    side,
    nodeId: node.id,
    nodeType: node.type,
    title: node.title || node.type,
    slotCount: slots.length,
    visualPortCount,
    connectableInputCount: inputStats?.connectable ?? null,
    widgetInputCount: inputStats?.widget ?? null,
    linkedInputCount: inputStats?.linked ?? null,
    policySupported,
    policyReason,
    structurallySupported,
    structuralReason,
    category,
    metadata,
    policyMode: sidePolicyLabel(node, side),
    policyExplicit: hasNodeSidePolicy(node, side),
    duplicateKeys: duplicates,
    warnings,
    issues,
    keys,
    slots: slots.map((slot, index) => formatSlotInfo(slot, index, side)),
  };
}

function buildWorkflowSafetyScanReport(graph = app.graph || app.canvas?.graph) {
  const nodes = graph?._nodes || [];
  const entries = [];

  for (const node of nodes) {
    if (!node || node.id == null) continue;
    entries.push(scanNodeSlotSide(graph, node, "input"));
    entries.push(scanNodeSlotSide(graph, node, "output"));
  }

  const interesting = entries.filter(entry => entry.visualPortCount >= 2);
  const risky = entries.filter(entry => entry.category === "risky");
  const enabled = entries.filter(entry => entry.category === "enabled");
  const policyDisabledSafe = entries.filter(entry => entry.category === "structurally_safe_disabled_by_policy");
  const warnings = entries.filter(entry => entry.warnings?.length && entry.category !== "not_interesting");

  const nodeTypeCounts = {};
  for (const node of nodes) nodeTypeCounts[node.type || "<unknown>"] = (nodeTypeCounts[node.type || "<unknown>"] || 0) + 1;

  return {
    version: EXT_VERSION,
    graphNodeCount: nodes.length,
    uniqueNodeTypes: Object.keys(nodeTypeCounts).length,
    nodeTypeCounts,
    totalSlotSides: entries.length,
    interestingSlotSides: interesting.length,
    enabledSlotSides: enabled.length,
    riskySlotSides: risky.length,
    // Kept as a compatibility field for existing console checks. Structural
    // auto-support does not produce pending candidate lists.
    safeInputCandidates: 0,
    policyDisabledSafeSides: policyDisabledSafe.length,
    warningSlotSides: warnings.length,
    entries,
    enabled,
    risky,
    candidates: [],
    policyDisabledSafe,
    warnings,
  };
}

function compactScanEntryLine(entry) {
  const title = entry.title && entry.title !== entry.nodeType ? ` (${entry.title})` : "";
  const reason = entry.issues?.length
    ? entry.issues.join(", ")
    : (entry.policyReason || entry.structuralReason || entry.category);
  const counts = entry.side === "input"
    ? `slots=${entry.slotCount} connectable=${entry.connectableInputCount ?? 0} widgets=${entry.widgetInputCount ?? 0}`
    : `slots=${entry.slotCount}`;
  return `#${entry.nodeId} ${entry.nodeType}${title} ${entry.side} ${counts} - ${reason}`;
}

function buildWorkflowSafetyScanSummary(report, includeDetails = true) {
  const lines = [
    `ComfyUI Visual Slot Reorder ${EXT_VERSION}`,
    "",
    "Workflow safety scan",
    "",
    `Nodes: ${report.graphNodeCount}`,
    `Unique node types: ${report.uniqueNodeTypes}`,
    `Slot sides with 2+ visual ports: ${report.interestingSlotSides}`,
    `Currently reorder-enabled sides: ${report.enabledSlotSides}`,
    `Risky sides detected: ${report.riskySlotSides}`,
    `Policy-blocked safe sides: ${report.policyDisabledSafeSides}`,
    `Warnings: ${report.warningSlotSides}`,
    "",
    "This scan is read-only. It does not change the workflow or permissions.",
  ];

  if (!includeDetails) return lines.join("\n");

  if (report.risky.length) {
    lines.push("", "Risky sides:");
    report.risky.slice(0, 30).forEach(entry => lines.push(`- ${compactScanEntryLine(entry)}`));
    if (report.risky.length > 30) lines.push(`- ... ${report.risky.length - 30} more`);
  } else {
    lines.push("", "Risky sides: none detected.");
  }

  if (report.policyDisabledSafe?.length) {
    lines.push("", "Policy-blocked but structurally safe sides:");
    report.policyDisabledSafe.slice(0, 30).forEach(entry => lines.push(`- ${compactScanEntryLine(entry)}`));
    if (report.policyDisabledSafe.length > 30) lines.push(`- ... ${report.policyDisabledSafe.length - 30} more`);
  }

  if (report.enabled.length) {
    lines.push("", "Currently enabled sides:");
    report.enabled.slice(0, 30).forEach(entry => lines.push(`- ${compactScanEntryLine(entry)}`));
    if (report.enabled.length > 30) lines.push(`- ... ${report.enabled.length - 30} more`);
  }

  return lines.join("\n");
}

function printWorkflowSafetyScanReport(report) {
  console.info(`[${EXT_NAME}] workflow safety scan`, {
    nodes: report.graphNodeCount,
    riskySlotSides: report.riskySlotSides,
    safeInputCandidates: report.safeInputCandidates,
    policyDisabledSafeSides: report.policyDisabledSafeSides,
    enabledSlotSides: report.enabledSlotSides,
  });

  const rows = report.entries
    .filter(entry => entry.visualPortCount >= 2 || entry.issues.length || entry.warnings.length)
    .map(entry => ({
      nodeId: entry.nodeId,
      nodeType: entry.nodeType,
      side: entry.side,
      slots: entry.slotCount,
      visualPorts: entry.visualPortCount,
      connectableInputs: entry.connectableInputCount,
      widgetInputs: entry.widgetInputCount,
      category: entry.category,
      policyMode: entry.policyMode,
      policy: entry.policySupported ? "supported" : entry.policyReason,
      structural: entry.structurallySupported ? "safe" : entry.structuralReason,
      issues: entry.issues.join(", "),
      warnings: entry.warnings.join(", "),
      metadata: entry.metadata,
    }));

  if (rows.length) console.table?.(rows);
  return report;
}

function reportWorkflowSafetyScan(graph = app.graph || app.canvas?.graph) {
  return printWorkflowSafetyScanReport(buildWorkflowSafetyScanReport(graph));
}

function showWorkflowSafetyScan() {
  const report = reportWorkflowSafetyScan();
  window.alert?.(buildWorkflowSafetyScanSummary(report, true));
  return report;
}

function buildWorkflowSafetyScanExportText(report) {
  return [
    buildWorkflowSafetyScanSummary(report, true),
    "",
    "JSON:",
    JSON.stringify(report, null, 2),
  ].join("\n");
}

async function copyWorkflowSafetyScanReport() {
  const report = reportWorkflowSafetyScan();
  const text = buildWorkflowSafetyScanExportText(report);
  return copyTextToClipboard(text, "VSR workflow safety scan");
}


/*
 * Compatibility policy report.
 * Read-only only: this does not create, edit, remove or apply any workflow policy.
 * It prepares the next local node-side policy step without introducing a global
 * not-allow list that would be difficult to maintain and too easy to over-apply.
 */
function compatibilityActionForScanEntry(entry) {
  const interesting = entry?.visualPortCount >= 2;

  if (entry?.category === "enabled") {
    return {
      group: "enabled",
      suggestedPolicy: "keep_auto",
      action: "No action. Reorder is already enabled by current rules.",
      riskLevel: "low",
    };
  }

  if (entry?.category === "risky") {
    return {
      group: "manual_review",
      suggestedPolicy: "disable_node_side_only_if_failure_confirmed",
      action: "Manual review required. If this side is confirmed to break reorder, disable only this node side, not the full node type.",
      riskLevel: "high",
    };
  }

  if (entry?.category === "structurally_safe_disabled_by_policy") {
    return {
      group: "policy_disabled_safe",
      suggestedPolicy: "local_policy_disabled",
      action: "Structurally safe but disabled by a local node-side policy stored in this workflow.",
      riskLevel: "medium",
    };
  }

  if (entry?.category === "unsupported" && interesting) {
    return {
      group: "manual_review",
      suggestedPolicy: "keep_disabled_until_tested",
      action: "Interesting side, but not currently supported. Keep disabled until a targeted test proves it safe.",
      riskLevel: "medium",
    };
  }

  return {
    group: "not_interesting",
    suggestedPolicy: "ignore",
    action: "No useful visual reorder target detected for this side.",
    riskLevel: "low",
  };
}

function buildCompatibilityPolicyReport(graph = app.graph || app.canvas?.graph) {
  const scan = buildWorkflowSafetyScanReport(graph);
  const entries = scan.entries.map(entry => {
    const decision = compatibilityActionForScanEntry(entry);
    const policyKey = `${entry.nodeType || "<unknown>"}:${entry.side}`;
    return {
      nodeId: entry.nodeId,
      nodeType: entry.nodeType,
      title: entry.title,
      side: entry.side,
      policyKey,
      category: entry.category,
      visualPortCount: entry.visualPortCount,
      slotCount: entry.slotCount,
      connectableInputCount: entry.connectableInputCount,
      widgetInputCount: entry.widgetInputCount,
      linkedInputCount: entry.linkedInputCount,
      metadata: entry.metadata,
      policyMode: entry.policyMode,
      policyExplicit: entry.policyExplicit,
      policySupported: entry.policySupported,
      policyReason: entry.policyReason,
      structurallySupported: entry.structurallySupported,
      structuralReason: entry.structuralReason,
      duplicateKeys: entry.duplicateKeys,
      warnings: entry.warnings,
      issues: entry.issues,
      suggestedPolicy: decision.suggestedPolicy,
      recommendedAction: decision.action,
      riskLevel: decision.riskLevel,
      group: decision.group,
      policyScope: "node-side",
    };
  });

  const enabled = entries.filter(entry => entry.group === "enabled");
  const policyDisabledSafe = entries.filter(entry => entry.group === "policy_disabled_safe");
  const manualReview = entries.filter(entry => entry.group === "manual_review");
  const potentialDisableCandidates = entries.filter(entry => entry.suggestedPolicy === "disable_node_side_only_if_failure_confirmed");
  const notInteresting = entries.filter(entry => entry.group === "not_interesting");
  const localPolicyEntries = entries.filter(entry => entry.policyExplicit);

  return {
    version: EXT_VERSION,
    readonly: true,
    policyMutations: 0,
    message: "Read-only compatibility report. It does not write node.properties, graph.extra, metadata, or local policies.",
    scanSummary: {
      graphNodeCount: scan.graphNodeCount,
      uniqueNodeTypes: scan.uniqueNodeTypes,
      totalSlotSides: scan.totalSlotSides,
      interestingSlotSides: scan.interestingSlotSides,
      enabledSlotSides: scan.enabledSlotSides,
      riskySlotSides: scan.riskySlotSides,
      safeInputCandidates: scan.safeInputCandidates,
      policyDisabledSafeSides: scan.policyDisabledSafeSides,
      warningSlotSides: scan.warningSlotSides,
    },
    counts: {
      enabled: enabled.length,
      policyDisabledSafe: policyDisabledSafe.length,
      manualReview: manualReview.length,
      potentialDisableCandidates: potentialDisableCandidates.length,
      notInteresting: notInteresting.length,
      localPolicyEntries: localPolicyEntries.length,
    },
    entries,
    enabled,
    policyDisabledSafe,
    manualReview,
    potentialDisableCandidates,
    localPolicyEntries,
    notInteresting,
  };
}

function compactCompatibilityEntryLine(entry) {
  const title = entry.title && entry.title !== entry.nodeType ? ` (${entry.title})` : "";
  const counts = entry.side === "input"
    ? `visualPorts=${entry.visualPortCount} connectable=${entry.connectableInputCount ?? 0} widgets=${entry.widgetInputCount ?? 0}`
    : `visualPorts=${entry.visualPortCount}`;
  const reason = entry.issues?.length
    ? entry.issues.join(", ")
    : (entry.policyReason || entry.structuralReason || entry.category);
  return `#${entry.nodeId} ${entry.nodeType}${title} ${entry.side} ${counts} - ${entry.suggestedPolicy} - ${reason}`;
}

function buildCompatibilityPolicySummary(report, includeDetails = true) {
  const lines = [
    `ComfyUI Visual Slot Reorder ${EXT_VERSION}`,
    "",
    "Compatibility policy report",
    "",
    `Nodes: ${report.scanSummary.graphNodeCount}`,
    `Unique node types: ${report.scanSummary.uniqueNodeTypes}`,
    `Slot sides with 2+ visual ports: ${report.scanSummary.interestingSlotSides}`,
    `Currently reorder-enabled sides: ${report.counts.enabled}`,
    `Policy-disabled safe sides: ${report.counts.policyDisabledSafe}`,
    `Manual review sides: ${report.counts.manualReview}`,
    `Potential local disable candidates: ${report.counts.potentialDisableCandidates}`,
    `Local policy entries: ${report.counts.localPolicyEntries}`,
    `Policy mutations: ${report.policyMutations}`,
    "",
    "This report is read-only. It does not change the workflow, permissions, metadata, or local policies.",
    "It is intended to review current structural support and workflow-local node-side policies.",
  ];

  if (!includeDetails) return lines.join("\n");

  if (report.localPolicyEntries.length) {
    lines.push("", "Active local node-side policies:");
    report.localPolicyEntries.slice(0, 30).forEach(entry => lines.push(`- #${entry.nodeId} ${entry.nodeType}${entry.title && entry.title !== entry.nodeType ? ` (${entry.title})` : ""} ${entry.side} - ${entry.policyMode}`));
    if (report.localPolicyEntries.length > 30) lines.push(`- ... ${report.localPolicyEntries.length - 30} more`);
  }

  if (report.potentialDisableCandidates.length) {
    lines.push("", "Potential local disable candidates after confirmed failure only:");
    report.potentialDisableCandidates.slice(0, 30).forEach(entry => lines.push(`- ${compactCompatibilityEntryLine(entry)}`));
    if (report.potentialDisableCandidates.length > 30) lines.push(`- ... ${report.potentialDisableCandidates.length - 30} more`);
  } else {
    lines.push("", "Potential local disable candidates: none detected.");
  }

  if (report.policyDisabledSafe.length) {
    lines.push("", "Policy-disabled but structurally safe sides:");
    report.policyDisabledSafe.slice(0, 30).forEach(entry => lines.push(`- ${compactCompatibilityEntryLine(entry)}`));
    if (report.policyDisabledSafe.length > 30) lines.push(`- ... ${report.policyDisabledSafe.length - 30} more`);
  }

  if (report.manualReview.length) {
    lines.push("", "Manual review sides:");
    report.manualReview.slice(0, 30).forEach(entry => lines.push(`- ${compactCompatibilityEntryLine(entry)}`));
    if (report.manualReview.length > 30) lines.push(`- ... ${report.manualReview.length - 30} more`);
  }

  if (report.enabled.length) {
    lines.push("", "Currently enabled sides:");
    report.enabled.slice(0, 30).forEach(entry => lines.push(`- ${compactCompatibilityEntryLine(entry)}`));
    if (report.enabled.length > 30) lines.push(`- ... ${report.enabled.length - 30} more`);
  }

  return lines.join("\n");
}

function printCompatibilityPolicyReport(report) {
  console.info(`[${EXT_NAME}] compatibility policy report`, {
    readonly: report.readonly,
    policyMutations: report.policyMutations,
    enabled: report.counts.enabled,
    policyDisabledSafe: report.counts.policyDisabledSafe,
    manualReview: report.counts.manualReview,
    potentialDisableCandidates: report.counts.potentialDisableCandidates,
    localPolicyEntries: report.counts.localPolicyEntries,
  });

  const rows = report.entries
    .filter(entry => entry.visualPortCount >= 2 || entry.group !== "not_interesting")
    .map(entry => ({
      nodeId: entry.nodeId,
      nodeType: entry.nodeType,
      side: entry.side,
      visualPorts: entry.visualPortCount,
      connectableInputs: entry.connectableInputCount,
      group: entry.group,
      suggestedPolicy: entry.suggestedPolicy,
      risk: entry.riskLevel,
      policy: entry.policySupported ? "supported" : entry.policyReason,
      structural: entry.structurallySupported ? "safe" : entry.structuralReason,
      issues: entry.issues.join(", "),
      warnings: entry.warnings.join(", "),
      metadata: entry.metadata,
    }));

  if (rows.length) console.table?.(rows);
  return report;
}

function reportCompatibilityPolicy(graph = app.graph || app.canvas?.graph) {
  return printCompatibilityPolicyReport(buildCompatibilityPolicyReport(graph));
}

function showCompatibilityPolicyReport() {
  const report = reportCompatibilityPolicy();
  window.alert?.(buildCompatibilityPolicySummary(report, true));
  return report;
}

function buildCompatibilityPolicyExportText(report) {
  return [
    buildCompatibilityPolicySummary(report, true),
    "",
    "JSON:",
    JSON.stringify(report, null, 2),
  ].join("\n");
}

async function copyCompatibilityPolicyReport() {
  const report = reportCompatibilityPolicy();
  const text = buildCompatibilityPolicyExportText(report);
  return copyTextToClipboard(text, "VSR compatibility policy report");
}

function installSlotOrderMetadataUI() {
  if (typeof document === "undefined" || !document.body) return;

  const rootId = "visual-slot-reorder-metadata-ui";
  const buttonId = "visual-slot-reorder-toolbar-button";
  const dividerId = "visual-slot-reorder-toolbar-divider";
  document.getElementById(rootId)?.remove();
  document.getElementById(buttonId)?.remove();
  document.getElementById(dividerId)?.remove();

  const root = document.createElement("div");
  root.id = rootId;
  root.style.cssText = [
    "position: fixed",
    "left: 0",
    "top: 0",
    "z-index: 1300",
    "font-family: inherit, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    "font-size: 12px",
    "line-height: 1",
    "color: var(--text-secondary-foreground, rgba(235,238,245,0.92))",
    "pointer-events: none",
  ].join(";");

  const panel = document.createElement("div");
  panel.style.cssText = [
    "display: none",
    "position: fixed",
    "padding: 9px",
    "min-width: 250px",
    "max-width: min(330px, calc(100vw - 20px))",
    "box-sizing: border-box",
    "border: 1px solid var(--border-interface-stroke, rgba(255,255,255,0.13))",
    "border-radius: 10px",
    "background: var(--bg-comfy-menu-bg, rgba(25,27,31,0.98))",
    "box-shadow: 0 8px 26px rgba(0,0,0,0.42)",
    "backdrop-filter: blur(6px)",
    "pointer-events: auto",
  ].join(";");

  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "false");
  dialog.style.cssText = [
    "display: none",
    "position: fixed",
    "left: 50%",
    "top: 50%",
    "transform: translate(-50%, -50%)",
    "width: min(760px, calc(100vw - 28px))",
    "max-height: min(78vh, 760px)",
    "box-sizing: border-box",
    "padding: 10px",
    "border: 1px solid var(--border-interface-stroke, rgba(255,255,255,0.13))",
    "border-radius: 12px",
    "background: var(--bg-comfy-menu-bg, rgba(25,27,31,0.99))",
    "box-shadow: 0 14px 44px rgba(0,0,0,0.50)",
    "backdrop-filter: blur(6px)",
    "pointer-events: auto",
  ].join(";");

  const dialogTitle = document.createElement("div");
  dialogTitle.style.cssText = [
    "font-weight: 600",
    "margin-bottom: 8px",
    "color: var(--text-secondary-foreground, rgba(245,249,255,0.96))",
    "line-height: 1.25",
  ].join(";");

  const dialogBody = document.createElement("pre");
  dialogBody.style.cssText = [
    "white-space: pre-wrap",
    "overflow: auto",
    "max-height: calc(min(78vh, 760px) - 92px)",
    "margin: 0",
    "padding: 8px",
    "box-sizing: border-box",
    "border-radius: 8px",
    "background: rgba(0,0,0,0.18)",
    "color: var(--text-secondary-foreground, rgba(235,238,245,0.92))",
    "font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
    "font-size: 11px",
    "line-height: 1.45",
  ].join(";");

  const dialogActions = document.createElement("div");
  dialogActions.style.cssText = [
    "display: flex",
    "gap: 7px",
    "justify-content: flex-end",
    "align-items: center",
    "flex-wrap: wrap",
    "margin-top: 9px",
  ].join(";");

  dialog.append(dialogTitle, dialogBody, dialogActions);

  const title = document.createElement("div");
  title.textContent = `ComfyUI Visual Slot Reorder ${EXT_VERSION}`;
  title.style.cssText = [
    "font-weight: 600",
    "margin-bottom: 8px",
    "color: var(--text-secondary-foreground, rgba(245,249,255,0.96))",
    "line-height: 1.25",
  ].join(";");

  const status = document.createElement("div");
  status.style.cssText = [
    "margin-bottom: 8px",
    "padding: 7px 8px",
    "border-radius: 8px",
    "background: rgba(255,255,255,0.045)",
    "color: var(--text-muted, rgba(205,212,226,0.92))",
    "line-height: 1.35",
    "white-space: pre-line",
  ].join(";");

  const makeButton = (label, titleText, handler, options = {}) => {
    const button = document.createElement("button");
    button.textContent = label;
    button.title = titleText;
    button.disabled = !!options.disabled;
    button.className = [
      "relative inline-flex items-center justify-center gap-2 cursor-pointer touch-manipulation whitespace-nowrap appearance-none border-none",
      "font-medium font-inter transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      "disabled:pointer-events-none disabled:opacity-50 text-secondary-foreground rounded-lg text-xs",
      "bg-comfy-menu-bg hover:bg-interface-button-hover-surface!",
    ].join(" ");
    button.style.cssText = [
      "display: flex",
      "align-items: center",
      options.compact ? "justify-content: center" : "justify-content: flex-start",
      options.compact ? "width: auto" : "width: 100%",
      "min-height: 30px",
      options.compact ? "margin: 0" : "margin: 5px 0",
      "padding: 6px 9px",
      "box-sizing: border-box",
      "border-radius: 8px",
      "text-align: left",
    ].join(";");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled) return;
      try {
        const result = handler();
        if (result && typeof result.catch === "function") {
          result.catch((error) => {
            console.error(`[${EXT_NAME}] metadata UI action failed`, error);
            window.alert?.(`ComfyUI Visual Slot Reorder error:\n\n${error?.message || error}`);
          });
        }
      }
      catch (error) {
        console.error(`[${EXT_NAME}] metadata UI action failed`, error);
        window.alert?.(`ComfyUI Visual Slot Reorder error:\n\n${error?.message || error}`);
      }
    });
    return button;
  };

  const closeDialog = () => {
    dialog.style.display = "none";
    dialogActions.replaceChildren();
  };

  const openDialog = (titleText, bodyText, actions = []) => {
    dialogTitle.textContent = titleText;
    dialogBody.textContent = bodyText;
    dialogActions.replaceChildren();

    for (const action of actions) {
      dialogActions.append(makeButton(
        action.label,
        action.title || action.label,
        action.handler,
        { compact: true, disabled: action.disabled },
      ));
    }

    dialog.style.display = "block";
  };

  const updateStatus = () => {
    status.textContent = [
      "Classic nodes: Shift + drag a supported port.",
      "Nodes 2.0 beta: Shift + drag or V + drag a supported port. Supported slots are highlighted on hover and during drag.",
      "Workflow execution keeps the canonical ComfyUI slot order."
    ].join("\n");
  };

  const openHelpDialog = () => {
    closePanel();
    openDialog("ComfyUI Visual Slot Reorder help", [
      "Normal use:",
      "- Classic nodes: hold Shift and drag a supported port.",
      "- Nodes 2.0 beta: hold Shift or V and drag a supported port. Hovered/dragged slots are highlighted.",
      "- Workflow execution and saved workflows keep the canonical ComfyUI slot order.",
      "- Inputs and outputs are supported automatically when their slot structure is safe.",
      "- Use Reset workflow visual order to restore default/canonical port order for the current workflow.",
      "- Use the node context menu reset for a single node when available.",
    ].join("\n"), [
      {
        label: "Close",
        handler: closeDialog,
      },
    ]);
  };

  const resetAllButton = makeButton(
    "Reset workflow visual order",
    "Restore default/canonical port order for the current workflow and remove VSR visual-order metadata after confirmation.",
    () => {
      const result = resetWorkflowVisualSlotOrderWithConfirmation();
      if (!result?.cancelled) updateStatus();
      return result;
    },
  );

  const helpButton = makeButton(
    "Help",
    "Show concise usage help.",
    openHelpDialog,
  );

  const note = document.createElement("div");
  note.textContent = "Classic: Shift + drag. Nodes 2.0 beta: Shift or V + drag. Use reset only to restore canonical port order.";
  note.style.cssText = [
    "margin-top: 7px",
    "color: var(--text-muted, rgba(190,198,212,0.88))",
    "line-height: 1.35",
  ].join(";");

  panel.append(title, status, resetAllButton, helpButton, note);
  root.append(panel, dialog);
  document.body.appendChild(root);

  let toggle = null;

  const setToggleActive = (active) => {
    if (!toggle) return;
    toggle.dataset.vsrActive = active ? "true" : "false";
    toggle.style.background = active
      ? "var(--bg-interface-panel-selected-surface, rgba(255,255,255,0.10))"
      : "var(--bg-comfy-menu-bg, transparent)";
  };

  const placePanel = () => {
    if (!toggle) return;
    const rect = toggle.getBoundingClientRect();
    const margin = 8;
    panel.style.display = "block";

    const panelRect = panel.getBoundingClientRect();
    const maxLeft = Math.max(margin, window.innerWidth - panelRect.width - margin);
    const preferredLeft = rect.right - panelRect.width;
    const left = Math.min(Math.max(margin, preferredLeft), maxLeft);
    const preferredTop = rect.top - panelRect.height - margin;
    const fallbackTop = rect.bottom + margin;
    const top = preferredTop >= margin
      ? preferredTop
      : Math.min(Math.max(margin, fallbackTop), Math.max(margin, window.innerHeight - panelRect.height - margin));

    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  };

  const closePanel = () => {
    panel.style.display = "none";
    setToggleActive(false);
  };

  const openPanel = () => {
    closeDialog();
    updateStatus();
    setToggleActive(true);
    placePanel();
  };

  const createVisualSlotReorderIcon = () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.style.pointerEvents = "none";
    svg.style.flexShrink = "0";

    const makePath = (d) => {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      return path;
    };

    // Lucide-like compact icon: slot rows + up/down reorder arrows.
    svg.append(
      makePath("M4 7h10"),
      makePath("M4 12h10"),
      makePath("M4 17h10"),
      makePath("M18 6v12"),
      makePath("m15 9 3-3 3 3"),
      makePath("m15 15 3 3 3-3"),
    );
    return svg;
  };

  const findCanvasToolbar = () => {
    return document.querySelector('[role="toolbar"][aria-label="Canvas Toolbar"]')
      || document.querySelector('[data-pc-name="buttongroup"][aria-label="Canvas Toolbar"]')
      || document.querySelector('[data-testid="toggle-minimap-button"]')?.closest('[role="toolbar"]');
  };

  const getToolbarButtonTemplate = () => {
    const toolbar = findCanvasToolbar();
    if (!toolbar) return null;
    return toolbar.querySelector('[data-testid="toggle-link-visibility-button"]')
      || toolbar.querySelector('[data-testid="toggle-minimap-button"]')
      || toolbar.querySelector('button[aria-label="Fit View (.)"]')
      || Array.from(toolbar.querySelectorAll("button")).at(-1)
      || null;
  };

  const makeNativeToolbarButton = () => {
    const template = getToolbarButtonTemplate();
    const button = template ? template.cloneNode(false) : document.createElement("button");

    button.id = buttonId;
    button.type = "button";
    button.title = "ComfyUI Visual Slot Reorder";
    button.setAttribute("aria-label", "ComfyUI Visual Slot Reorder");
    button.setAttribute("data-pd-tooltip", "true");
    button.removeAttribute("data-testid");
    button.removeAttribute("aria-pressed");
    button.removeAttribute("aria-expanded");
    button.removeAttribute("aria-haspopup");
    button.replaceChildren(createVisualSlotReorderIcon());

    if (!template) {
      button.className = [
        "relative inline-flex items-center justify-center gap-2 cursor-pointer touch-manipulation whitespace-nowrap appearance-none border-none",
        "font-medium font-inter transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([width]):not([height])]:size-4 [&_svg]:shrink-0",
        "text-secondary-foreground rounded-lg text-xs bg-comfy-menu-bg hover:bg-interface-button-hover-surface! p-0 w-8 h-8",
      ].join(" ");
      button.style.cssText = [
        "border-radius: 8px",
        "border-width: medium",
        "border-style: none",
        "border-color: currentcolor",
        "border-image: initial",
      ].join(";");
    }

    // Keep the native toolbar dimensions even if the cloned template came from a wider control.
    button.classList.remove("w-15");
    button.classList.add("w-8", "h-8", "p-0");
    button.style.width = "";
    button.style.height = "";
    button.style.minWidth = "";
    button.style.fontSize = "";
    button.style.fontWeight = "";
    button.style.letterSpacing = "";

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (panel.style.display === "none") openPanel();
      else closePanel();
    });
    return button;
  };

  const makeNativeDivider = () => {
    const divider = document.createElement("div");
    divider.id = dividerId;
    divider.className = "h-[27px] w-px self-center bg-node-divider";
    divider.style.cssText = [
      "height: 27px",
      "width: 1px",
      "align-self: center",
      "background: var(--bg-node-divider, rgba(255,255,255,0.12))",
    ].join(";");
    return divider;
  };

  const installInNativeToolbar = () => {
    const toolbar = findCanvasToolbar();
    if (!toolbar) return false;

    document.getElementById(buttonId)?.remove();
    document.getElementById(dividerId)?.remove();

    const divider = makeNativeDivider();
    toggle = makeNativeToolbarButton();
    toolbar.append(divider, toggle);
    return true;
  };

  const installFallbackFloatingButton = () => {
    if (toggle?.id === buttonId && document.body.contains(toggle)) return;
    document.getElementById(buttonId)?.remove();
    document.getElementById(dividerId)?.remove();

    toggle = makeNativeToolbarButton();
    toggle.style.position = "fixed";
    toggle.style.right = "10px";
    toggle.style.bottom = "8px";
    toggle.style.zIndex = "1300";
    document.body.appendChild(toggle);
  };

  if (!installInNativeToolbar()) {
    installFallbackFloatingButton();

    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      if (installInNativeToolbar() || attempts > 40) {
        window.clearInterval(timer);
      }
    }, 250);
  }

  const isPanelInteractionTarget = (target) => {
    return panel.contains(target) || dialog.contains(target) || !!toggle?.contains?.(target);
  };

  const closeAllFloatingUI = () => {
    closePanel();
    closeDialog();
  };

  const closePanelOnExternalPointer = (event) => {
    if (panel.style.display === "none" && dialog.style.display === "none") return;
    if (isPanelInteractionTarget(event.target)) return;
    closeAllFloatingUI();
  };

  const closePanelOnCanvasFocus = (event) => {
    if (panel.style.display === "none" && dialog.style.display === "none") return;
    if (isPanelInteractionTarget(event.target)) return;

    const canvasElement = app?.canvas?.canvas;
    const target = event.target;
    if (target === canvasElement || target?.tagName === "CANVAS") closeAllFloatingUI();
  };

  // Use capture phase because LiteGraph/ComfyUI may stop pointer events on the canvas
  // before they bubble to document. This only closes the VSR panel/dialog and never
  // prevents the native canvas event from continuing.
  document.addEventListener("pointerdown", closePanelOnExternalPointer, true);
  document.addEventListener("focusin", closePanelOnCanvasFocus, true);

  const canvasElement = app?.canvas?.canvas;
  canvasElement?.addEventListener?.("pointerdown", closePanelOnExternalPointer, true);

  window.addEventListener("resize", () => {
    if (panel.style.display !== "none") placePanel();
  });
}

function installSlotOrderMetadataTools() {
  const previous = window.ReorderNodes || {};

  window.ReorderNodes = {
    ...previous,
    version: EXT_VERSION,
    reportSlotOrderMetadata,
    cleanSlotOrderMetadata,
    showSlotOrderMetadataReport,
    copySlotOrderMetadataReport,
    cleanSlotOrderMetadataWithConfirmation,
    resetNodeVisualSlotOrder,
    resetNodeVisualSlotOrderWithConfirmation,
    resetWorkflowVisualSlotOrder,
    resetWorkflowVisualSlotOrderWithConfirmation,
    reportSelectedNodeInfo,
    showSelectedNodeInfo,
    copySelectedNodeInfo,
    setNodeVsrPolicy,
    clearNodeVsrPolicy,
    applySelectedNodePolicy,
    reportNodeVsrPolicy,
    disableSelectedNodeInputReorder,
    disableSelectedNodeOutputReorder,
    enableSelectedNodeInputReorder,
    enableSelectedNodeOutputReorder,
    clearSelectedNodeVsrPolicy,
    clearSelectedNodeInputVsrPolicy,
    clearSelectedNodeOutputVsrPolicy,
    buildWorkflowSafetyScanReport,
    reportWorkflowSafetyScan,
    showWorkflowSafetyScan,
    copyWorkflowSafetyScanReport,
    buildCompatibilityPolicyReport,
    reportCompatibilityPolicy,
    showCompatibilityPolicyReport,
    copyCompatibilityPolicyReport,
  };
  installNodes2DevTools();
}

app.registerExtension({
  name: EXT_NAME,

  async beforeRegisterNodeDef(nodeType) {
    installNodeContextMenuReset(nodeType);
  },

  async setup() {
    patchGraphSerialization();
    patchGraphConfigure();
    patchPromptExecution();
    installTransientStateCleanup();
    installNodes2DomDrag();
    installSlotOrderMetadataTools();
    installSlotOrderMetadataUI();

    for (const node of app.graph?._nodes || []) {
      installOnNode(node);
      if (isOutputReorderSupported(node)) restoreVisualOutputOrder(node);
      if (isInputReorderSupported(node)) restoreVisualInputOrder(node);
    }

    markDirty({ graph: app.graph });
  },

  async nodeCreated(node) {
    installOnNode(node);
  },
});

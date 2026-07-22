import { app } from "../../../scripts/app.js";

/*
 * ComfyUI Visual Slot Reorder - 1.0.0 maintenance companion
 *
 * Maintenance-only companion for ComfyUI Visual Slot Reorder stable builds.
 * Purpose: clean obsolete legacy __slot_order metadata safely, without adding
 * user-facing panels, popup reports, menu entries, clipboard actions, or noisy
 * startup logs.
 *
 * This file is console-only. It does not add buttons, panels, menu entries, popup reports, clipboard actions, or startup logs.
 */

const EXT_VERSION = "1.0.0";
const SEP = "\u001f";
const NS = "ComfyUI.VisualSlotReorder.Maintenance";
const DEV_NS = "legacyMetadata";

const SAFE_REMOVE_STATUSES = new Set([
  "remove_legacy_identity",
  "remove_empty_root",
  "remove_visual_equals_canonical",
]);

function getGraph() {
  return app?.graph || null;
}

function getGraphNodes() {
  const graph = getGraph();
  return graph?._nodes || graph?.nodes || [];
}

function ensureApi() {
  if (!window.ReorderNodes) window.ReorderNodes = {};
  return window.ReorderNodes;
}

function ensureDevApi(api) {
  if (!api.__dev || typeof api.__dev !== "object") {
    Object.defineProperty(api, "__dev", {
      value: {},
      configurable: true,
      enumerable: false,
      writable: true,
    });
  }
  if (!api.__dev[DEV_NS] || typeof api.__dev[DEV_NS] !== "object") {
    Object.defineProperty(api.__dev, DEV_NS, {
      value: {},
      configurable: true,
      enumerable: false,
      writable: true,
    });
  }
  return api.__dev[DEV_NS];
}

function slotKey(slot) {
  const name = String(slot?.name ?? slot?.localized_name ?? slot?.localizedName ?? "");
  const type = String(slot?.type ?? "");
  return `${name}${SEP}${type}`;
}

function sideSlots(node, side) {
  return side === "input" ? (node?.inputs || []) : (node?.outputs || []);
}

function currentKeys(node, side) {
  return sideSlots(node, side).map(slotKey);
}

function titleOf(node) {
  return node?.title || node?.properties?.["Node name for S&R"] || node?.type || "";
}

function sameArray(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const counts = new Map();
  for (const v of a) counts.set(v, (counts.get(v) || 0) + 1);
  for (const v of b) {
    const count = counts.get(v) || 0;
    if (count <= 0) return false;
    if (count === 1) counts.delete(v);
    else counts.set(v, count - 1);
  }
  return counts.size === 0;
}

function isIdentityIndexArray(order, slotCount) {
  return Array.isArray(order) && order.length === slotCount && order.every((v, i) => v === i);
}

function isValidIndexPermutation(order, slotCount) {
  if (!Array.isArray(order) || order.length !== slotCount) return false;
  const seen = new Set();
  for (const value of order) {
    if (!Number.isInteger(value) || value < 0 || value >= slotCount || seen.has(value)) return false;
    seen.add(value);
  }
  return seen.size === slotCount;
}

function classifyModernSide(node, side, meta) {
  const keys = currentKeys(node, side);
  const canonical = Array.isArray(meta?.canonical) ? meta.canonical.slice() : null;
  const visual = Array.isArray(meta?.visual) ? meta.visual.slice() : null;

  if (!canonical || !visual) {
    return {
      format: "modern_v1_incomplete",
      status: "manual_review_unknown_format",
      removable: false,
      reason: "missing_canonical_or_visual",
      currentKeys: keys,
      canonical,
      visual,
    };
  }

  if (!sameSet(canonical, visual)) {
    return {
      format: "modern_v1",
      status: "manual_review_inconsistent_metadata",
      removable: false,
      reason: "canonical_visual_key_set_mismatch",
      currentKeys: keys,
      canonical,
      visual,
    };
  }

  if (!sameSet(keys, canonical)) {
    return {
      format: "modern_v1",
      status: "manual_review_slot_mismatch",
      removable: false,
      reason: "current_slots_do_not_match_metadata_keys",
      currentKeys: keys,
      canonical,
      visual,
    };
  }

  if (sameArray(canonical, visual)) {
    return {
      format: "modern_v1",
      status: "remove_visual_equals_canonical",
      removable: true,
      reason: "visual_equals_canonical",
      currentKeys: keys,
      canonical,
      visual,
    };
  }

  return {
    format: "modern_v1",
    status: "keep_modern_custom",
    removable: false,
    reason: "custom_visual_order",
    currentKeys: keys,
    canonical,
    visual,
  };
}

function classifyLegacyArraySide(node, side, order) {
  const slots = sideSlots(node, side);
  const keys = currentKeys(node, side);

  if (!isValidIndexPermutation(order, slots.length)) {
    return {
      format: "legacy_index_array",
      status: "manual_review_slot_mismatch",
      removable: false,
      reason: "invalid_or_mismatched_legacy_index_array",
      currentKeys: keys,
      legacyOrder: Array.isArray(order) ? order.slice() : order,
    };
  }

  if (isIdentityIndexArray(order, slots.length)) {
    return {
      format: "legacy_index_array",
      status: "remove_legacy_identity",
      removable: true,
      reason: "legacy_identity_order",
      currentKeys: keys,
      legacyOrder: order.slice(),
    };
  }

  return {
    format: "legacy_index_array",
    status: "keep_legacy_custom_recoverable",
    removable: false,
    reason: "legacy_custom_order_recoverable",
    currentKeys: keys,
    legacyOrder: order.slice(),
  };
}

function classifySide(node, side, sideMeta) {
  if (Array.isArray(sideMeta)) return classifyLegacyArraySide(node, side, sideMeta);

  if (sideMeta && typeof sideMeta === "object" && Array.isArray(sideMeta.canonical) && Array.isArray(sideMeta.visual)) {
    return classifyModernSide(node, side, sideMeta);
  }

  if (sideMeta && typeof sideMeta === "object" && Number(sideMeta.version) === 1) {
    return classifyModernSide(node, side, sideMeta);
  }

  return {
    format: typeof sideMeta,
    status: "manual_review_unknown_format",
    removable: false,
    reason: "unknown_side_metadata_format",
    currentKeys: currentKeys(node, side),
    rawType: Object.prototype.toString.call(sideMeta),
  };
}

function buildLegacySlotOrderMetadataReport() {
  const nodes = getGraphNodes();
  const entries = [];

  for (const node of nodes) {
    const root = node?.properties?.__slot_order;
    if (root == null) continue;

    if (!root || typeof root !== "object" || Array.isArray(root)) {
      entries.push({
        nodeId: node.id,
        nodeType: node.type,
        title: titleOf(node),
        side: "root",
        format: Array.isArray(root) ? "legacy_root_array" : typeof root,
        status: "manual_review_unknown_format",
        removable: false,
        reason: "unknown_slot_order_root_format",
      });
      continue;
    }

    const rootKeys = Object.keys(root);
    const hasInput = Object.prototype.hasOwnProperty.call(root, "input");
    const hasOutput = Object.prototype.hasOwnProperty.call(root, "output");

    if (!hasInput && !hasOutput) {
      if (rootKeys.length === 0) {
        entries.push({
          nodeId: node.id,
          nodeType: node.type,
          title: titleOf(node),
          side: "root",
          format: "empty_root",
          status: "remove_empty_root",
          removable: true,
          reason: "empty_slot_order_root",
        });
      } else {
        entries.push({
          nodeId: node.id,
          nodeType: node.type,
          title: titleOf(node),
          side: "root",
          format: "unknown_root_keys",
          status: "manual_review_unknown_format",
          removable: false,
          reason: "slot_order_root_has_no_input_output_but_has_unknown_keys",
          rootKeys,
        });
      }
      continue;
    }

    for (const side of ["input", "output"]) {
      if (!Object.prototype.hasOwnProperty.call(root, side)) continue;
      const classified = classifySide(node, side, root[side]);
      entries.push({
        nodeId: node.id,
        nodeType: node.type,
        title: titleOf(node),
        side,
        ...classified,
      });
    }
  }

  const counts = {
    totalEntries: entries.length,
    removableEntries: entries.filter(e => e.removable).length,
    safeRemovableEntries: entries.filter(e => e.removable && SAFE_REMOVE_STATUSES.has(e.status)).length,
    manualReviewEntries: entries.filter(e => String(e.status || "").startsWith("manual_review")).length,
    keepModernCustom: entries.filter(e => e.status === "keep_modern_custom").length,
    keepLegacyCustomRecoverable: entries.filter(e => e.status === "keep_legacy_custom_recoverable").length,
    removeLegacyIdentity: entries.filter(e => e.status === "remove_legacy_identity").length,
    removeEmptyRoot: entries.filter(e => e.status === "remove_empty_root").length,
    removeVisualEqualsCanonical: entries.filter(e => e.status === "remove_visual_equals_canonical").length,
  };

  return {
    version: EXT_VERSION,
    readonly: true,
    graphNodeCount: nodes.length,
    counts,
    entries,
  };
}

function compactStatus(report = buildLegacySlotOrderMetadataReport()) {
  return {
    version: EXT_VERSION,
    graphNodeCount: report.graphNodeCount,
    totalEntries: report.counts.totalEntries,
    safeRemovableEntries: report.counts.safeRemovableEntries,
    manualReviewEntries: report.counts.manualReviewEntries,
    keptModernCustom: report.counts.keepModernCustom,
    keptLegacyCustomRecoverable: report.counts.keepLegacyCustomRecoverable,
    cleanable: report.counts.safeRemovableEntries > 0 && report.counts.manualReviewEntries === 0,
  };
}

function formatLegacySlotOrderMetadataReport(report) {
  const lines = [];
  lines.push(`ComfyUI Visual Slot Reorder ${EXT_VERSION}`);
  lines.push("");
  lines.push("Legacy slot order metadata maintenance report");
  lines.push("");
  lines.push(`Nodes: ${report.graphNodeCount}`);
  lines.push(`Total metadata entries: ${report.counts.totalEntries}`);
  lines.push(`Safe removable entries: ${report.counts.safeRemovableEntries}`);
  lines.push(`Manual review entries: ${report.counts.manualReviewEntries}`);
  lines.push(`Modern custom orders kept: ${report.counts.keepModernCustom}`);
  lines.push(`Legacy custom recoverable kept: ${report.counts.keepLegacyCustomRecoverable}`);

  const groups = new Map();
  for (const entry of report.entries) {
    if (!groups.has(entry.status)) groups.set(entry.status, []);
    groups.get(entry.status).push(entry);
  }

  for (const [status, items] of groups) {
    lines.push("");
    lines.push(`${status}: ${items.length}`);
    for (const entry of items) {
      lines.push(`- #${entry.nodeId} ${entry.nodeType} (${entry.title}) ${entry.side} - ${entry.reason} - ${entry.format}`);
    }
  }

  return lines.join("\n");
}

function reportLegacySlotOrderMetadata(options = {}) {
  const verbose = !!options?.verbose;
  const report = buildLegacySlotOrderMetadataReport();
  const status = compactStatus(report);

  if (verbose) {
    console.groupCollapsed(`[${NS}] legacy metadata maintenance report`);
    console.log(status);
    console.table(report.entries.map(e => ({
      nodeId: e.nodeId,
      nodeType: e.nodeType,
      side: e.side,
      status: e.status,
      removable: e.removable,
      format: e.format,
      reason: e.reason,
    })));
    console.groupEnd();
  } else {
    console.info(`[${NS}] legacy metadata status`, status);
  }

  return report;
}

function getNodeById(nodeId) {
  return getGraphNodes().find(node => node?.id === nodeId) || null;
}

function rootIsEmptyObject(root) {
  return !!root && typeof root === "object" && !Array.isArray(root) && Object.keys(root).length === 0;
}

function removeEntry(entry) {
  const node = getNodeById(entry.nodeId);
  if (!node?.properties) return { ok: false, reason: "missing_node_or_properties", entry };

  const root = node.properties.__slot_order;
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return { ok: false, reason: "missing_or_invalid_slot_order_root", entry };
  }

  if (entry.side === "root" && entry.status === "remove_empty_root") {
    if (rootIsEmptyObject(root)) {
      delete node.properties.__slot_order;
      return { ok: true, reason: "removed_empty_root", entry };
    }
    return { ok: false, reason: "root_no_longer_empty", entry };
  }

  if ((entry.side === "input" || entry.side === "output") && Object.prototype.hasOwnProperty.call(root, entry.side)) {
    delete root[entry.side];
    if (rootIsEmptyObject(root)) delete node.properties.__slot_order;
    return { ok: true, reason: `removed_${entry.side}_metadata`, entry };
  }

  return { ok: false, reason: "target_side_not_found", entry };
}

function markGraphDirty() {
  const graph = getGraph();
  try { graph?.setDirtyCanvas?.(true, true); } catch (_) {}
  try { app?.canvas?.setDirty?.(true, true); } catch (_) {}
  try { app?.canvas?.draw?.(true, true); } catch (_) {}
}

function cleanLegacySlotOrderMetadata(options = {}) {
  const dryRun = !!options?.dryRun;
  const verbose = !!options?.verbose;
  const beforeReport = buildLegacySlotOrderMetadataReport();
  const safeEntries = beforeReport.entries.filter(e => e.removable && SAFE_REMOVE_STATUSES.has(e.status));
  const blockedEntries = beforeReport.entries.filter(e => e.removable && !SAFE_REMOVE_STATUSES.has(e.status));

  const result = {
    version: EXT_VERSION,
    dryRun,
    ok: true,
    before: compactStatus(beforeReport),
    safeRemovalCount: safeEntries.length,
    blockedRemovalCount: blockedEntries.length,
    removedCount: 0,
    failedCount: 0,
    after: null,
    removed: verbose ? [] : undefined,
    failed: verbose ? [] : undefined,
  };

  if (beforeReport.counts.manualReviewEntries > 0) {
    result.ok = false;
    result.reason = "manual_review_entries_present";
    console.warn(`[${NS}] cleanup blocked`, result);
    return result;
  }

  if (dryRun) {
    console.info(`[${NS}] dry-run cleanup`, result);
    return result;
  }

  const graph = getGraph();
  try { graph?.beforeChange?.(); } catch (_) {}

  const removed = [];
  const failed = [];
  for (const entry of safeEntries) {
    const output = removeEntry(entry);
    if (output.ok) removed.push(output);
    else failed.push(output);
  }

  try { graph?.afterChange?.(); } catch (_) {}
  markGraphDirty();

  const afterReport = buildLegacySlotOrderMetadataReport();
  result.after = compactStatus(afterReport);
  result.removedCount = removed.length;
  result.failedCount = failed.length;
  result.ok = failed.length === 0 && afterReport.counts.manualReviewEntries === 0;

  if (verbose) {
    result.removed = removed;
    result.failed = failed;
    console.groupCollapsed(`[${NS}] cleanup result`);
    console.log(result);
    if (removed.length) console.table(removed.map(item => ({
      nodeId: item.entry.nodeId,
      nodeType: item.entry.nodeType,
      side: item.entry.side,
      status: item.entry.status,
      reason: item.reason,
    })));
    if (failed.length) console.warn(`[${NS}] failed removals`, failed);
    console.groupEnd();
  } else {
    console.info(`[${NS}] cleanup result`, {
      ok: result.ok,
      removedCount: result.removedCount,
      failedCount: result.failedCount,
      after: result.after,
    });
  }

  return result;
}

function dryRunCleanLegacySlotOrderMetadata(options = {}) {
  return cleanLegacySlotOrderMetadata({ ...options, dryRun: true });
}

app.registerExtension({
  name: "ComfyUI.VisualSlotReorder.MaintenanceConsoleOnly",
  async setup() {
    const api = ensureApi();

    // Minimal console-only public API. No popup report, no clipboard helper, no UI menu.
    api.getLegacySlotOrderMetadataStatus = () => compactStatus(buildLegacySlotOrderMetadataReport());
    api.reportLegacySlotOrderMetadata = reportLegacySlotOrderMetadata;
    api.dryRunCleanLegacySlotOrderMetadata = dryRunCleanLegacySlotOrderMetadata;
    api.cleanLegacySlotOrderMetadata = cleanLegacySlotOrderMetadata;

    // Advanced maintenance functions are intentionally hidden under a non-enumerable dev namespace.
    const dev = ensureDevApi(api);
    dev.buildLegacySlotOrderMetadataReport = buildLegacySlotOrderMetadataReport;
    dev.formatLegacySlotOrderMetadataReport = formatLegacySlotOrderMetadataReport;
    dev.safeRemoveStatuses = Array.from(SAFE_REMOVE_STATUSES);
  },
});

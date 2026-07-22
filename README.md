# ComfyUI Visual Slot Reorder - Nodes 2 Compat

First public release: `1.0.0`.

ComfyUI Visual Slot Reorder is a frontend-only ComfyUI extension that lets you visually reorder supported node input and output ports. Its goal is to make large workflows easier to read without changing how the workflow executes.

This build supports both ComfyUI renderers:

- Classic LiteGraph renderer.
- Nodes 2.0 beta DOM renderer.

The extension stores a visual port order separately from ComfyUI's canonical slot order. Before prompt generation and workflow serialization, it restores the canonical order, then restores the visual order for the canvas. Existing slot indices, links, workflow execution, save/load behavior, and queue prompt behavior are preserved.

## Features

- Visual reorder for supported input and output ports.
- Classic renderer shortcut: `Shift + drag` on a supported port.
- Nodes 2.0 shortcut: `Shift + drag` or `V + drag` on a supported slot.
- Compact visual highlight in Classic and Nodes 2.0 modes.
- Links follow the visual slot position without changing the logical workflow connection.
- Structural safety checks instead of a global node allowlist.
- Local workflow-side disable policies through `node.properties.__vsr_policy`.
- Minimal final VSR panel with Reset and Help only.
- Public API kept small and stable.
- Advanced diagnostic tools kept under `window.ReorderNodes.__dev`.

## Installation

Copy the extension folder into your ComfyUI `custom_nodes` directory:

```text
ComfyUI/custom_nodes/ComfyUI-Visual-Slot-Reorder-Nodes2-Compat/
```

Then restart ComfyUI completely.

For ComfyUI Desktop on Windows, fully close and reopen the application. The Desktop frontend can keep cached JavaScript files until the application is restarted.

For ComfyUI Portable on Windows, copy the folder into the portable `ComfyUI/custom_nodes` directory, then restart using the portable launcher.

Do not install this package at the same time as another Visual Slot Reorder package. Keep only one active VSR extension folder in `custom_nodes`.

## Included files

```text
__init__.py
pyproject.toml
LICENSE.txt
.comfyignore
README.md
js/reorder_nodes.js
js/reorder_nodes_maintenance_tools.js
js/reorder_nodes_public_api_cleanup.js
```

`CHANGELOG.md` is intentionally not included in this first public release. A changelog becomes useful after public distribution, for example when publishing later bug-fix or feature versions such as `1.0.1` or `1.1.0`.

## Usage

1. Open a workflow.
2. Hover a supported input or output port.
3. Hold the relevant shortcut.
4. Drag the port vertically to the desired visual position.
5. Release the mouse button.
6. Save the workflow to keep the visual order.

Shortcuts:

```text
Classic renderer:
Shift + drag

Nodes 2.0 beta renderer:
Shift + drag
or
V + drag
```

The VSR button opens a minimal panel with:

- Reset visual order for the workflow.
- Help.

Node context menus may also expose reset actions when a node contains VSR visual order metadata.

## Safety model

Visual Slot Reorder is designed to affect visual organization only.

The extension does not intentionally modify:

- ComfyUI execution order.
- Slot indices used by the workflow.
- Link IDs.
- Prompt generation logic.
- Workflow serialization logic.
- Backend Python execution.

A side of a node is reorderable only when it passes structural checks:

- It has at least two useful visual ports.
- Port keys are stable.
- Port keys do not collide.
- The side is not disabled by local workflow policy.
- For inputs, widget-backed entries are not treated as real connectable ports unless they are currently linked.

The stable slot key is:

```text
name + "\\u001f" + type
```

If a node side is ambiguous, dynamic, duplicated, or unsafe, VSR does not enable visual reorder for that side.

## Workflow metadata

Visual order is stored inside the workflow in node properties:

```js
node.properties.__slot_order
```

Local VSR policies are stored in:

```js
node.properties.__vsr_policy
```

These properties are only used by Visual Slot Reorder. Reset actions can remove the visual order metadata from selected nodes or from the whole workflow.

## Public API

The visible root API is intentionally minimal:

```js
Object.keys(window.ReorderNodes).sort()
```

Expected result:

```text
resetNodeVisualSlotOrder
resetNodeVisualSlotOrderWithConfirmation
resetWorkflowVisualSlotOrder
resetWorkflowVisualSlotOrderWithConfirmation
version
```

Version check:

```js
window.ReorderNodes?.version
```

Advanced diagnostics and maintenance tools are intentionally hidden from normal enumeration and grouped under:

```js
window.ReorderNodes.__dev
```

Useful diagnostic commands:

```js
window.ReorderNodes.__dev.nodes2.getStatus()
window.ReorderNodes.__dev.diagnostics.reportWorkflowSafetyScan()
window.ReorderNodes.__dev.diagnostics.reportWorkflowCompatibility()
```

## Registry metadata to edit before publishing

Before publishing to ComfyUI Registry, edit `pyproject.toml` and replace the placeholder values:

```toml
Repository = "https://github.com/YOUR_USERNAME/ComfyUI-Visual-Slot-Reorder-Nodes2-Compat"
Documentation = "https://github.com/YOUR_USERNAME/ComfyUI-Visual-Slot-Reorder-Nodes2-Compat#readme"
"Bug Tracker" = "https://github.com/YOUR_USERNAME/ComfyUI-Visual-Slot-Reorder-Nodes2-Compat/issues"
PublisherId = "YOUR_PUBLISHER_ID"
Icon = ""
```

Use your real repository URL, your real Comfy Registry publisher ID, and optionally a square icon URL.

## Compatibility notes

### Classic LiteGraph renderer

The classic renderer uses LiteGraph canvas hooks for interaction and compact highlight drawing. The shortcut is `Shift + drag`.

### Nodes 2.0 beta renderer

Nodes 2.0 uses DOM/Vue node rendering. This extension adds a targeted DOM interaction layer for `.lg-slot` elements under `[data-node-id]`.

In Nodes 2.0, the shortcuts are:

```text
Shift + drag
V + drag
```

The DOM layer only captures pointer events after confirming that the drag starts on a supported slot. Normal node movement, link creation, and link reconnection remain native ComfyUI behaviors when the shortcut is not active.

## Troubleshooting

### The VSR button does not appear

Restart ComfyUI completely. For Desktop, close and reopen the application. For Portable, restart from the portable launcher.

### A port does not highlight or drag

The node side may not be considered safe for visual reorder. This can happen with a single port, duplicate `name + type` keys, ambiguous dynamic slots, unsupported widget-backed inputs, or a local disabled policy.

### Nodes 2.0 drag does not work

Check the status object:

```js
console.log(window.ReorderNodes?.__dev?.nodes2?.getStatus?.());
```

Expected indicators include:

```text
domLayerInstalled: true
nodes2DomDetected: true
```

### Links look wrong after moving a port

Save the workflow, reload it, then run:

```js
window.ReorderNodes.__dev.diagnostics.reportWorkflowSafetyScan()
```

Reset the visual order if needed from the VSR panel.

### Workflow execution fails after visual reorder

Use Reset visual order, save, reload, and retest. If the problem remains, report the node type, the renderer mode, and a minimal workflow.

## Development notes

This package is frontend-only:

- `WEB_DIRECTORY = "./js"` exposes the JavaScript extension files.
- No backend Python nodes are registered.
- No runtime dependency installation is performed.
- No network calls are required by the extension.
- No workflow execution logic is intentionally changed.

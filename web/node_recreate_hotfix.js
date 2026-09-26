import { app } from "/scripts/app.js";

const FIX_NODE_LABEL = "Fix node (recreate)";
const PATCH_FLAG = "_goohaiInPlaceNodeRecreateInstalled";

function getLink(graph, linkId) {
    return graph.getLink?.(linkId) ?? graph.links?.get?.(linkId) ?? graph.links?.[linkId];
}

function findSlot(slots, oldSlot, oldIndex, used) {
    let index = slots.findIndex((slot, i) => !used.has(i) && slot.name === oldSlot.name);
    if (index < 0 && slots[oldIndex] && !used.has(oldIndex) && slots[oldIndex].type === oldSlot.type) index = oldIndex;
    if (index < 0) index = slots.findIndex((slot, i) => !used.has(i) && slot.type === oldSlot.type);
    if (index >= 0) used.add(index);
    return index;
}

function ensureInput(oldInput, newNode) {
    if (oldInput.widget) {
        const name = oldInput.widget.name ?? oldInput.name;
        const widget = newNode.widgets?.find((item) => item.name === name);
        if (widget && typeof newNode.convertWidgetToInput === "function") {
            try { newNode.convertWidgetToInput(widget); } catch { /* best effort */ }
        }
    }
    if (!newNode.inputs?.some((input) => input.name === oldInput.name || input.type === oldInput.type) && typeof newNode.addInput === "function") {
        const options = { ...oldInput };
        delete options.link;
        delete options.widget;
        newNode.addInput(oldInput.name, oldInput.type, options);
    }
}

function ensureOutput(oldOutput, newNode) {
    if (!newNode.outputs?.some((output) => output.name === oldOutput.name || output.type === oldOutput.type) && typeof newNode.addOutput === "function") {
        const options = { ...oldOutput };
        delete options.links;
        newNode.addOutput(oldOutput.name, oldOutput.type, options);
    }
}

function connectWithChange(graph, connect) {
    graph.beforeChange?.();
    let link;
    try {
        link = connect();
    } catch (error) {
        graph.afterChange?.();
        throw error;
    }
    if (!link) graph.afterChange?.();
    return link;
}

function collectConnections(oldNode, graph) {
    const connections = [];
    for (const [oldIndex, input] of (oldNode.inputs ?? []).entries()) {
        if (input.link == null) continue;
        const link = getLink(graph, input.link);
        if (link) connections.push({ direction: "input", oldIndex, slot: input, link: { ...link } });
    }
    for (const [oldIndex, output] of (oldNode.outputs ?? []).entries()) {
        for (const linkId of output.links ?? []) {
            const link = getLink(graph, linkId);
            if (link) connections.push({ direction: "output", oldIndex, slot: output, link: { ...link } });
        }
    }
    return connections;
}

function reconnect(newNode, connections, graph) {
    const inputUsed = new Set();
    const outputSlots = new Map();
    for (const item of connections) {
        if (item.direction === "input") {
            ensureInput(item.slot, newNode);
            const newIndex = findSlot(newNode.inputs ?? [], item.slot, item.oldIndex, inputUsed);
            const source = graph.getNodeById?.(item.link.origin_id);
            if (newIndex >= 0 && source) {
                connectWithChange(graph, () => source.connect(item.link.origin_slot, newNode, newIndex));
            }
        } else {
            ensureOutput(item.slot, newNode);
            let newIndex = outputSlots.get(item.oldIndex);
            if (newIndex == null) {
                newIndex = findSlot(newNode.outputs ?? [], item.slot, item.oldIndex, new Set(outputSlots.values()));
                if (newIndex >= 0) outputSlots.set(item.oldIndex, newIndex);
            }
            const target = graph.getNodeById?.(item.link.target_id);
            if (newIndex >= 0 && target) {
                connectWithChange(graph, () => newNode.connect(newIndex, target, item.link.target_slot));
            }
        }
    }
}

function selectReplacement(canvas, newNode, wasSelected) {
    if (!canvas) return;
    if (wasSelected) canvas.selectNode?.(newNode, true);
}

function recreateNode(oldNode, nodeType) {
    const graph = oldNode.graph ?? app.canvas?.graph;
    if (!graph) return;
    const className = nodeType.comfyClass ?? oldNode.constructor?.comfyClass ?? oldNode.type;
    const newNode = LiteGraph.createNode(className);
    if (!newNode) return;

    const connections = collectConnections(oldNode, graph);
    const oldId = oldNode.id;
    const oldPos = [...oldNode.pos];
    const wasSelected = app.canvas?.selectedItems?.has?.(oldNode) || !!app.canvas?.selected_nodes?.[oldId];
    try {
        graph.beforeChange?.();
        // Keep the fresh node's initialization color. Do not copy color/bgcolor.
        graph.remove(oldNode);
        newNode.id = oldId;
        newNode.pos = oldPos;
        graph.add(newNode);
        reconnect(newNode, connections, graph);
        selectReplacement(app.canvas, newNode, wasSelected);
        graph.afterChange?.(newNode);
        graph.change?.();
        app.canvas?.setDirty?.(true, true);
        requestAnimationFrame(() => app.canvas?.setDirty?.(true, true));
    } catch (error) {
        console.error(`[Goohai Node Recreate Hotfix] Failed to recreate '${oldNode.type}':`, error);
    }
}

function patchNodeType(nodeType) {
    const prototype = nodeType?.prototype;
    if (!prototype || Object.prototype.hasOwnProperty.call(prototype, PATCH_FLAG)) return;
    const original = prototype.getExtraMenuOptions;
    prototype.getExtraMenuOptions = function (...args) {
        const result = original?.apply(this, args);
        const options = args[1] ?? result;
        if (Array.isArray(options)) {
            for (const option of options) {
                if (option?.content === FIX_NODE_LABEL) option.callback = () => recreateNode(this, nodeType);
            }
        }
        return result;
    };
    Object.defineProperty(prototype, PATCH_FLAG, { value: true });
}

app.registerExtension({
    name: "Comfy.GoohaiNodeRecreateHotfix",
    beforeRegisterNodeDef(nodeType) {
        setTimeout(() => patchNodeType(nodeType), 0);
    },
    setup() {
        for (const nodeType of Object.values(LiteGraph.registered_node_types ?? {})) patchNodeType(nodeType);
    },
});

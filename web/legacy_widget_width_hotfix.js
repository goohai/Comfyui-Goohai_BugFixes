import { app } from "/scripts/app.js";

const PATCH_FLAG = "_goohaiLegacyWidgetWidthHotfix";

function isMainLegacyCanvas(ctx) {
    const canvas = ctx?.canvas;
    return canvas instanceof HTMLCanvasElement && canvas === app.canvas?.canvas;
}

function restoreWidgetWidth(widget, width) {
    if (width === undefined) delete widget.width;
    else widget.width = width;
}

function patchWidget(widget) {
    if (!widget || widget[PATCH_FLAG] || typeof widget.draw !== "function") return;

    const originalDraw = widget.draw;
    let canvasWidth = widget.width;

    widget.draw = function (...args) {
        if (isMainLegacyCanvas(args[0])) {
            const result = originalDraw.apply(this, args);
            canvasWidth = this.width;
            return result;
        }

        try {
            return originalDraw.apply(this, args);
        } finally {
            // Nodes 2.0 and the parameter panel render legacy widgets into
            // auxiliary canvases. WidgetLegacy temporarily writes that
            // canvas width to the original widget, so restore the width used
            // by the real LiteGraph canvas after every auxiliary draw.
            restoreWidgetWidth(this, canvasWidth);
        }
    };

    Object.defineProperty(widget, PATCH_FLAG, { value: true });
}

function patchNodeWidgets(node) {
    for (const widget of node?.widgets ?? []) patchWidget(widget);
}

function patchWidgetFactory(methodName) {
    const prototype = globalThis.LGraphNode?.prototype ?? globalThis.LiteGraph?.LGraphNode?.prototype;
    const original = prototype?.[methodName];
    const methodFlag = `${PATCH_FLAG}_${methodName}`;
    if (!prototype || typeof original !== "function" || original[methodFlag]) return;

    const patched = function (...args) {
        const widget = original.apply(this, args);
        patchWidget(widget);
        return widget;
    };
    patched[methodFlag] = true;
    prototype[methodName] = patched;
}

function patchExistingNodes() {
    for (const node of app.canvas?.graph?._nodes ?? []) patchNodeWidgets(node);
}

app.registerExtension({
    name: "Comfy.GoohaiLegacyWidgetWidthHotfix",
    setup() {
        patchWidgetFactory("addWidget");
        patchWidgetFactory("addCustomWidget");
        patchExistingNodes();
    },
    nodeCreated(node) {
        patchNodeWidgets(node);
    },
});

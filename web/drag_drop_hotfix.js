import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const HOTFIX_FLAG = "comfyuiWorkflowDropHotfixInstalled";

const mediaNodes = {
    LoadImage: {
        widget: "image",
        accepts: (file) => file.type.startsWith("image/") || /\.(avif|bmp|gif|jpe?g|png|webp)$/i.test(file.name),
    },
    LoadVideo: {
        widget: "file",
        accepts: (file) => file.type.startsWith("video/") || /\.(avi|mkv|mov|mp4|mpeg|mpg|webm)$/i.test(file.name),
    },
    LoadAudio: {
        widget: "audio",
        accepts: (file) => file.type.startsWith("audio/") || /\.(aac|flac|m4a|mp3|ogg|opus|wav|wma)$/i.test(file.name),
    },
};

function getSingleJsonFile(event) {
    const files = event.dataTransfer?.files;
    if (!files || files.length !== 1) return null;

    const file = files[0];
    return file.name.toLowerCase().endsWith(".json") ? file : null;
}

function getMediaTarget(event) {
    if (!app.canvas?.graph) return null;

    app.canvas.adjustMouseEvent(event);
    const node = app.canvas.graph.getNodeOnPos(event.canvasX, event.canvasY);
    const config = mediaNodes[node?.constructor?.comfyClass ?? node?.type];
    return config ? { node, config } : null;
}

function setWidgetValue(node, name, value) {
    const widget = node.widgets?.find((widget) => widget.name === name);
    if (!widget) throw new Error(`Widget '${name}' was not found on ${node.type}`);

    const values = widget.options?.values;
    if (Array.isArray(values) && !values.includes(value)) values.push(value);

    const previousValue = widget.value;
    widget.value = value;
    widget.callback?.(value);
    node.onWidgetChanged?.(widget.name, value, previousValue, widget);
    node.graph?.setDirtyCanvas(true, true);
}

async function uploadToNode(node, config, file) {
    if (node.isUploading) return;

    node.isUploading = true;
    try {
        const body = new FormData();
        body.append("image", file);

        const response = await api.fetchApi("/upload/image", {
            method: "POST",
            body,
        });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

        const result = await response.json();
        const value = result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
        setWidgetValue(node, config.widget, value);
    } finally {
        node.isUploading = false;
    }
}

async function loadWorkflowFile(file) {
    const source = (await file.text()).replace(/:\s*NaN/g, ": null");
    const data = JSON.parse(source);

    if (app.isApiJson?.(data)) {
        app.loadApiJson(data, file.name.replace(/\.json$/i, ""));
        return;
    }

    if (data && typeof data === "object" && !Array.isArray(data) && Array.isArray(data.nodes)) {
        await app.loadGraphData(data);
        return;
    }

    await app.handleFile(file);
}

app.registerExtension({
    name: "Comfy.DragDropHotfix",
    setup() {
        if (window[HOTFIX_FLAG]) return;
        window[HOTFIX_FLAG] = true;

        window.addEventListener("dragover", (event) => {
            const mediaTarget = getMediaTarget(event);
            if (!getSingleJsonFile(event) && (!mediaTarget || !event.dataTransfer?.types?.includes("Files"))) return;

            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        }, true);

        window.addEventListener("drop", (event) => {
            const mediaTarget = getMediaTarget(event);
            const files = Array.from(event.dataTransfer?.files ?? []);
            if (mediaTarget && files.length === 1 && mediaTarget.config.accepts(files[0])) {
                event.preventDefault();
                event.stopImmediatePropagation();
                uploadToNode(mediaTarget.node, mediaTarget.config, files[0]).catch((error) => {
                    console.error(`Failed to drop ${files[0].name} on ${mediaTarget.node.type}:`, error);
                });
                return;
            }

            const file = getSingleJsonFile(event);
            if (!file) return;

            event.preventDefault();
            event.stopImmediatePropagation();
            loadWorkflowFile(file).catch((error) => {
                console.error("Workflow drop hotfix failed to load the file:", error);
            });
        }, true);
    },
});

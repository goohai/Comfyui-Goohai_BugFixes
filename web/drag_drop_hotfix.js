import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const HOTFIX_FLAG = "comfyuiWorkflowDropHotfixInstalled";
const GOOHAI_HOTFIX_FLAG = "comfyuiGoohaiWorkflowDropHotfixInstalled";

const mediaTypes = {
    image: {
        flags: ["image_upload", "animated_image_upload"],
        accepts: (file) => file.type.startsWith("image/") || /\.(avif|bmp|gif|jpe?g|png|webp)$/i.test(file.name),
    },
    video: {
        flags: ["video_upload"],
        accepts: (file) => file.type.startsWith("video/") || /\.(avi|mkv|mov|mp4|mpeg|mpg|webm)$/i.test(file.name),
    },
    audio: {
        flags: ["audio_upload"],
        accepts: (file) => file.type.startsWith("audio/") || /\.(aac|flac|m4a|mp3|ogg|opus|wav|wma)$/i.test(file.name),
    },
};

const legacyMediaNodes = {
    LoadImage: {
        widget: "image",
        ...mediaTypes.image,
    },
    LoadVideo: {
        widget: "file",
        ...mediaTypes.video,
    },
    LoadAudio: {
        widget: "audio",
        ...mediaTypes.audio,
    },
};

function getSingleJsonFile(event) {
    const files = event.dataTransfer?.files;
    if (!files || files.length !== 1) return null;

    const file = files[0];
    return file.name.toLowerCase().endsWith(".json") ? file : null;
}

function getDeclaredMediaConfigs(node) {
    const inputs = node?.constructor?.nodeData?.input;
    const configs = [];
    for (const section of [inputs?.required, inputs?.optional]) {
        for (const [widget, spec] of Object.entries(section ?? {})) {
            const options = Array.isArray(spec) ? spec[1] : spec;
            if (!options || typeof options !== "object") continue;

            for (const mediaType of Object.values(mediaTypes)) {
                if (mediaType.flags.some((flag) => options[flag] === true)) {
                    configs.push({
                        widget,
                        accepts: mediaType.accepts,
                        folder: options.image_folder,
                        subfolder: options.upload_subfolder,
                    });
                    break;
                }
            }
        }
    }

    for (const widget of node?.widgets ?? []) {
        const options = widget.spec ?? widget.options;
        if (!options || typeof options !== "object" || configs.some((config) => config.widget === widget.name)) continue;

        for (const mediaType of Object.values(mediaTypes)) {
            if (mediaType.flags.some((flag) => options[flag] === true)) {
                configs.push({
                    widget: widget.name,
                    accepts: mediaType.accepts,
                    folder: options.image_folder,
                    subfolder: options.upload_subfolder,
                });
                break;
            }
        }
    }
    return configs;
}

function getMediaTarget(event, file = null) {
    if (!app.canvas?.graph) return null;

    app.canvas.adjustMouseEvent(event);
    const node = app.canvas.graph.getNodeOnPos(event.canvasX, event.canvasY);
    if (!node) return null;

    const declaredConfigs = getDeclaredMediaConfigs(node);
    const legacyConfig = legacyMediaNodes[node.constructor?.comfyClass ?? node.type];
    const configs = legacyConfig ? [...declaredConfigs, legacyConfig] : declaredConfigs;
    const config = file ? configs.find((item) => item.accepts(file)) : configs[0];
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
        if (config.folder) body.append("type", config.folder);
        if (config.subfolder) body.append("subfolder", config.subfolder);

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
    // Reuse ComfyUI's official file-loading path instead of calling
    // loadGraphData directly. Besides parsing the graph, handleFile registers
    // the dropped file as the workflow source, so the tab gets its filename
    // and workflow actions such as Rename remain available (same as Ctrl+O).
    await app.handleFile(file, "file_drop", { deferWarnings: true });
}

app.registerExtension({
    name: "Comfy.DragDropHotfix",
    init() {
        // The bundled frontend also ships an older workflow_drop_hotfix.js
        // that uses HOTFIX_FLAG. Extension init hooks run before setup hooks,
        // so reserve its flag here to prevent that older drop listener from
        // loading workflows through loadGraphData without a file source.
        window[HOTFIX_FLAG] = true;
    },
    setup() {
        if (window[GOOHAI_HOTFIX_FLAG]) return;
        window[GOOHAI_HOTFIX_FLAG] = true;

        window.addEventListener("dragover", (event) => {
            const mediaTarget = getMediaTarget(event);
            if (!getSingleJsonFile(event) && (!mediaTarget || !event.dataTransfer?.types?.includes("Files"))) return;

            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        }, true);

        window.addEventListener("drop", (event) => {
            const files = Array.from(event.dataTransfer?.files ?? []);
            const mediaTarget = files.length === 1 ? getMediaTarget(event, files[0]) : null;
            if (mediaTarget) {
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

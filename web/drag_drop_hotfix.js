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

function getSingleFile(event) {
    const files = event.dataTransfer?.files;
    return files && files.length === 1 ? files[0] : null;
}

function isImageFile(file) {
    return Boolean(file) && (file.type.startsWith("image/") || mediaTypes.image.accepts(file));
}

async function imageHasWorkflowMetadata(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // PNG workflow data is stored in tEXt/iTXt/zTXt chunks. Checking the
    // chunk text avoids sending ordinary images through handleFile (which can
    // create a LoadImage node when no graph is present).
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
        const text = new TextDecoder("latin1").decode(bytes);
        return /(?:workflow|prompt|comfyui)/i.test(text);
    }
    // JPEG/WebP metadata is connector/version dependent; the same marker
    // check covers the JSON text used by ComfyUI exporters without decoding
    // or rewriting the image.
    const text = new TextDecoder("latin1").decode(bytes);
    return /(?:workflow|prompt|comfyui)/i.test(text);
}

function showNoWorkflowToast() {
    app.extensionManager?.toast?.add?.({
        severity: "info",
        summary: "未找到工作流数据",
        detail: "图像中没有找到 ComfyUI 工作流数据。",
        life: 3500,
    });
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

function preserveImageWidgetValue(node) {
    for (const widget of node?.widgets ?? []) {
        const options = widget.options ?? widget.spec;
        const isImageWidget = options?.image_upload === true
            || options?.animated_image_upload === true
            || (widget.name === "image" && Array.isArray(options?.values));
        if (!isImageWidget || widget.value == null || String(widget.value).trim() === "") continue;

        const values = options?.values;
        if (Array.isArray(values) && !values.includes(widget.value)) {
            values.push(widget.value);
        }
    }
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
    preserveMissingImageSelections();
}

function preserveMissingImageSelections() {
    for (const node of app.graph?._nodes ?? []) {
        preserveImageWidgetValue(node);
        for (const widget of node.widgets ?? []) {
            const options = widget.options ?? widget.spec;
            const isImageWidget = options?.image_upload === true
                || options?.animated_image_upload === true
                || (widget.name === "image" && Array.isArray(options?.values));
            if (!isImageWidget || widget.value == null || String(widget.value).trim() === "") continue;

            const values = options?.values;
            // Keep the workflow's original filename visible. Adding it to the
            // local combo options prevents the frontend from marking it as an
            // invalid selection, while the backend hotfix handles the missing
            // file without attempting to load it.
            if (Array.isArray(values) && !values.includes(widget.value)) {
                values.push(widget.value);
            }
        }
        node.setDirtyCanvas?.(true, true);
    }
    app.graph?.setDirtyCanvas?.(true, true);
}

app.registerExtension({
    name: "Comfy.DragDropHotfix",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        const inputs = nodeData?.input;
        const sections = [inputs?.required, inputs?.optional];
        const isImageLoader = sections.some((section) => Object.values(section ?? {}).some((spec) => {
            const options = Array.isArray(spec) ? spec[1] : spec;
            return options?.image_upload === true || options?.animated_image_upload === true;
        }));
        if (!isImageLoader || nodeType.prototype._goohaiPreserveImageValueInstalled) return;

        const originalConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (...args) {
            const result = originalConfigure?.apply(this, args);
            preserveImageWidgetValue(this);
            return result;
        };
        const originalCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            const result = originalCreated?.apply(this, args);
            preserveImageWidgetValue(this);
            return result;
        };
        nodeType.prototype._goohaiPreserveImageValueInstalled = true;
    },
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
            const file = getSingleFile(event);
            if (!getSingleJsonFile(event) && !isImageFile(file) && (!mediaTarget || !event.dataTransfer?.types?.includes("Files"))) return;

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

            const file = getSingleFile(event);
            if (!file) return;

            // Images dropped on the canvas may contain ComfyUI workflow/prompt
            // metadata (normally PNG tEXt/iTXt chunks). Delegate to the
            // official handler so it can restore the graph exactly like the
            // built-in Ctrl+O/image-drop path. Plain images are handled by the
            // same fallback as the stock frontend.
            if (isImageFile(file)) {
                event.preventDefault();
                event.stopImmediatePropagation();
                imageHasWorkflowMetadata(file).then((hasWorkflow) => {
                    if (hasWorkflow) return loadWorkflowFile(file);
                    showNoWorkflowToast();
                    return undefined;
                }).catch((error) => {
                    console.error("Workflow image metadata check failed:", error);
                });
                return;
            }

            if (!file.name.toLowerCase().endsWith(".json")) return;

            event.preventDefault();
            event.stopImmediatePropagation();
            loadWorkflowFile(file).catch((error) => {
                console.error("Workflow drop hotfix failed to load the file:", error);
            });
        }, true);
    },
});

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const HOTFIX_FLAG = "comfyuiWorkflowDropHotfixInstalled";
const GOOHAI_HOTFIX_FLAG = "comfyuiGoohaiWorkflowDropHotfixInstalled";
let workflowDropSequence = 0;
let workflowDropQueue = Promise.resolve();

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
    // VideoHelperSuite adds its upload button and drag handlers at runtime,
    // so the backend node definition does not expose a `video_upload` flag
    // for the generic detector above.  Declare the upload widget here and
    // keep the fix isolated from VHS itself.
    VHS_LoadVideo: {
        widget: "video",
        ...mediaTypes.video,
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

// Some custom nodes (for example MiniMax-H3 Integration) render their own
// HTML drop zones inside a LiteGraph node instead of declaring an
// `image_upload` widget.  Because this hotfix listens during the window
// capture phase, it must leave those DOM drop zones untouched so their own
// handlers can receive the file.
function isNodeOwnedDropTarget(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const candidates = path.length ? path : [event.target];
    for (const item of candidates) {
        if (!(item instanceof Element)) continue;
        if (item.matches("input[type='file'], [data-ghh3-drop-slot], .ghh3-drop, .ghh3-dynamic")) {
            return true;
        }
        if (item.closest?.("input[type='file'], [data-ghh3-drop-slot], .ghh3-drop, .ghh3-dynamic")) {
            return true;
        }
    }
    return false;
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

function loadWorkflowFile(file) {
    // Graph loading mutates shared canvas/store state. Keep consecutive drops
    // ordered, including when an earlier import failed.
    const load = workflowDropQueue.then(() => importWorkflowFile(file));
    workflowDropQueue = load.catch(() => {});
    return load;
}

function parseWorkflowJson(text) {
    const source = text.replace(/^\uFEFF/, "");
    try {
        return JSON.parse(source);
    } catch {
        // Python exporters can emit bare non-finite numbers. Leave matching
        // text inside quoted strings untouched (including escaped quotes).
        return JSON.parse(source.replace(
            /"(?:\\.|[^"\\])*"|(?<![\w.-])(-?Infinity|NaN)(?![\w.])/g,
            (match, token) => token ? "null" : match,
        ));
    }
}

function getWorkflowStore() {
    return app.extensionManager?.workflow;
}

function getAvailableWorkflowName(file) {
    const stem = (file.name || "workflow.json").replace(/\.[^.]+$/, "");
    const store = getWorkflowStore();
    // Frontends predating the exposed workflow store cannot be queried for
    // name collisions. Retain the old unique-name fallback on those versions.
    if (!store) return makeUniqueWorkflowSourceFile(file).name.replace(/\.[^.]+$/, "");
    let name = stem;
    let counter = 2;
    const exists = (candidate) => store?.getWorkflowByPath?.(`workflows/${candidate}.json`)
        || store?.workflows?.some((workflow) => workflow.path === `workflows/${candidate}.json`);
    while (exists(name)) name = `${stem} (${counter++})`;
    return name;
}

async function readImageWorkflowMetadata(file) {
    const readerName = file.type === "image/png" || /\.png$/i.test(file.name) ? "getPngMetadata"
        : file.type === "image/webp" || /\.webp$/i.test(file.name) ? "getWebpMetadata"
        : file.type === "image/avif" || /\.avif$/i.test(file.name) ? "getAvifMetadata"
        : null;
    if (!readerName) return null;
    // Use the same metadata readers as ComfyUI, but load the extracted graph
    // through our explicit workflow identity rather than handleFile's fallback.
    const readers = window.comfyAPI?.pnginfo ?? await import("/scripts/pnginfo.js");
    const reader = readers[readerName];
    return reader ? await reader(file) : null;
}

async function importWorkflowFile(file) {
    const isJson = file.name.toLowerCase().endsWith(".json");
    const metadata = isJson ? null : await readImageWorkflowMetadata(file);
    if (!isJson && !metadata) {
        // Keep ComfyUI's metadata readers for workflow images and other media.
        await app.handleFile(makeUniqueWorkflowSourceFile(file), "file_drop", { deferWarnings: true });
        preserveMissingImageSelections();
        return;
    }

    const data = isJson ? parseWorkflowJson(await file.text()) : metadata;
    // Never parse or convert prompt data when a complete UI workflow exists.
    // API data omits groups, unexecuted nodes and original layout. In recent
    // frontends handleFile also falls back to it on graph-lifecycle errors.
    const rawWorkflow = data?.workflow ?? data?.Workflow ?? (isJson ? data : null);
    const workflow = typeof rawWorkflow === "string" ? parseWorkflowJson(rawWorkflow) : rawWorkflow;
    const store = getWorkflowStore();
    // Include saved workflows in collision checks before creating a local copy.
    await store?.syncWorkflows?.();
    const name = getAvailableWorkflowName(file);

    if (workflow && typeof workflow === "object" && !Array.isArray(workflow) && Array.isArray(workflow.nodes)) {
        // New releases expose createNewTemporary; older tab-enabled releases
        // only expose createTemporary. Use a collision-free path for both.
        const create = store?.createNewTemporary ?? store?.createTemporary;
        const source = create ? create.call(store, `${name}.json`, workflow) : name;
        // Pass the workflow object through the official graph lifecycle so the
        // outgoing tab is captured before configure and the new tab owns its
        // tracker, title, rename action and draft. handleFile catches errors in
        // this lifecycle and misleadingly reports "no workflow found".
        const loaded = await app.loadGraphData(workflow, true, true, source, {
            openSource: "file_drop",
            deferWarnings: true,
        });
        if (loaded === false) throw new Error(`Failed to configure workflow: ${file.name}`);
        preserveMissingImageSelections();
        await saveImportedWorkflow(source);
        return;
    }

    const rawPrompt = data?.prompt ?? data?.Prompt ?? (isJson ? data : null);
    const prompt = typeof rawPrompt === "string" ? parseWorkflowJson(rawPrompt) : rawPrompt;
    if (prompt && typeof prompt === "object" && Object.keys(prompt).length && app.isApiJson?.(prompt)) {
        await app.loadApiJson(prompt, name, { deferWarnings: true });
        preserveMissingImageSelections();
        await saveImportedWorkflow(store?.activeWorkflow);
        return;
    }

    if (!isJson && (data?.parameters || data?.templates)) {
        await app.handleFile(makeUniqueWorkflowSourceFile(file), "file_drop", { deferWarnings: true });
        preserveMissingImageSelections();
        return;
    }

    if (!isJson) {
        showNoWorkflowToast();
        return;
    }

    // Templates/component packs are not graphs. Leave their extension-specific
    // import behavior alone instead of swallowing real invalid-file warnings.
    await app.handleFile(file, "file_drop", { deferWarnings: true });
}

async function saveImportedWorkflow(workflow) {
    const store = getWorkflowStore();
    if (!store?.saveWorkflow || !workflow || typeof workflow === "string") return;
    if (store.activeWorkflow?.path !== workflow.path || !workflow.isTemporary) return;
    // The native Rename action is disabled for temporary workflows. Persist a
    // separate local copy through the store, not by falsifying isPersisted or
    // editing tab DOM. The original dropped file is never modified.
    await store.saveWorkflow(workflow);
}

function makeUniqueWorkflowSourceFile(file) {
    const originalName = file?.name || "workflow.json";
    const match = originalName.match(/^(.*?)(\.[^.]+)?$/);
    const stem = match?.[1] || "workflow";
    const extension = match?.[2] || ".json";
    workflowDropSequence = (workflowDropSequence + 1) % 1000;
    const suffix = `${Date.now()}-${workflowDropSequence}`;
    try {
        return new File([file], `${stem} (imported ${suffix})${extension}`, {
            type: file.type || "application/json",
            lastModified: file.lastModified,
        });
    } catch {
        // Older embedded browsers may not expose the File constructor.  In
        // that case the original file remains loadable, albeit without the
        // collision-avoidance suffix.
        return file;
    }
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
            if (isNodeOwnedDropTarget(event)) return;

            const mediaTarget = getMediaTarget(event);
            const file = getSingleFile(event);
            if (!getSingleJsonFile(event) && !isImageFile(file) && (!mediaTarget || !event.dataTransfer?.types?.includes("Files"))) return;

            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        }, true);

        window.addEventListener("drop", (event) => {
            if (isNodeOwnedDropTarget(event)) return;

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

            // Restore the full UI workflow before considering execution-only
            // prompt data. Node-owned media upload/drop zones were handled above.
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

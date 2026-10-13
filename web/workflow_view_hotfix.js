import { app } from "/scripts/app.js";

const PATCH_FLAG = "_goohaiWorkflowViewInstalled";

function copyView(view) {
    if (!view || !Number.isFinite(view.scale) || view.scale <= 0 ||
        view.offset?.length !== 2 || !Number.isFinite(view.offset[0]) || !Number.isFinite(view.offset[1])) return null;
    return { scale: view.scale, offset: [view.offset[0], view.offset[1]] };
}

function currentRootView() {
    const root = app.rootGraph ?? app.graph;
    if (app.canvas?.graph !== root) return null;
    return copyView(app.canvas.ds);
}

function writeView(data, view) {
    if (!data || !view) return;
    data.extra ??= {};
    data.extra.ds = copyView(view);
}

function pinView(canvas, view) {
    const ds = canvas.ds;
    ds.scale = view.scale;
    ds.offset[0] = view.offset[0];
    ds.offset[1] = view.offset[1];
    const descriptors = new Map();
    for (const key of ["scale", "offset", "animateToBounds"]) {
        descriptors.set(key, Object.getOwnPropertyDescriptor(ds, key));
    }
    let scaleDescriptor;
    for (let owner = ds; owner && !scaleDescriptor; owner = Object.getPrototypeOf(owner)) {
        scaleDescriptor = Object.getOwnPropertyDescriptor(owner, "scale");
    }
    const offset = ds.offset;
    const pinnedOffset = new Proxy(offset, {
        get(target, key, receiver) {
            // Legacy DragAndScale can use a typed array for its offset.
            if (ArrayBuffer.isView(target)) {
                if (["set", "fill", "copyWithin", "reverse", "sort"].includes(key)) return () => target;
                const value = Reflect.get(target, key, target);
                return typeof value === "function" ? value.bind(target) : value;
            }
            return Reflect.get(target, key, receiver);
        },
        set() { return true; },
    });
    Object.defineProperties(ds, {
        scale: { configurable: true, get: () => scaleDescriptor?.get ? scaleDescriptor.get.call(ds) : view.scale, set() {} },
        offset: { configurable: true, get: () => pinnedOffset, set() {} },
    });
    // Do not start an auto-focus animation that would outlive the load lock.
    if (typeof ds.animateToBounds === "function") {
        Object.defineProperty(ds, "animateToBounds", { configurable: true, writable: true, value() {} });
    }
    ds.computeVisibleArea?.(canvas.viewport);
    canvas.setDirty?.(true, true);
    return () => {
        for (const [key, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(ds, key, descriptor);
            else delete ds[key];
        }
    };
}

app.registerExtension({
    name: "Comfy.GoohaiWorkflowViewHotfix",
    setup() {
        if (app[PATCH_FLAG]) return;
        app[PATCH_FLAG] = true;
        const root = app.rootGraph ?? app.graph;
        const store = app.extensionManager?.workflow;
        let loading = 0;
        let restoreToken = 0;
        let pendingView = null;
        let releaseView = null;

        const stopPinning = () => {
            releaseView?.();
            releaseView = null;
        };
        const originalConfigure = root.configure;
        root.configure = function (...args) {
            // beforeLoadNewGraph has already captured the outgoing tab here.
            // Pin before node hooks run, not after the asynchronous load ends.
            if (pendingView && pendingView.token === restoreToken) {
                stopPinning();
                releaseView = pinView(app.canvas, pendingView.view);
            }
            return originalConfigure.apply(this, args);
        };

        const originalSerialize = root.onSerialize;
        root.onSerialize = function (data, ...args) {
            const result = originalSerialize?.call(this, data, ...args);
            if (!loading) writeView(data, currentRootView());
            return result;
        };

        // View-only changes are ignored by the workflow change tracker. Update
        // the saved state explicitly, even when no nodes have been edited.
        if (store?.saveWorkflow) {
            const originalSave = store.saveWorkflow;
            store.saveWorkflow = function (workflow, ...args) {
                const active = this.activeWorkflow;
                if (!loading && (workflow === active || (workflow?.path && workflow.path === active?.path))) {
                    writeView(workflow.activeState, currentRootView());
                }
                return originalSave.call(this, workflow, ...args);
            };
        }

        const cancelRestore = () => { restoreToken++; stopPinning(); };
        const canvas = app.canvas;
        const originalSetGraph = canvas.setGraph;
        if (originalSetGraph) {
            canvas.setGraph = function (graph, ...args) {
                if (!loading && graph !== this.graph) cancelRestore();
                return originalSetGraph.call(this, graph, ...args);
            };
        }
        for (const event of ["pointerdown", "wheel", "keydown"]) {
            window.addEventListener(event, cancelRestore, { capture: true, passive: true });
        }

        const originalLoad = app.loadGraphData;
        app.loadGraphData = async function (data, ...args) {
            stopPinning();
            const token = ++restoreToken;
            const restore = args[1] !== false;
            const source = args[2];
            const options = args[3];
            // Existing tabs own their most recent viewport, including subgraphs.
            const tabView = copyView(source?.changeTracker?.ds);
            const view = tabView ?? copyView(data?.extra?.ds);
            const intent = restore && view && options?.openSource !== "template" ? { token, view } : null;
            pendingView = intent;
            loading++;
            let result;
            try {
                result = await originalLoad.call(this, data, ...args);
            } catch (error) {
                if (token === restoreToken) stopPinning();
                throw error;
            } finally {
                loading--;
                if (pendingView === intent) pendingView = null;
            }
            if (token !== restoreToken) return result;
            if (result === false || !intent) {
                stopPinning();
                return result;
            }
            // Keep the same view through queued fit-view/layout callbacks.
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    if (token === restoreToken) stopPinning();
                });
            });
            return result;
        };
    },
});

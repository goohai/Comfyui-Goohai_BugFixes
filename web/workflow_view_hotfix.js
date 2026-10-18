import { app } from "/scripts/app.js";

const PATCH_FLAG = "_goohaiWorkflowViewInstalled";
// A background tab can pause requestAnimationFrame indefinitely.  Never let
// the temporary accessor lock survive long enough to make canvas zoom/pan
// unusable if a load hook or a queued frontend callback is skipped.
const PIN_MAX_MS = 8000;

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

    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        for (const [key, descriptor] of descriptors) {
            try {
                if (descriptor) Object.defineProperty(ds, key, descriptor);
                else delete ds[key];
            } catch {
                // A single incompatible descriptor must not prevent the
                // remaining accessors (especially scale/offset) from being
                // restored.
            }
        }
    };
    const guard = setTimeout(release, PIN_MAX_MS);
    return () => {
        clearTimeout(guard);
        release();
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
                // Failed loads must release their own lock even if another
                // load has already advanced restoreToken.
                stopPinning();
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
            // setTimeout still runs when the tab is backgrounded, unlike rAF.
            setTimeout(() => {
                if (token === restoreToken) stopPinning();
            }, 100);
            return result;
        };
    },
});

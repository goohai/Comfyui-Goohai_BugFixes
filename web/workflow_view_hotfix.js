import { app } from "/scripts/app.js";

const PATCH_FLAG = "_goohaiWorkflowViewInstalled";
let loading = false;

function writeView(data) {
    const root = app.rootGraph ?? app.graph;
    if (!data || loading || app.canvas?.graph !== root) return;
    const view = app.canvas.ds;
    if (!Number.isFinite(view.scale) || view.scale <= 0 ||
        view.offset?.length !== 2 || !Number.isFinite(view.offset[0]) || !Number.isFinite(view.offset[1])) return;
    data.extra ??= {};
    data.extra.ds = { scale: view.scale, offset: [view.offset[0], view.offset[1]] };
}

app.registerExtension({
    name: "Comfy.GoohaiWorkflowViewHotfix",
    setup() {
        if (app[PATCH_FLAG]) return;
        app[PATCH_FLAG] = true;
        const root = app.rootGraph ?? app.graph;
        const store = app.extensionManager?.workflow;
        const originalSerialize = root.onSerialize;
        root.onSerialize = function (data, ...args) {
            const result = originalSerialize?.call(this, data, ...args);
            writeView(data);
            return result;
        };

        // View-only changes are ignored by the workflow change tracker.
        if (store?.saveWorkflow) {
            const originalSave = store.saveWorkflow;
            store.saveWorkflow = function (workflow, ...args) {
                const active = this.activeWorkflow;
                if (workflow === active || (workflow?.path && workflow.path === active?.path)) {
                    writeView(workflow.activeState);
                }
                return originalSave.call(this, workflow, ...args);
            };
        }
    },
    // The frontend owns loading, camera scheduling and tab navigation. Keep
    // incoming metadata intact until it has restored the native viewport.
    beforeLoadGraph() { loading = true; },
    afterLoadGraph() { loading = false; },
    onGraphLoadError() { loading = false; },
});

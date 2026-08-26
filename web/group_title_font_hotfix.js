import { app } from "/scripts/app.js";

const PATCH_FLAG = "comfyuiGroupTitleFontHotfixInstalled";
const CANVAS_PATCH_FLAG = "__goohaiGroupTitleHitAreaPatched";
const SNAP_GUIDE_PATCH_FLAG = "__goohaiGroupTitleSnapGuidePatched";
const CONTEXT_MENU_PATCH_FLAG = "__goohaiInlineGroupMenuPatched";
const RIGHT_DRAG_FONT_PATCH_FLAG = "comfyuiGroupTitleRightDragFontPatched";
const RIGHT_DRAG_FONT_START = "__goohaiStartGroupTitleFontDrag";
const EDITOR_PATCH_FLAG = "comfyuiGroupTitleEditorFontHotfixInstalled";
const DEFAULT_GROUP_FONT_SIZE = 20;
const MIN_GROUP_FONT_SIZE = 12;
const MAX_GROUP_FONT_SIZE = 300;
const RIGHT_DRAG_THRESHOLD = 4;
const RIGHT_DRAG_PIXELS_PER_STEP = 5;
const GROUP_TITLE_NODE_GAP = 24;
const TITLE_ALIGNMENTS = new Set(["left", "center", "right"]);
const CUSTOM_GROUP_COLORS = [
    "#ffffff", "#d1d5db", "#9ca3af", "#6b7280", "#db8ab5", "#ddcf88", "#f472b6",
    "#fecaca", "#fca5a5", "#f87171", "#ef4444", "#dc2626", "#991b1b",
    "#fed7aa", "#fdba74", "#fb923c", "#f97316", "#c2410c", "#7c2d12",
    "#fef08a", "#fde047", "#facc15", "#eab308", "#a16207", "#713f12",
    "#bbf7d0", "#86efac", "#4ade80", "#22c55e", "#15803d", "#14532d",
    "#a7f3d0", "#6ee7b7", "#34d399", "#10b981", "#047857", "#064e3b",
    "#a5f3fc", "#67e8f9", "#22d3ee", "#06b6d4", "#0e7490", "#164e63",
    "#bfdbfe", "#93c5fd", "#60a5fa", "#3b82f6", "#a9bfd6", "#ec4899",
    "#c4b5fd", "#a78bfa", "#8b5cf6", "#3babe3", "#4f8fc4", "#be185d",
    "#f5d0fe", "#e879f9", "#d946ef", "#c58b5a", "#a96f45", "#831843",
    "#fbcfe8", "#f9a8d4",
];

function getTitleAlignment(group) {
    return TITLE_ALIGNMENTS.has(group?.title_align) ? group.title_align : "left";
}

function getSelectedOutermostGroups(group) {
    if (!group?.selected) return [group];
    const graphGroups = group.graph?.groups ?? group.graph?._groups ?? app.canvas?.graph?.groups ?? app.canvas?.graph?._groups;
    const selectedGroups = Array.isArray(graphGroups)
        ? graphGroups.filter((candidate) => candidate?.selected)
        : [];
    if (selectedGroups.length <= 1) return [group];
    const outermost = selectedGroups.filter((candidate) => (
        !selectedGroups.some((parent) => groupContainsGroup(parent, candidate))
    ));
    return outermost.length > 0 ? outermost : [group];
}

const getAlignmentTargetGroups = getSelectedOutermostGroups;

function createBatchFontSizeGroup(group) {
    const targets = getSelectedOutermostGroups(group);
    if (targets.length <= 1) return group;
    return new Proxy(group, {
        set(target, property, value) {
            if (property === "font_size") {
                const fontSize = Number(value);
                for (const selectedGroup of targets) {
                    selectedGroup.font_size = fontSize;
                    selectedGroup.setDirtyCanvas?.(true, true);
                }
                app.canvas?.setDirty?.(true, true);
                return true;
            }
            target[property] = value;
            return true;
        },
    });
}

function showTitleAlignmentMenu(_value, _options, event, parentMenu, group) {
    const ContextMenu = globalThis.LiteGraph?.ContextMenu;
    if (!ContextMenu || !group) return false;

    const currentAlignment = getTitleAlignment(group);
    const alignments = [
        { value: "left", content: `${currentAlignment === "left" ? "✓ " : ""}左对齐` },
        { value: "center", content: `${currentAlignment === "center" ? "✓ " : ""}居中` },
        { value: "right", content: `${currentAlignment === "right" ? "✓ " : ""}右对齐` },
    ];

    new ContextMenu(alignments, {
        event,
        parentMenu,
        node: group,
        callback: (item) => {
            const alignment = typeof item === "string" ? item : item?.value;
            if (!TITLE_ALIGNMENTS.has(alignment)) return;

            const graph = app.canvas?.graph;
            const targets = getAlignmentTargetGroups(group);
            if (!targets.some((target) => getTitleAlignment(target) !== alignment)) return;
            graph?.beforeChange?.();
            for (const target of targets) {
                target.title_align = alignment;
                target.setDirtyCanvas?.(true, true);
            }
            app.canvas?.setDirty?.(true, true);
            graph?.afterChange?.();
        },
    });
    return false;
}

function showGroupColorPreviewMenu(_value, _options, event, parentMenu, group) {
    const LiteGraph = globalThis.LiteGraph;
    const ContextMenu = LiteGraph?.ContextMenu;
    const Canvas = globalThis.LGraphCanvas ?? LiteGraph?.LGraphCanvas ?? app.canvas?.constructor;
    const nodeColors = Canvas?.node_colors;
    if (!ContextMenu || !group || !nodeColors) return false;

    const graph = group.graph ?? app.canvas?.graph;
    const targets = getSelectedOutermostGroups(group);
    const originalColors = new Map(targets.map((target) => [target, {
        had: Object.prototype.hasOwnProperty.call(target, "color"),
        value: target.color,
    }]));
    const originalColor = originalColors.get(group)?.value;
    let committed = false;

    const markDirty = () => {
        for (const target of targets) target.setDirtyCanvas?.(true, true);
        app.canvas?.setDirty?.(true, true);
    };
    const applyPreview = (color) => {
        for (const target of targets) {
            if (color == null) delete target.color;
            else target.color = color;
        }
        markDirty();
    };
    const restoreOriginal = () => {
        for (const target of targets) {
            const original = originalColors.get(target);
            if (original?.had) target.color = original.value;
            else delete target.color;
        }
        markDirty();
    };

    let submenu;
    const commitColor = (color) => {
        // beforeChange must capture the real pre-menu value, not the last hover preview.
        restoreOriginal();
        graph?.beforeChange?.();
        for (const target of targets) {
            if (color == null) delete target.color;
            else target.color = color;
        }
        committed = true;
        markDirty();
        graph?.afterChange?.();
        submenu?.getTopMenu?.().close();
    };

    const values = [{
        value: null,
        content: "<span style='display: block; padding-left: 4px;'>无颜色</span>",
        __goohaiGroupColor: null,
    }];
    for (const [name, colorOption] of Object.entries(nodeColors)) {
        if (/custom|自定义|🎨/i.test(name) || !colorOption?.groupcolor) continue;
        values.push({
            value: name,
            content: `<span style='display: block; color: #ddd; padding-left: 4px; border-left: 8px solid ${colorOption.color}; background-color:${colorOption.bgcolor}'>${name}</span>`,
            __goohaiGroupColor: colorOption.groupcolor,
        });
    }

    submenu = new ContextMenu(values, {
        event,
        parentMenu,
        node: group,
        callback: (item) => {
            commitColor(item?.__goohaiGroupColor ?? null);
        },
    });

    const originalClose = submenu.close.bind(submenu);
    submenu.close = (...args) => {
        if (!committed) restoreOriginal();
        panel?.remove();
        return originalClose(...args);
    };

    for (const entry of submenu.root.querySelectorAll(":scope > .litemenu-entry:not(.separator)")) {
        entry.addEventListener("pointerenter", () => {
            applyPreview(entry.value?.__goohaiGroupColor ?? null);
        });
    }

    const panel = document.createElement("div");
    panel.dataset.goohaiGroupColorPalette = "true";
    Object.assign(panel.style, {
        position: "fixed",
        zIndex: "100001",
        width: "224px",
        padding: "10px",
        border: "1px solid rgba(255, 255, 255, 0.16)",
        borderRadius: "5px",
        background: "rgba(31, 34, 42, 0.98)",
        boxShadow: "0 6px 22px rgba(0, 0, 0, 0.45)",
        boxSizing: "border-box",
    });

    const grid = document.createElement("div");
    Object.assign(grid.style, {
        display: "grid",
        gridTemplateColumns: "repeat(7, 1fr)",
        gap: "4px",
    });
    for (const color of CUSTOM_GROUP_COLORS) {
        const swatch = document.createElement("button");
        swatch.type = "button";
        swatch.title = color;
        Object.assign(swatch.style, {
            width: "24px",
            height: "24px",
            padding: "0",
            border: "1px solid rgba(255, 255, 255, 0.25)",
            borderRadius: "3px",
            background: color,
            cursor: "pointer",
        });
        swatch.addEventListener("pointerenter", () => applyPreview(color));
        swatch.addEventListener("click", (clickEvent) => {
            clickEvent.preventDefault();
            clickEvent.stopPropagation();
            commitColor(color);
        });
        grid.appendChild(swatch);
    }
    panel.appendChild(grid);

    const pickerLabel = document.createElement("label");
    pickerLabel.textContent = "自定义取色";
    Object.assign(pickerLabel.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "10px",
        marginTop: "10px",
        color: "#d1d5db",
        font: "12px/1.2 Inter, sans-serif",
    });
    const picker = document.createElement("input");
    picker.type = "color";
    picker.value = /^#[0-9a-f]{6}$/i.test(String(originalColor)) ? originalColor : "#64748b";
    Object.assign(picker.style, {
        width: "92px",
        height: "30px",
        padding: "1px",
        border: "1px solid rgba(255, 255, 255, 0.25)",
        borderRadius: "4px",
        background: "transparent",
        cursor: "pointer",
    });
    picker.addEventListener("input", () => applyPreview(picker.value));
    picker.addEventListener("change", () => commitColor(picker.value));
    pickerLabel.appendChild(picker);
    panel.appendChild(pickerLabel);

    // Keep the palette outside the scrollable menu so it is not clipped, while
    // still treating it as part of the submenu for outside-click detection.
    const originalContainsNode = submenu.containsNode.bind(submenu);
    submenu.containsNode = (node, ...args) => (
        panel.contains(node) || originalContainsNode(node, ...args)
    );
    document.body.appendChild(panel);

    requestAnimationFrame(() => {
        const menuRect = submenu.root.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const right = menuRect.right + 6;
        const left = right + panelRect.width <= window.innerWidth - 8
            ? right
            : Math.max(8, menuRect.left - panelRect.width - 6);
        panel.style.left = `${left}px`;
        panel.style.top = `${Math.max(8, Math.min(menuRect.top, window.innerHeight - panelRect.height - 8))}px`;
    });

    return false;
}

function hsvToRgb(h, s, v) {
    const c = v * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = v - c;
    let rgb = [0, 0, 0];
    if (h < 60) rgb = [c, x, 0];
    else if (h < 120) rgb = [x, c, 0];
    else if (h < 180) rgb = [0, c, x];
    else if (h < 240) rgb = [0, x, c];
    else if (h < 300) rgb = [x, 0, c];
    else rgb = [c, 0, x];
    return rgb.map((channel) => Math.round((channel + m) * 255));
}

function rgbToHsv(r, g, b) {
    const values = [r, g, b].map((value) => Math.max(0, Math.min(255, value)) / 255);
    const max = Math.max(...values);
    const min = Math.min(...values);
    const delta = max - min;
    let h = 0;
    if (delta !== 0) {
        if (max === values[0]) h = 60 * (((values[1] - values[2]) / delta) % 6);
        else if (max === values[1]) h = 60 * ((values[2] - values[0]) / delta + 2);
        else h = 60 * ((values[0] - values[1]) / delta + 4);
    }
    if (h < 0) h += 360;
    return [h, max === 0 ? 0 : delta / max, max];
}

function rgbToHex(rgb) {
    return `#${rgb.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

function hexToRgb(color, fallback = [110, 231, 183]) {
    const match = String(color ?? "").match(/^#([0-9a-f]{6})$/i);
    if (!match) return fallback;
    return [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16));
}

function getCustomTitleColor(group, fallbackColor) {
    const saturation = Number(group?.title_color_saturation);
    const brightness = Number(group?.title_color_brightness);
    if (!Number.isFinite(saturation) || !Number.isFinite(brightness)) return null;

    const groupRgb = hexToRgb(group?.color, hexToRgb(fallbackColor));
    const [hue] = rgbToHsv(...groupRgb);
    return rgbToHex(hsvToRgb(
        hue,
        Math.max(0, Math.min(1, saturation)),
        Math.max(0, Math.min(1, brightness)),
    ));
}

function showTitleColorPickerMenu(_value, _options, event, parentMenu, group) {
    const ContextMenu = globalThis.LiteGraph?.ContextMenu;
    if (!ContextMenu || !group) return false;

    const graph = group.graph ?? app.canvas?.graph;
    const targets = getSelectedOutermostGroups(group);
    const groupRgb = hexToRgb(group.color, [110, 231, 183]);
    const [groupHue, groupSaturation, groupBrightness] = rgbToHsv(...groupRgb);
    const legacyRgb = hexToRgb(group.title_color, groupRgb);
    const [, legacySaturation, legacyBrightness] = rgbToHsv(...legacyRgb);
    const savedSaturation = Number(group.title_color_saturation);
    const savedBrightness = Number(group.title_color_brightness);
    const hadCustomTitleColor = Number.isFinite(savedSaturation) && Number.isFinite(savedBrightness);
    const hue = groupHue;
    let saturation = hadCustomTitleColor
        ? Math.max(0, Math.min(1, savedSaturation))
        : (/^#[0-9a-f]{6}$/i.test(String(group.title_color)) ? legacySaturation : groupSaturation);
    let brightness = hadCustomTitleColor
        ? Math.max(0, Math.min(1, savedBrightness))
        : (/^#[0-9a-f]{6}$/i.test(String(group.title_color)) ? legacyBrightness : groupBrightness);
    let currentColor = rgbToHex(hsvToRgb(hue, saturation, brightness));
    let changed = false;
    let changeStarted = false;

    const markDirty = () => {
        for (const target of targets) target.setDirtyCanvas?.(true, true);
        app.canvas?.setDirty?.(true, true);
    };
    const beginChange = () => {
        if (changeStarted) return;
        graph?.beforeChange?.();
        changeStarted = true;
    };
    const preview = () => {
        beginChange();
        for (const target of targets) {
            target.title_color_saturation = saturation;
            target.title_color_brightness = brightness;
            delete target.title_color;
        }
        changed = true;
        markDirty();
    };

    const submenu = new ContextMenu([], { event, parentMenu, node: group });
    const originalClose = submenu.close.bind(submenu);
    submenu.close = (...args) => {
        if (changeStarted) graph?.afterChange?.();
        return originalClose(...args);
    };

    const panel = submenu.root;
    panel.textContent = "";
    Object.assign(panel.style, {
        width: "292px",
        minWidth: "292px",
        minHeight: "0",
        padding: "0",
        overflow: "hidden",
        borderRadius: "5px",
        background: "#333333",
    });

    const svCanvas = document.createElement("canvas");
    svCanvas.width = 292;
    svCanvas.height = 142;
    Object.assign(svCanvas.style, { display: "block", width: "292px", height: "142px", cursor: "crosshair" });
    panel.appendChild(svCanvas);

    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.innerHTML = '<span style="color:#f05278;font-size:15px">×</span><span>清除自定义标题色</span>';
    const clearBackground = rgbToHex(hsvToRgb(hue, 0.30, 0.34));
    const clearHoverBackground = rgbToHex(hsvToRgb(hue, 0.27, 0.42));
    Object.assign(clearButton.style, {
        display: "flex", alignItems: "center", justifyContent: "center", gap: "6px",
        width: "100%", height: "40px", margin: "0", padding: "0", border: "0",
        borderTop: "1px solid rgba(255,255,255,.12)", background: clearBackground,
        color: "rgba(255,255,255,.62)", cursor: "pointer", font: "12px Inter, sans-serif",
        transition: "background-color 120ms ease, color 120ms ease",
    });
    clearButton.addEventListener("pointerenter", () => {
        clearButton.style.background = clearHoverBackground;
        clearButton.style.color = "rgba(255,255,255,.82)";
    });
    clearButton.addEventListener("pointerleave", () => {
        clearButton.style.background = clearBackground;
        clearButton.style.color = "rgba(255,255,255,.62)";
    });
    panel.appendChild(clearButton);

    const drawSv = () => {
        const context = svCanvas.getContext("2d");
        if (!context) return;
        context.fillStyle = `hsl(${hue}, 100%, 50%)`;
        context.fillRect(0, 0, svCanvas.width, svCanvas.height);
        const white = context.createLinearGradient(0, 0, svCanvas.width, 0);
        white.addColorStop(0, "#fff");
        white.addColorStop(1, "rgba(255,255,255,0)");
        context.fillStyle = white;
        context.fillRect(0, 0, svCanvas.width, svCanvas.height);
        const black = context.createLinearGradient(0, 0, 0, svCanvas.height);
        black.addColorStop(0, "rgba(0,0,0,0)");
        black.addColorStop(1, "#000");
        context.fillStyle = black;
        context.fillRect(0, 0, svCanvas.width, svCanvas.height);
        context.strokeStyle = "#fff";
        context.lineWidth = 2;
        context.beginPath();
        context.arc(saturation * svCanvas.width, (1 - brightness) * svCanvas.height, 7, 0, Math.PI * 2);
        context.stroke();
    };

    const syncFromHsv = () => {
        const rgb = hsvToRgb(hue, saturation, brightness);
        currentColor = rgbToHex(rgb);
        if (changed) preview();
        drawSv();
    };

    const clearTitleColor = () => {
        beginChange();
        for (const target of targets) {
            delete target.title_color_saturation;
            delete target.title_color_brightness;
            delete target.title_color;
            target.setDirtyCanvas?.(true, true);
        }
        saturation = groupSaturation;
        brightness = groupBrightness;
        currentColor = rgbToHex(groupRgb);
        changed = true;
        markDirty();
        drawSv();
    };

    let draggingSv = false;
    const updateSvFromPointer = (pointerEvent) => {
        const rect = svCanvas.getBoundingClientRect();
        saturation = Math.max(0, Math.min(1, (pointerEvent.clientX - rect.left) / rect.width));
        brightness = 1 - Math.max(0, Math.min(1, (pointerEvent.clientY - rect.top) / rect.height));
        changed = true;
        syncFromHsv();
    };
    svCanvas.addEventListener("pointerdown", (pointerEvent) => {
        draggingSv = true;
        svCanvas.setPointerCapture?.(pointerEvent.pointerId);
        updateSvFromPointer(pointerEvent);
    });
    svCanvas.addEventListener("pointermove", (pointerEvent) => {
        if (draggingSv) updateSvFromPointer(pointerEvent);
    });
    svCanvas.addEventListener("pointerup", () => { draggingSv = false; });
    clearButton.addEventListener("click", clearTitleColor);

    drawSv();
    return false;
}

function getTitleHeight(group, fallback = 30) {
    const fontSize = Number(group.font_size);
    return Number.isFinite(fontSize) && fontSize > 0
        ? Math.max(fallback, fontSize * (fallback / DEFAULT_GROUP_FONT_SIZE))
        : fallback;
}

function getTitleMetrics(group, fallback = 30) {
    const height = getTitleHeight(group, fallback);
    return {
        height,
        top: group.pos[1],
        bottom: group.pos[1] + height,
        overflowBelow: Math.max(0, height - (Number(group.size?.[1]) || 0)),
    };
}

function groupContainsGroup(parent, child) {
    if (parent === child || !parent?.pos || !parent?.size || !child?.pos || !child?.size) {
        return false;
    }

    const parentLeft = Number(parent.pos[0]);
    const parentTop = Number(parent.pos[1]);
    const parentRight = parentLeft + Number(parent.size[0]);
    const parentBottom = parentTop + Number(parent.size[1]);
    const childLeft = Number(child.pos[0]);
    const childTop = Number(child.pos[1]);
    const childRight = childLeft + Number(child.size[0]);
    const childBottom = childTop + Number(child.size[1]);

    return [parentLeft, parentTop, parentRight, parentBottom, childLeft, childTop, childRight, childBottom]
        .every(Number.isFinite)
        && childLeft >= parentLeft
        && childTop >= parentTop
        && childRight <= parentRight
        && childBottom <= parentBottom
        && (childLeft > parentLeft
            || childTop > parentTop
            || childRight < parentRight
            || childBottom < parentBottom);
}

function getRightDragTargetGroups(canvas, clickedGroup) {
    if (!clickedGroup?.selected) return [clickedGroup];

    const graphGroups = canvas?.graph?.groups ?? canvas?.graph?._groups;
    const selectedGroups = Array.isArray(graphGroups)
        ? graphGroups.filter((group) => group?.selected)
        : [];
    if (selectedGroups.length <= 1) return [clickedGroup];

    // When selected groups are nested, only their outermost selected groups
    // participate in the batch font-size adjustment.
    const outermostGroups = selectedGroups.filter((group) => (
        !selectedGroups.some((candidate) => groupContainsGroup(candidate, group))
    ));
    return outermostGroups.length > 0 ? outermostGroups : [clickedGroup];
}

function fitGroupTitleAboveTopNode(group) {
    if (!group?.pos || !group?.size) return false;

    try {
        group.recomputeInsideNodes?.();
    } catch (error) {
        console.warn("[GroupTitleFontHotfix] failed to refresh nodes before fitting title", error);
    }

    const nodes = Array.isArray(group._nodes) ? group._nodes : [];
    const renderedTitleHeight = Number(group.titleHeight);
    const titleHeight = Number.isFinite(renderedTitleHeight) && renderedTitleHeight > 0
        ? renderedTitleHeight
        : getTitleHeight(group);

    const graphGroups = group.graph?.groups ?? group.graph?._groups;
    const parentLeft = Number(group.pos[0]);
    const parentTop = Number(group.pos[1]);
    const parentRight = parentLeft + Number(group.size[0]);
    const parentBottom = parentTop + Number(group.size[1]);
    const childGroups = Array.isArray(graphGroups)
        ? graphGroups.filter((child) => {
            if (child === group || !child?.pos || !child?.size) return false;
            const childLeft = Number(child.pos[0]);
            const childTop = Number(child.pos[1]);
            const childRight = childLeft + Number(child.size[0]);
            const childBottom = childTop + Number(child.size[1]);
            return Number.isFinite(childLeft)
                && Number.isFinite(childTop)
                && Number.isFinite(childRight)
                && Number.isFinite(childBottom)
                && childLeft >= parentLeft
                && childTop >= parentTop
                && childRight <= parentRight
                && childBottom <= parentBottom;
        })
        : [];

    const topChildGroupY = childGroups.reduce((top, child) => {
        const childTop = Number(child.pos[1]);
        return Number.isFinite(childTop) ? Math.min(top, childTop) : top;
    }, Infinity);

    if (nodes.length === 0 && !Number.isFinite(topChildGroupY)) {
        group.size[1] = titleHeight;
        return true;
    }

    const topNodeY = nodes.reduce((top, node) => {
        // LiteGraph node.pos[1] is below the node title bar. boundingRect[1]
        // represents the actual visible top edge that the group title must clear.
        const boundingTop = Number(node?.boundingRect?.[1]);
        const nodeY = Number.isFinite(boundingTop)
            ? boundingTop
            : Number(node?.pos?.[1]);
        return Number.isFinite(nodeY) ? Math.min(top, nodeY) : top;
    }, Infinity);
    const topContentY = Number.isFinite(topChildGroupY) ? topChildGroupY : topNodeY;
    if (!Number.isFinite(topContentY)) return false;

    const oldTop = Number(group.pos[1]);
    const oldHeight = Number(group.size[1]);
    if (!Number.isFinite(oldTop) || !Number.isFinite(oldHeight)) return false;

    const currentTitleBottom = oldTop + titleHeight;
    const currentGap = topContentY - currentTitleBottom;

    // Existing extra space is intentional. Only expand upward when the title
    // would leave less than the minimum gap to the topmost node/child group.
    if (currentGap >= GROUP_TITLE_NODE_GAP) return false;

    const missingGap = GROUP_TITLE_NODE_GAP - currentGap;
    const newTop = oldTop - missingGap;
    const newHeight = oldHeight + missingGap;
    if (!Number.isFinite(newTop) || !Number.isFinite(newHeight) || newHeight <= 0) return false;

    group.pos[1] = newTop;
    group.size[1] = newHeight;
    return true;
}

function getGroupConstructor() {
    const graph = app.canvas?.graph;
    const groups = graph?.groups ?? graph?._groups;
    const group = Array.isArray(groups) ? groups[0] : null;
    return group?.constructor ?? globalThis.LGraphGroup ?? globalThis.LiteGraph?.LGraphGroup;
}

function insertGroupOptionsNearTop(canvasOptions, groupOptions) {
    const firstSeparatorIndex = canvasOptions.findIndex((item) => item == null);
    if (firstSeparatorIndex >= 0) {
        return [
            ...canvasOptions.slice(0, firstSeparatorIndex + 1),
            ...groupOptions,
            null,
            ...canvasOptions.slice(firstSeparatorIndex + 1),
        ];
    }

    // The first three entries are ComfyUI's Add Node, Add Group and Paste items.
    const insertionIndex = Math.min(3, canvasOptions.length);
    return [
        ...canvasOptions.slice(0, insertionIndex),
        null,
        ...groupOptions,
        null,
        ...canvasOptions.slice(insertionIndex),
    ];
}

function installRightDragFontGesture() {
    if (window[RIGHT_DRAG_FONT_PATCH_FLAG]) return true;

    const canvas = app.canvas;
    const canvasElement = canvas?.canvas;
    if (!canvasElement || !canvas?.convertEventToCanvasOffset) return false;

    let gesture = null;
    let suppressContextMenuUntil = 0;
    let indicator = null;

    const getIndicator = () => {
        if (indicator?.isConnected) return indicator;
        indicator = document.createElement("div");
        indicator.dataset.goohaiGroupFontIndicator = "true";
        Object.assign(indicator.style, {
            position: "fixed",
            zIndex: "100000",
            minWidth: "64px",
            padding: "7px 10px",
            border: "1px solid rgba(255, 255, 255, 0.32)",
            borderRadius: "6px",
            background: "rgba(24, 26, 32, 0.94)",
            color: "#ffffff",
            boxShadow: "0 4px 16px rgba(0, 0, 0, 0.35)",
            font: "600 14px/1.2 Inter, sans-serif",
            letterSpacing: "0",
            textAlign: "center",
            pointerEvents: "none",
            userSelect: "none",
            display: "none",
        });
        document.body.appendChild(indicator);
        return indicator;
    };

    const updateIndicator = (event, fontSize) => {
        const element = getIndicator();
        element.textContent = `${fontSize} px`;
        element.style.left = `${Math.min(event.clientX + 16, window.innerWidth - 88)}px`;
        element.style.top = `${Math.min(event.clientY + 16, window.innerHeight - 44)}px`;
        element.style.display = "block";
    };

    const hideIndicator = () => {
        if (indicator) indicator.style.display = "none";
    };

    const finishGesture = (event, openMenu) => {
        const current = gesture;
        if (!current) return;
        gesture = null;
        suppressContextMenuUntil = performance.now() + 500;
        hideIndicator();

        event?.preventDefault?.();
        event?.stopImmediatePropagation?.();

        if (current.changed) {
            for (const target of current.targets) {
                fitGroupTitleAboveTopNode(target.group);
                target.group.setDirtyCanvas?.(true, true);
            }
            current.graph?.afterChange?.();
            canvas.setDirty?.(true, true);
            return;
        }

        if (openMenu && event) {
            canvas.adjustMouseEvent?.(event);
            canvas.processContextMenu(undefined, event);
        }
    };

    const startGesture = (event, knownGroup = null) => {
        if (event.button !== 2) return false;
        if (gesture) {
            if (event.pointerId !== gesture.pointerId) return false;
            event.preventDefault();
            event.stopImmediatePropagation();
            return true;
        }

        const point = knownGroup ? null : canvas.convertEventToCanvasOffset(event);
        const group = knownGroup
            ?? canvas.graph?.getGroupTitlebarOnPos?.(point[0], point[1]);
        if (!group) return false;

        const targetGroups = getRightDragTargetGroups(canvas, group);
        const targets = targetGroups.map((targetGroup) => ({ group: targetGroup }));
        const configuredSize = Number(group.font_size);
        gesture = {
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startFontSize: Number.isFinite(configuredSize) && configuredSize > 0
                ? configuredSize
                : DEFAULT_GROUP_FONT_SIZE,
            group,
            targets,
            graph: canvas.graph,
            changed: false,
        };

        event.preventDefault();
        event.stopImmediatePropagation();
        return true;
    };

    canvas[RIGHT_DRAG_FONT_START] = startGesture;
    // Window-capture runs before document/canvas-capture listeners installed by
    // other extensions. Only intercept native group title hits, so third-party
    // node/widget context menus continue to work normally.
    window.addEventListener("pointerdown", (event) => {
        if (event.button !== 2 || gesture) return;
        const point = canvas.convertEventToCanvasOffset(event);
        const group = point
            ? canvas.graph?.getGroupTitlebarOnPos?.(point[0], point[1])
            : null;
        if (!group) return;
        if (startGesture(event, group)) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);
    canvasElement.addEventListener("pointerdown", (event) => {
        startGesture(event);
    }, true);

    window.addEventListener("pointermove", (event) => {
        if (!gesture || event.pointerId !== gesture.pointerId) return;

        const deltaX = event.clientX - gesture.startClientX;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!gesture.changed && Math.abs(deltaX) < RIGHT_DRAG_THRESHOLD) return;

        if (!gesture.changed) {
            gesture.changed = true;
            gesture.graph?.beforeChange?.();
        }

        const fontSize = Math.max(
            MIN_GROUP_FONT_SIZE,
            Math.min(
                MAX_GROUP_FONT_SIZE,
                Math.round(gesture.startFontSize + deltaX / RIGHT_DRAG_PIXELS_PER_STEP),
            ),
        );
        for (const target of gesture.targets) {
            if (fontSize !== target.group.font_size) {
                target.group.font_size = fontSize;
                target.group.setDirtyCanvas?.(true, true);
                canvas.setDirty?.(true, true);
            }
        }
        updateIndicator(event, fontSize);
    }, true);

    window.addEventListener("pointerup", (event) => {
        if (!gesture || event.pointerId !== gesture.pointerId) return;
        finishGesture(event, true);
    }, true);

    window.addEventListener("pointercancel", (event) => {
        if (!gesture || event.pointerId !== gesture.pointerId) return;
        finishGesture(event, false);
    }, true);

    window.addEventListener("blur", () => finishGesture(null, false));
    window.addEventListener("contextmenu", (event) => {
        if (gesture || performance.now() < suppressContextMenuUntil) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);

    window[RIGHT_DRAG_FONT_PATCH_FLAG] = true;
    return true;
}

function patchCanvasPrototype() {
    const Canvas = app.canvas?.constructor;
    const originalPrimaryButton = Canvas?.prototype?._processPrimaryButton;
    const originalDrawSnapGuide = Canvas?.prototype?.drawSnapGuide;
    const originalProcessContextMenu = Canvas?.prototype?.processContextMenu;
    if (!originalPrimaryButton || !originalDrawSnapGuide || !originalProcessContextMenu) {
        return false;
    }

    if (!originalPrimaryButton[CANVAS_PATCH_FLAG]) {
        function processPrimaryButtonWithGroupTitle(event, node, ...args) {
            const graph = this.graph;
            const x = Number(event?.canvasX);
            const y = Number(event?.canvasY);
            const group = Number.isFinite(x) && Number.isFinite(y)
                ? graph?.getGroupTitlebarOnPos?.(x, y)
                : null;

            if (!group) return originalPrimaryButton.call(this, event, node, ...args);

            // When a short group's resize corner overlaps the enlarged title,
            // resizing must take priority over dragging the title bar.
            if (group.isInResize?.(x, y)) {
                return originalPrimaryButton.call(this, event, undefined, ...args);
            }

            // The current frontend checks a hard-coded 30px height later in this method.
            // Remap only the hit-test coordinate; drag events keep their real coordinates.
            const originalCanvasY = event.canvasY;
            try {
                event.canvasY = group.pos[1] + 1;
                return originalPrimaryButton.call(this, event, undefined, ...args);
            } finally {
                event.canvasY = originalCanvasY;
            }
        }

        processPrimaryButtonWithGroupTitle[CANVAS_PATCH_FLAG] = true;
        Canvas.prototype._processPrimaryButton = processPrimaryButtonWithGroupTitle;
    }

    if (!originalDrawSnapGuide[SNAP_GUIDE_PATCH_FLAG]) {
        function drawSnapGuideWithDynamicTitle(context, item, ...args) {
            if (!item?.isPointInTitlebar || !item?.boundingRect || !item?.pos) {
                return originalDrawSnapGuide.call(this, context, item, ...args);
            }

            const metrics = getTitleMetrics(item);
            if (metrics.overflowBelow <= 0) {
                return originalDrawSnapGuide.call(this, context, item, ...args);
            }

            const bounds = item.boundingRect;
            const expandedItem = {
                pos: item.pos,
                boundingRect: [
                    bounds[0],
                    bounds[1],
                    bounds[2],
                    bounds[3] + metrics.overflowBelow,
                ],
            };
            return originalDrawSnapGuide.call(this, context, expandedItem, ...args);
        }

        drawSnapGuideWithDynamicTitle[SNAP_GUIDE_PATCH_FLAG] = true;
        Canvas.prototype.drawSnapGuide = drawSnapGuideWithDynamicTitle;
    }

    if (!originalProcessContextMenu[CONTEXT_MENU_PATCH_FLAG]) {
        function processContextMenuWithInlineGroup(node, event, ...args) {
            const x = Number(event?.canvasX);
            const y = Number(event?.canvasY);
            const group = Number.isFinite(x) && Number.isFinite(y)
                ? this.graph?.getGroupTitlebarOnPos?.(x, y)
                : null;
            const ContextMenu = globalThis.LiteGraph?.ContextMenu;
            if (!group || !ContextMenu) {
                return originalProcessContextMenu.call(this, node, event, ...args);
            }

            // LiteGraph opens a context menu on pointerdown. Defer that menu so a
            // horizontal right-button gesture can adjust the group font instead.
            if (
                event?.type === "pointerdown"
                && this[RIGHT_DRAG_FONT_START]?.(event, group)
            ) {
                return;
            }

            const canvasOptions = this.getCanvasMenuOptions?.();
            const groupOptions = group.getMenuOptions?.();
            if (!Array.isArray(canvasOptions) || !Array.isArray(groupOptions)) {
                return originalProcessContextMenu.call(this, node, event, ...args);
            }

            // Keep canvas callbacks unchanged while explicitly supplying the group
            // only to callbacks that previously lived in the Edit Group submenu.
            const inlineGroupOptions = groupOptions.map((item) => {
                if (!item || typeof item !== "object" || typeof item.callback !== "function") {
                    return item;
                }

                const isTitleColorMenu = item.__goohaiTitleColor
                    || item.callback === showTitleColorPickerMenu;
                if (isTitleColorMenu) {
                    return {
                        ...item,
                        content: "标题色",
                        has_submenu: true,
                        callback(...callbackArgs) {
                            callbackArgs[4] = group;
                            return showTitleColorPickerMenu(...callbackArgs);
                        },
                    };
                }

                const isGroupColorMenu = item.__goohaiGroupColor
                    || item.callback.name === "onMenuNodeColors";
                if (isGroupColorMenu) {
                    return {
                        ...item,
                        content: '<span style="display: block; color: #6ee7b7; padding-left: 4px">组颜色</span>',
                        callback(...callbackArgs) {
                            callbackArgs[4] = group;
                            return showGroupColorPreviewMenu(...callbackArgs);
                        },
                    };
                }

                const callbackGroup = item.property === "font_size"
                    ? createBatchFontSizeGroup(group)
                    : group;
                const originalCallback = item.callback;
                return {
                    ...item,
                    callback(...callbackArgs) {
                        callbackArgs[4] = callbackGroup;
                        return originalCallback.apply(this, callbackArgs);
                    },
                };
            });

            const menuInfo = insertGroupOptionsNearTop(canvasOptions, inlineGroupOptions);
            new ContextMenu(menuInfo, { event });
        }

        processContextMenuWithInlineGroup[CONTEXT_MENU_PATCH_FLAG] = true;
        Canvas.prototype.processContextMenu = processContextMenuWithInlineGroup;
    }

    return true;
}

function syncTitleEditorFont(group) {
    const fontSize = Number(group?.font_size);
    if (!Number.isFinite(fontSize) || fontSize <= 0) return false;

    const editor = document.querySelector(".group-title-editor");
    if (!editor) return false;

    const scale = Number(app.canvas?.ds?.scale) || 1;
    const scaledFontSize = fontSize * scale;
    const alignment = getTitleAlignment(group);
    editor.style.fontSize = `${scaledFontSize}px`;
    editor.style.textAlign = alignment;
    const input = editor.querySelector('[data-testid="node-title-input"], input, textarea');
    if (input) {
        input.style.fontSize = `${scaledFontSize}px`;
        input.style.textAlign = alignment;
    }
    return true;
}

function installTitleEditorPatch() {
    if (window[EDITOR_PATCH_FLAG]) return;
    window[EDITOR_PATCH_FLAG] = true;

    document.addEventListener("litegraph:canvas", (event) => {
        if (event.detail?.subType !== "group-double-click") return;
        const group = event.detail.group;
        let attempts = 0;
        const updateEditor = () => {
            attempts += 1;
            if (!syncTitleEditorFont(group) && attempts < 8) {
                window.requestAnimationFrame(updateEditor);
            }
        };
        window.requestAnimationFrame(updateEditor);
    });
}

function patchGroupPrototype() {
    if (window[PATCH_FLAG]) return true;

    const Group = getGroupConstructor();
    if (!Group?.prototype?.draw) return false;

    const originalDraw = Group.prototype.draw;
    const originalResize = Group.prototype.resize;
    const originalSerialize = Group.prototype.serialize;
    const originalConfigure = Group.prototype.configure;
    const originalGetMenuOptions = Group.prototype.getMenuOptions;
    const titleHeightDescriptor = Object.getOwnPropertyDescriptor(Group.prototype, "titleHeight");
    const getOriginalTitleHeight = titleHeightDescriptor?.get;
    const originalIsPointInside = Group.prototype.isPointInside;
    const originalIsInResize = Group.prototype.isInResize;

    Object.defineProperty(Group.prototype, "titleHeight", {
        configurable: true,
        enumerable: titleHeightDescriptor?.enumerable ?? false,
        get() {
            const originalHeight = Number(getOriginalTitleHeight?.call(this)) || 30;
            return getTitleHeight(this, originalHeight);
        },
    });

    Group.prototype.isPointInTitlebar = function isPointInDynamicTitlebar(x, y) {
        const originalHeight = Number(getOriginalTitleHeight?.call(this)) || 30;
        const metrics = getTitleMetrics(this, originalHeight);
        return x >= this.pos[0]
            && x <= this.pos[0] + this.size[0]
            && y >= metrics.top
            && y <= metrics.bottom;
    };

    Group.prototype.isPointInside = function isPointInsideDynamicTitle(x, y) {
        return originalIsPointInside.call(this, x, y) || this.isPointInTitlebar(x, y);
    };

    if (originalIsInResize) {
        Group.prototype.isInResize = function isInDynamicResize(x, y) {
            if (originalIsInResize.call(this, x, y)) return true;

            const originalHeight = Number(getOriginalTitleHeight?.call(this)) || 30;
            const visibleHeight = Math.max(
                Number(this.size?.[1]) || 0,
                getTitleHeight(this, originalHeight),
            );
            if (visibleHeight <= (Number(this.size?.[1]) || 0)) return false;

            const right = this.pos[0] + this.size[0];
            const bottom = this.pos[1] + visibleHeight;
            const resizeLength = Number(this.constructor?.resizeLength) || 10;
            return x < right
                && y < bottom
                && x - right + (y - bottom) > -resizeLength;
        };
    }

    if (originalResize) {
        Group.prototype.resize = function resizeDownToTitle(width, height, ...args) {
            const result = originalResize.call(this, width, height, ...args);
            if (result === false || !this._size) return result;

            // The dynamic title is drawn independently from the stored group height,
            // so retaining the base title height is enough for title-only note groups.
            const minimumHeight = Number(getOriginalTitleHeight?.call(this)) || 30;
            const requestedHeight = Number(height);
            if (Number.isFinite(requestedHeight)) {
                this._size[1] = Math.max(minimumHeight, requestedHeight);
            }
            return result;
        };
    }

    Group.prototype.draw = function drawWithFontSize(canvas, context, ...args) {
        const originalFillText = context.fillText;
        const originalRect = context.rect;
        const group = this;
        const originalTitleHeight = Number(getOriginalTitleHeight?.call(group)) || 30;
        const titleMetrics = getTitleMetrics(group, originalTitleHeight);
        const titleHeight = titleMetrics.height;
        let rectCallIndex = 0;

        context.rect = function drawGroupRect(x, y, width, height) {
            rectCallIndex += 1;
            if (rectCallIndex === 1 && Math.abs(height - originalTitleHeight) < 0.01) {
                return originalRect.call(this, x, y, width, titleHeight);
            }
            // strokeShape() draws the selected-group outline with a third rect.
            // Extend it downward only when a title-only group is shorter than its title.
            if (rectCallIndex === 3 && group.selected && titleMetrics.overflowBelow > 0) {
                return originalRect.call(
                    this,
                    x,
                    y,
                    width,
                    height + titleMetrics.overflowBelow,
                );
            }
            return originalRect.apply(this, arguments);
        };

        context.fillText = function fillGroupTitle(text, ...textArgs) {
            const title = `${group.title ?? ""}`;
            const originalRenderedTitle = `${title}${group.pinned ? "📌" : ""}`;
            const configuredFontSize = Number(group.font_size);
            const fontSize = Number.isFinite(configuredFontSize) && configuredFontSize > 0
                ? configuredFontSize
                : DEFAULT_GROUP_FONT_SIZE;
            if (text === title || text === originalRenderedTitle) {
                const previousFont = context.font;
                const previousTextAlign = context.textAlign;
                const previousFillStyle = context.fillStyle;
                const fontFamily = previousFont.replace(/^\s*[-+]?\d*\.?\d+(?:px|pt|em|rem)\s*/i, "");
                const alignment = getTitleAlignment(group);
                const horizontalPadding = fontSize / 2;
                context.font = `${fontSize}px ${fontFamily || "Inter"}`;
                const customTitleColor = getCustomTitleColor(group, previousFillStyle);
                if (customTitleColor) {
                    context.fillStyle = customTitleColor;
                }
                if (textArgs.length >= 2) {
                    context.textAlign = alignment;
                    if (alignment === "center") {
                        textArgs[0] = group.pos[0] + group.size[0] / 2;
                    } else if (alignment === "right") {
                        textArgs[0] = group.pos[0] + group.size[0] - horizontalPadding;
                    } else {
                        textArgs[0] = group.pos[0] + horizontalPadding;
                    }
                    textArgs[1] = titleMetrics.top + titleHeight / 2 + 1;
                }
                try {
                    // Keep the pinned state and its interaction restrictions, but
                    // draw only the group title without the attention-grabbing pin.
                    return originalFillText.apply(this, [title, ...textArgs]);
                } finally {
                    context.font = previousFont;
                    context.textAlign = previousTextAlign;
                    context.fillStyle = previousFillStyle;
                }
            }
            return originalFillText.apply(this, [text, ...textArgs]);
        };

        try {
            return originalDraw.call(this, canvas, context, ...args);
        } finally {
            context.fillText = originalFillText;
            context.rect = originalRect;
        }
    };
    Group.prototype.draw.__goohaiGroupFontPatched = true;

    if (originalGetMenuOptions) {
        Group.prototype.getMenuOptions = function getMenuOptionsWithTitleAlignment(...args) {
            const options = originalGetMenuOptions.apply(this, args);
            if (!Array.isArray(options)) {
                return options;
            }

            for (let index = 0; index < options.length; index += 1) {
                const item = options[index];
                if (!item || typeof item !== "object") continue;

                const content = String(item.content ?? "").trim().toLowerCase();
                const isOriginalTitleOption = item.property === "title"
                    || content === "title"
                    || content === "标题";
                if (isOriginalTitleOption && !item.__goohaiTitleColor) {
                    options[index] = {
                        ...item,
                        content: "标题色",
                        has_submenu: true,
                        callback: showTitleColorPickerMenu,
                        __goohaiTitleColor: true,
                    };
                    continue;
                }

                const isOriginalGroupColorOption = item.callback?.name === "onMenuNodeColors"
                    || content === "color"
                    || content === "颜色";
                if (isOriginalGroupColorOption && !item.__goohaiGroupColor) {
                    options[index] = {
                        ...item,
                        content: '<span style="display: block; color: #6ee7b7; padding-left: 4px">组颜色</span>',
                        __goohaiGroupColor: true,
                    };
                }
            }

            if (options.some((item) => item?.__goohaiTitleAlignment)) {
                return options;
            }

            const alignmentOption = {
                content: "标题对齐",
                has_submenu: true,
                callback: showTitleAlignmentMenu,
                __goohaiTitleAlignment: true,
            };
            const fontSizeIndex = options.findIndex((item) => item?.property === "font_size");
            options.splice(fontSizeIndex >= 0 ? fontSizeIndex + 1 : options.length, 0, alignmentOption);
            return options;
        };
    }

    if (originalSerialize) {
        Group.prototype.serialize = function serializeWithFontSize(...args) {
            const data = originalSerialize.apply(this, args);
            if (data && Number.isFinite(Number(this.font_size))) data.font_size = Number(this.font_size);
            if (data) data.title_align = getTitleAlignment(this);
            if (data) {
                delete data.title_color;
                const saturation = Number(this.title_color_saturation);
                const brightness = Number(this.title_color_brightness);
                if (Number.isFinite(saturation) && Number.isFinite(brightness)) {
                    data.title_color_saturation = Math.max(0, Math.min(1, saturation));
                    data.title_color_brightness = Math.max(0, Math.min(1, brightness));
                } else {
                    delete data.title_color_saturation;
                    delete data.title_color_brightness;
                }
            }
            return data;
        };
    }

    if (originalConfigure) {
        Group.prototype.configure = function configureWithFontSize(data, ...args) {
            const result = originalConfigure.call(this, data, ...args);
            if (data && data.font_size != null) this.font_size = Number(data.font_size);
            this.title_align = getTitleAlignment(data);
            const saturation = Number(data?.title_color_saturation);
            const brightness = Number(data?.title_color_brightness);
            if (Number.isFinite(saturation) && Number.isFinite(brightness)) {
                this.title_color_saturation = Math.max(0, Math.min(1, saturation));
                this.title_color_brightness = Math.max(0, Math.min(1, brightness));
            } else if (/^#[0-9a-f]{6}$/i.test(String(data?.title_color))) {
                const [, legacySaturation, legacyBrightness] = rgbToHsv(...hexToRgb(data.title_color));
                this.title_color_saturation = legacySaturation;
                this.title_color_brightness = legacyBrightness;
            } else {
                delete this.title_color_saturation;
                delete this.title_color_brightness;
            }
            delete this.title_color;
            return result;
        };
    }

    window[PATCH_FLAG] = true;
    app.canvas?.setDirty?.(true, true);
    console.info("[GroupTitleFontHotfix] group title font size compatibility enabled");
    return true;
}

app.registerExtension({
    name: "Comfy.GroupTitleFontHotfix",
    setup() {
        installTitleEditorPatch();
        const installRuntimePatches = () => {
            const groupPatched = patchGroupPrototype();
            const canvasPatched = patchCanvasPrototype();
            const rightDragPatched = installRightDragFontGesture();
            return groupPatched && canvasPatched && rightDragPatched;
        };
        if (installRuntimePatches()) return;
        const timer = window.setInterval(() => {
            if (installRuntimePatches()) window.clearInterval(timer);
        }, 250);
    },
});

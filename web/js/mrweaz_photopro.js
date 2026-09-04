import { app } from "../../../scripts/app.js";

// Load Darkroom Stylesheet
const link = document.createElement("link");
link.rel = "stylesheet";
link.type = "text/css";
link.href = new URL("../css/mrweaz_photopro.css", import.meta.url).href;
document.head.appendChild(link);

function hideWidget(w) {
    if (!w) return;
    w.hidden = true;
    w.computeSize = () => [0, 0];
    if (w.element) w.element.style.display = "none";
}

function getWidget(node, name) {
    return (node.widgets || []).find(item => item && item.name === name);
}

function syncNodeWidgetValue(node, name, val) {
    if (!node.widgets) node.widgets = [];
    let found = false;
    for (let i = 0; i < node.widgets.length; i++) {
        const w = node.widgets[i];
        if (w && w.name === name) {
            w.value = val;
            found = true;
            if (w.callback) {
                try { w.callback(val); } catch (e) {}
            }
            if (node.widgets_values && i < node.widgets_values.length) {
                node.widgets_values[i] = val;
            }
        }
    }
    if (!found) {
        let type = "string";
        if (typeof val === "number") type = "number";
        else if (typeof val === "boolean") type = "toggle";
        const newW = node.addWidget(type, name, val, () => {});
        hideWidget(newW);
        if (!node.widgets_values) node.widgets_values = [];
        node.widgets_values.push(val);
    }
}

function isPhotoLabMasterNode(node) {
    if (!node) return false;
    const typeStr = (node.comfyClass || node.type || node.title || "").toString();
    return typeStr.includes("PhotoLabMasterSuite") || 
           typeStr.includes("PhotoLab · Master Suite") ||
           typeStr.includes("MrWeaz - PhotoLab") ||
           typeStr.includes("MrWeazPhotoLab");
}

app.registerExtension({
    name: "MrWeaz.PhotoLabMasterUI",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PhotoLabMasterSuite") {
            return;
        }

        nodeType.prototype.nickname = "MrWeaz - PhotoLab";

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            this.nickname = "MrWeaz - PhotoLab";
            const res = origCreated?.apply(this, arguments);
            setupPhotoLabMasterUI(this);
            return res;
        };

        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            this.nickname = "MrWeaz - PhotoLab";
            const res = origConfigure?.apply(this, arguments);
            setupPhotoLabMasterUI(this);
            if (typeof this._syncPhotoLabDOM === "function") {
                this._syncPhotoLabDOM();
            }
            requestAnimationFrame(() => {
                if (typeof this._syncPhotoLabDOM === "function") {
                    this._syncPhotoLabDOM();
                }
                this.setDirtyCanvas?.(true, true);
            });
            return res;
        };
    },

    async nodeCreated(node) {
        if (isPhotoLabMasterNode(node)) {
            setupPhotoLabMasterUI(node);
        }
    },

    async loadedGraphNode(node) {
        if (isPhotoLabMasterNode(node)) {
            setupPhotoLabMasterUI(node);
            if (typeof node._syncPhotoLabDOM === "function") {
                node._syncPhotoLabDOM();
            }
            requestAnimationFrame(() => {
                if (typeof node._syncPhotoLabDOM === "function") {
                    node._syncPhotoLabDOM();
                }
                node.setDirtyCanvas?.(true, true);
            });
        }
    }
});

function setupPhotoLabMasterUI(node) {
    if (!isPhotoLabMasterNode(node)) return;

    const existingWidget = (node.widgets || []).find(w => w && w.name === "mrweaz_photolab_ui");
    if (existingWidget && node._photolab_ui_attached) {
        if (typeof node._syncPhotoLabDOM === "function") {
            node._syncPhotoLabDOM();
        }
        return;
    }

    node._photolab_ui_attached = true;

    // Darkroom canvas styling
    node.color = "#151928";
    node.bgcolor = "#0b0e18";

    // Hide raw LiteGraph canvas widgets so they do not stack vertically
    if (node.widgets && Array.isArray(node.widgets)) {
        for (const w of node.widgets) {
            if (w && w.name !== "mrweaz_photolab_ui") {
                hideWidget(w);
            }
        }
    }

    try {
        const root = document.createElement("div");
        root.className = "mrweaz-photolab-container";

        buildDarkroomUI(node, root);

        const getWidgetHeight = () => {
            let nodeH = (node.size && node.size[1]) ? node.size[1] : 760;
            if (nodeH > 1050) nodeH = 760;
            return Math.max(500, nodeH - 120);
        };

        const domWidget = node.addDOMWidget("mrweaz_photolab_ui", "div", root, { 
            serialize: false,
            hideOnZoom: false,
            getHeight: getWidgetHeight,
            getMinHeight: () => 500,
        });

        if (domWidget) {
            domWidget.computeSize = function (width) {
                const w = Math.max(Number(width) || 640, 540);
                return [w, getWidgetHeight()];
            };
            domWidget.computeLayoutSize = function () {
                const h = getWidgetHeight();
                return { minHeight: h, maxHeight: h, minWidth: 540 };
            };
        }

        node.computeSize = function (out) {
            const w = Math.max(this.size?.[0] || 640, 540);
            let h = this.size?.[1] || 760;
            if (h > 1050) h = 760;
            h = Math.max(h, 600);
            if (out) {
                out[0] = w;
                out[1] = h;
                return out;
            }
            return [w, h];
        };

        node.onResize = function (size) {
            size[0] = Math.max(size[0], 540);
            size[1] = Math.max(size[1], 600);
            this.size[0] = size[0];
            this.size[1] = size[1];
        };

        // Enforce compact, beautifully proportioned node bounds
        if (!node.size || !Array.isArray(node.size)) {
            node.size = [640, 760];
        } else {
            node.size[0] = Math.max(node.size[0] || 640, 540);
            if (node.size[1] > 1050 || node.size[1] < 600) {
                node.size[1] = 760;
            }
        }
        node.min_size = [540, 600];
        node.resizable = true;
        node.setSize?.([node.size[0], node.size[1]]);

    } catch (err) {
        console.error("[PhotoLab Master] Error mounting interactive UI:", err);
    }
}

function buildDarkroomUI(node, root) {
    let activeTabId = "retouch";

    // Registry of card controllers and slider synchronizers
    const cardControllers = {};
    const sliderSynchronizers = {};

    // Internal toggle state backed by node.properties and widgets
    node.properties = node.properties || {};
    node.properties._pl_toggles = node.properties._pl_toggles || {};

    function getToggleState(name, fallback = false) {
        const w = getWidget(node, name);
        if (node.properties._pl_toggles[name] !== undefined) {
            return Boolean(node.properties._pl_toggles[name]);
        }
        if (w && w.value !== undefined && w.value !== null) {
            const b = Boolean(w.value);
            node.properties._pl_toggles[name] = b;
            return b;
        }
        return fallback;
    }

    function setToggleState(name, val) {
        const b = Boolean(val);
        node.properties._pl_toggles[name] = b;
        syncNodeWidgetValue(node, name, b);
        if (cardControllers[name]) {
            cardControllers[name].updateState(b);
        }
        updateActiveState();
        app.graph?.setDirtyCanvas(true, true);
    }

    function setWidgetValue(name, val) {
        syncNodeWidgetValue(node, name, val);
        if (sliderSynchronizers[name]) {
            sliderSynchronizers[name](val);
        }
        app.graph?.setDirtyCanvas(true, true);
    }

    function getWidgetVal(name, fallback) {
        const w = getWidget(node, name);
        return w !== undefined && w.value !== undefined ? w.value : fallback;
    }

    // 1. TOP HEADER BAR
    const header = document.createElement("div");
    header.className = "pl-header";

    const allCards = [];

    const titleBox = document.createElement("div");
    titleBox.className = "pl-header-title";
    titleBox.innerHTML = `<span>📷</span><span>MrWeaz - PhotoLab</span>`;

    const controlsBox = document.createElement("div");
    controlsBox.className = "pl-header-controls";

    const statusPill = document.createElement("div");
    statusPill.className = "pl-status-pill";
    statusPill.textContent = "0 Active";

    const toggleCollapseBtn = document.createElement("button");
    toggleCollapseBtn.className = "pl-btn-sm";
    toggleCollapseBtn.title = "Expand or collapse all sections";
    toggleCollapseBtn.textContent = "⊞ Expand All";
    toggleCollapseBtn.addEventListener("click", () => {
        const anyCollapsed = allCards.some(c => c.classList.contains("collapsed"));
        allCards.forEach(c => {
            c.classList.toggle("collapsed", !anyCollapsed);
        });
        toggleCollapseBtn.textContent = anyCollapsed ? "⊟ Collapse All" : "⊞ Expand All";
    });

    const bypassBtn = document.createElement("button");
    bypassBtn.className = "pl-btn-sm";
    bypassBtn.title = "Turn off all processing modules for clean passthrough";
    bypassBtn.textContent = "Bypass All";

    controlsBox.appendChild(statusPill);
    controlsBox.appendChild(toggleCollapseBtn);
    controlsBox.appendChild(bypassBtn);
    header.appendChild(titleBox);
    header.appendChild(controlsBox);
    root.appendChild(header);

    // 2. TABS BAR
    const tabsBar = document.createElement("div");
    tabsBar.className = "pl-tabs-bar";

    const TABS = [
        { id: "retouch", label: "🎯 Retouch & AI", modules: ["enable_diffusion", "enable_frequency_retouch", "enable_sss"] },
        { id: "color", label: "💡 Light & Tone", modules: ["enable_relighting", "enable_lut", "enable_film_stock", "enable_color_grade", "enable_shoulder"] },
        { id: "optics", label: "🔬 Optics Bench", modules: ["enable_distortion", "enable_dof", "enable_atmosphere", "enable_mist", "enable_flare", "enable_halation", "enable_lateral_ca", "enable_vignette"] },
        { id: "grain", label: "🎞️ Film Grain", modules: ["enable_grain"] },
        { id: "presets", label: "🎬 Master Looks", modules: [] },
    ];

    const tabButtons = {};
    const tabPanels = {};

    TABS.forEach(t => {
        const btn = document.createElement("button");
        btn.className = `pl-tab-btn ${t.id === activeTabId ? "active" : ""}`;
        btn.innerHTML = `<span>${t.label}</span><span class="pl-tab-dot" style="display: none;"></span>`;
        btn.addEventListener("click", () => {
            activeTabId = t.id;
            Object.keys(tabButtons).forEach(k => tabButtons[k].classList.toggle("active", k === activeTabId));
            Object.keys(tabPanels).forEach(k => tabPanels[k].classList.toggle("active", k === activeTabId));
        });
        tabsBar.appendChild(btn);
        tabButtons[t.id] = btn;
    });
    root.appendChild(tabsBar);

    // 3. TAB VIEWPORT
    const viewport = document.createElement("div");
    viewport.className = "pl-viewport";
    root.appendChild(viewport);

    TABS.forEach(t => {
        const p = document.createElement("div");
        p.className = `pl-panel ${t.id === activeTabId ? "active" : ""}`;
        viewport.appendChild(p);
        tabPanels[t.id] = p;
    });

    // 4. FOOTER STATUS BAR
    const footer = document.createElement("div");
    footer.className = "pl-footer";
    const footerTags = document.createElement("div");
    footerTags.className = "pl-footer-tags";
    footer.innerHTML = `<span>⚙️ 17-Stage Physical & Optical Pipeline</span>`;
    footer.appendChild(footerTags);
    root.appendChild(footer);

    function updateActiveState() {
        const activeModules = [];
        const moduleMap = {
            enable_diffusion: "AI Inpaint",
            enable_frequency_retouch: "Freq Retouch",
            enable_sss: "Subsurface",
            enable_relighting: "Relight",
            enable_lut: "3D LUT",
            enable_film_stock: "Film Stock",
            enable_color_grade: "Color Grade",
            enable_shoulder: "Shoulder",
            enable_distortion: "Distortion",
            enable_dof: "Bokeh DoF",
            enable_atmosphere: "Atmosphere",
            enable_mist: "Pro-Mist",
            enable_flare: "Flare",
            enable_halation: "Halation",
            enable_lateral_ca: "Chromatic",
            enable_vignette: "Vignette",
            enable_grain: "Grain"
        };

        Object.keys(moduleMap).forEach(k => {
            if (getToggleState(k, false)) {
                activeModules.push(moduleMap[k]);
            }
        });

        statusPill.textContent = `${activeModules.length} Active`;
        statusPill.style.background = activeModules.length > 0 ? "rgba(245, 158, 11, 0.25)" : "rgba(255, 255, 255, 0.08)";
        statusPill.style.color = activeModules.length > 0 ? "#fbbf24" : "#94a3b8";

        // Update tab active dots
        TABS.forEach(t => {
            const hasActive = t.modules.some(m => getToggleState(m, false));
            const dot = tabButtons[t.id]?.querySelector(".pl-tab-dot");
            if (dot) dot.style.display = hasActive ? "inline-block" : "none";
        });

        // Update footer tags
        footerTags.innerHTML = "";
        activeModules.slice(0, 5).forEach(m => {
            const tag = document.createElement("span");
            tag.className = "pl-footer-tag";
            tag.textContent = m;
            footerTags.appendChild(tag);
        });
        if (activeModules.length > 5) {
            const tag = document.createElement("span");
            tag.className = "pl-footer-tag";
            tag.textContent = `+${activeModules.length - 5} more`;
            footerTags.appendChild(tag);
        }
    }

    // --- Feature Card Builder with On/Off Toggle & Collapsible Sections ---
    function createFeatureCard(parent, title, icon, toggleWidgetName, defaultCollapsed = true) {
        const card = document.createElement("div");
        const hasToggle = Boolean(toggleWidgetName);
        const initialActive = hasToggle ? getToggleState(toggleWidgetName, false) : true;
        card.className = `pl-card ${initialActive ? "active" : "disabled"}`;
        if (defaultCollapsed) {
            card.classList.add("collapsed");
        }
        allCards.push(card);

        const header = document.createElement("div");
        header.className = "pl-card-header";
        header.title = "Click to expand / collapse section";

        const titleDiv = document.createElement("div");
        titleDiv.className = "pl-card-title";

        const chevron = document.createElement("span");
        chevron.className = "pl-card-chevron";
        chevron.innerHTML = "▸";
        titleDiv.appendChild(chevron);

        const labelSpan = document.createElement("span");
        labelSpan.innerHTML = `<span>${icon}</span> <span>${title}</span>`;
        titleDiv.appendChild(labelSpan);

        header.appendChild(titleDiv);

        header.addEventListener("click", () => {
            card.classList.toggle("collapsed");
            const anyCollapsed = allCards.some(c => c.classList.contains("collapsed"));
            if (toggleCollapseBtn) {
                toggleCollapseBtn.textContent = anyCollapsed ? "⊞ Expand All" : "⊟ Collapse All";
            }
        });

        if (hasToggle) {
            const sw = document.createElement("div");
            sw.className = `pl-switch ${initialActive ? "on" : ""}`;
            sw.innerHTML = `
                <span class="pl-switch-label">${initialActive ? "ON" : "OFF"}</span>
                <div class="pl-switch-track"><div class="pl-switch-thumb"></div></div>
            `;

            function updateCardVisuals(val) {
                sw.classList.toggle("on", val);
                const labelEl = sw.querySelector(".pl-switch-label");
                if (labelEl) labelEl.textContent = val ? "ON" : "OFF";
                card.classList.toggle("active", val);
                card.classList.toggle("disabled", !val);
            }

            sw.addEventListener("click", (e) => {
                e.stopPropagation();
                const current = getToggleState(toggleWidgetName, false);
                const next = !current;
                setToggleState(toggleWidgetName, next);
            });

            cardControllers[toggleWidgetName] = {
                updateState: (val) => updateCardVisuals(val)
            };
            header.appendChild(sw);
        }

        card.appendChild(header);

        const body = document.createElement("div");
        body.className = "pl-card-body";
        card.appendChild(body);
        parent.appendChild(card);

        return body;
    }

    // --- Slider Row Builder with Live Value Sync ---
    function createSlider(parent, label, widgetName, min, max, step, defVal) {
        const row = document.createElement("div");
        row.className = "pl-row";

        const lbl = document.createElement("div");
        lbl.className = "pl-row-label";
        lbl.textContent = label;

        const wrap = document.createElement("div");
        wrap.className = "pl-slider-wrap";

        const slider = document.createElement("input");
        slider.type = "range";
        slider.className = "pl-slider";
        slider.min = min;
        slider.max = max;
        slider.step = step;
        slider.value = getWidgetVal(widgetName, defVal);

        const num = document.createElement("input");
        num.type = "number";
        num.className = "pl-num-input";
        num.min = min;
        num.max = max;
        num.step = step;
        const formatVal = (v) => Number(v).toFixed(step < 0.01 ? 3 : (step < 0.1 ? 2 : (step < 1 ? 1 : 0)));
        num.value = formatVal(slider.value);

        const resetBtn = document.createElement("button");
        resetBtn.className = "pl-btn-sm";
        resetBtn.style.padding = "2px 5px";
        resetBtn.title = `Reset to default (${defVal})`;
        resetBtn.textContent = "↺";

        slider.addEventListener("input", (e) => {
            const v = parseFloat(e.target.value);
            num.value = formatVal(v);
            setWidgetValue(widgetName, v);
        });

        num.addEventListener("change", (e) => {
            let v = parseFloat(e.target.value);
            if (isNaN(v)) v = defVal;
            v = Math.max(min, Math.min(max, v));
            slider.value = v;
            num.value = formatVal(v);
            setWidgetValue(widgetName, v);
        });

        resetBtn.addEventListener("click", () => {
            slider.value = defVal;
            num.value = formatVal(defVal);
            setWidgetValue(widgetName, defVal);
        });

        sliderSynchronizers[widgetName] = (newVal) => {
            slider.value = newVal;
            num.value = formatVal(newVal);
        };

        wrap.appendChild(slider);
        wrap.appendChild(num);
        wrap.appendChild(resetBtn);
        row.appendChild(lbl);
        row.appendChild(wrap);
        parent.appendChild(row);
    }

    // --- Select Row Builder ---
    function createSelect(parent, label, widgetName, optionsList) {
        const row = document.createElement("div");
        row.className = "pl-row";

        const lbl = document.createElement("div");
        lbl.className = "pl-row-label";
        lbl.textContent = label;

        const sel = document.createElement("select");
        sel.className = "pl-select";

        const currentVal = getWidgetVal(widgetName, "");
        optionsList.forEach(opt => {
            const el = document.createElement("option");
            el.value = opt;
            el.textContent = opt;
            if (opt === currentVal) el.selected = true;
            sel.appendChild(el);
        });

        sel.addEventListener("change", (e) => {
            setWidgetValue(widgetName, e.target.value);
        });

        sliderSynchronizers[widgetName] = (newVal) => {
            sel.value = newVal;
        };

        row.appendChild(lbl);
        row.appendChild(sel);
        parent.appendChild(row);
    }

    // --- Textarea Row Builder ---
    function createTextarea(parent, label, widgetName) {
        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.flexDirection = "column";
        row.style.gap = "4px";

        const lbl = document.createElement("div");
        lbl.className = "pl-row-label";
        lbl.textContent = label;

        const ta = document.createElement("textarea");
        ta.className = "pl-textarea";
        ta.value = getWidgetVal(widgetName, "");

        const handleVal = (val) => {
            setWidgetValue(widgetName, val);
        };

        ta.addEventListener("input", (e) => handleVal(e.target.value));
        ta.addEventListener("change", (e) => handleVal(e.target.value));
        ta.addEventListener("blur", (e) => handleVal(e.target.value));

        sliderSynchronizers[widgetName] = (newVal) => {
            ta.value = newVal;
        };

        row.appendChild(lbl);
        row.appendChild(ta);
        parent.appendChild(row);
    }

    // --- Seed Row with Dice ---
    function createSeedRow(parent, label, widgetName) {
        const row = document.createElement("div");
        row.className = "pl-row";

        const lbl = document.createElement("div");
        lbl.className = "pl-row-label";
        lbl.textContent = label;

        const wrap = document.createElement("div");
        wrap.style.display = "flex";
        wrap.style.alignItems = "center";
        wrap.style.gap = "6px";
        wrap.style.flex = "1";

        const num = document.createElement("input");
        num.type = "number";
        num.className = "pl-num-input";
        num.style.flex = "1";
        num.value = getWidgetVal(widgetName, 0);

        num.addEventListener("change", (e) => {
            setWidgetValue(widgetName, parseInt(e.target.value) || 0);
        });

        const diceBtn = document.createElement("button");
        diceBtn.className = "pl-btn-sm";
        diceBtn.title = "Roll random seed";
        diceBtn.textContent = "🎲 Random";
        diceBtn.addEventListener("click", () => {
            const rand = Math.floor(Math.random() * 9007199254740991);
            num.value = rand;
            setWidgetValue(widgetName, rand);
        });

        sliderSynchronizers[widgetName] = (newVal) => {
            num.value = newVal;
        };

        wrap.appendChild(num);
        wrap.appendChild(diceBtn);
        row.appendChild(lbl);
        row.appendChild(wrap);
        parent.appendChild(row);
    }

    // --- Inline Switch Row Builder ---
    function createInlineToggle(parent, label, widgetName, defVal = true) {
        const row = document.createElement("div");
        row.className = "pl-row";

        const lbl = document.createElement("div");
        lbl.className = "pl-row-label";
        lbl.textContent = label;

        const initial = getToggleState(widgetName, defVal);
        const sw = document.createElement("div");
        sw.className = `pl-switch pl-switch-sm ${initial ? "on" : ""}`;
        sw.innerHTML = `
            <span class="pl-switch-label">${initial ? "ON" : "OFF"}</span>
            <div class="pl-switch-track"><div class="pl-switch-thumb"></div></div>
        `;

        sw.addEventListener("click", (e) => {
            e.stopPropagation();
            const current = getToggleState(widgetName, defVal);
            const next = !current;
            setToggleState(widgetName, next);
            sw.classList.toggle("on", next);
            const labelEl = sw.querySelector(".pl-switch-label");
            if (labelEl) labelEl.textContent = next ? "ON" : "OFF";
        });

        sliderSynchronizers[widgetName] = (newVal) => {
            const b = Boolean(newVal);
            sw.classList.toggle("on", b);
            const labelEl = sw.querySelector(".pl-switch-label");
            if (labelEl) labelEl.textContent = b ? "ON" : "OFF";
        };

        row.appendChild(lbl);
        row.appendChild(sw);
        parent.appendChild(row);
    }

    // =========================================================================
    // TAB 1: RETOUCH & AI
    // =========================================================================
    const pRetouch = tabPanels["retouch"];

    // Card 0: Auto-Masking & SAM Engine
    const bMask = createFeatureCard(pRetouch, "Auto-Masking & SAM Engine", "🎯", "enable_mask");
    const autoMaskW = node.widgets?.find(w => w && w.name === "auto_mask");
    const autoMaskList = autoMaskW?.options?.values || [
        "SAM Auto-Subject", "Depth Foreground Isolation", "Skin & Portrait Tones", "Specular Highlights", "Shadows & Blacks"
    ];
    createSelect(bMask, "Auto-Mask Mode", "auto_mask", autoMaskList);
    createTextarea(bMask, "SAM Prompt / Target", "sam_prompt");

    // Quick target prompt chips & guidance
    const promptHint = document.createElement("div");
    promptHint.style.fontSize = "11px";
    promptHint.style.color = "#94a3b8";
    promptHint.style.marginTop = "3px";
    promptHint.style.lineHeight = "1.3";
    promptHint.innerHTML = `<span>💡 Prompt any subject: <i>face, hair, lips, hands, clothes, dog, car, background</i>, or coordinates <i>(0.5, 0.3)</i></span>`;
    bMask.appendChild(promptHint);

    const chipRow = document.createElement("div");
    chipRow.style.display = "flex";
    chipRow.style.flexWrap = "wrap";
    chipRow.style.gap = "4px";
    chipRow.style.marginTop = "4px";
    chipRow.style.marginBottom = "8px";

    const CHIPS = [
        { label: "👤 Subject", val: "subject" },
        { label: "😊 Face", val: "face" },
        { label: "💇 Hair", val: "hair" },
        { label: "👄 Lips", val: "lips" },
        { label: "✋ Hands", val: "hands" },
        { label: "👕 Clothes", val: "clothes" },
        { label: "🐕 Pet", val: "dog" },
        { label: "🚗 Car", val: "car" },
        { label: "🌄 Background", val: "background" },
    ];

    CHIPS.forEach(c => {
        const chip = document.createElement("button");
        chip.className = "pl-btn-sm";
        chip.style.fontSize = "10px";
        chip.style.padding = "2px 6px";
        chip.textContent = c.label;
        chip.title = `Prompt SAM for: ${c.val}`;
        chip.addEventListener("click", () => {
            setWidgetValue("sam_prompt", c.val);
            const ta = bMask.querySelector(".pl-textarea");
            if (ta) ta.value = c.val;
        });
        chipRow.appendChild(chip);
    });
    bMask.appendChild(chipRow);


    const maskScopeW = node.widgets?.find(w => w && w.name === "mask_scope");
    const maskScopeList = maskScopeW?.options?.values || ["Retouch Only", "All Effects"];
    createSelect(bMask, "Mask Target Scope", "mask_scope", maskScopeList);

    const samW = node.widgets?.find(w => w && w.name === "sam_model");
    const samList = samW?.options?.values || ["sam_vit_b_01ec64.pth"];
    createSelect(bMask, "SAM Model Checkpoint", "sam_model", samList);

    createInlineToggle(bMask, "Depth-Assisted Center Snapping", "sam_depth_assist", true);
    createInlineToggle(bMask, "Invert Active Mask", "invert_mask", false);
    createSlider(bMask, "SAM Prompt Center X", "sam_point_x", 0.0, 1.0, 0.01, 0.50);
    createSlider(bMask, "SAM Prompt Center Y", "sam_point_y", 0.0, 1.0, 0.01, 0.50);
    createSlider(bMask, "Mask Edge Feather (px)", "mask_feather", 0, 128, 2, 16);

    // Card A: Neural Diffusion Inpaint
    const bDiff = createFeatureCard(pRetouch, "Neural Diffusion Inpaint", "⚡", "enable_diffusion");

    // Dynamic Source Status Banner
    const bannerContainer = document.createElement("div");
    bannerContainer.className = "pl-source-banner";
    bDiff.appendChild(bannerContainer);

    function updateModelSourceBanner() {
        const hasModel = Boolean(node.inputs?.some(i => i.name === "model" && i.link != null));
        const hasClip = Boolean(node.inputs?.some(i => i.name === "clip" && i.link != null));
        const hasVae = Boolean(node.inputs?.some(i => i.name === "vae" && i.link != null));
        const hasPos = Boolean(node.inputs?.some(i => i.name === "positive" && i.link != null));

        bannerContainer.innerHTML = "";
        const box = document.createElement("div");
        box.className = "pl-banner-box";

        if (hasModel && hasVae && (hasClip || hasPos)) {
            box.classList.add("pl-banner-modular");
            box.innerHTML = `
                <div class="pl-banner-title"><span>⚡</span><span>External Model Loaded</span></div>
                <div class="pl-banner-sub">Connected: <b>MODEL</b> • <b>${hasClip ? "CLIP" : ""} ${hasPos ? "CONDITIONING" : ""}</b> • <b>VAE</b>. (Internal Checkpoint dropdown bypassed)</div>
            `;
        } else if (hasModel && hasVae) {
            box.classList.add("pl-banner-modular");
            box.innerHTML = `
                <div class="pl-banner-title"><span>⚡</span><span>External Model Loaded</span></div>
                <div class="pl-banner-sub">Connected: <b>MODEL</b> • <b>VAE</b>. Connect <b>CLIP</b> to guide generation with text prompts.</div>
            `;
        } else if (hasModel || hasClip || hasVae) {
            box.classList.add("pl-banner-warning");
            const missing = [];
            if (!hasModel) missing.push("MODEL");
            if (!hasClip && !hasPos) missing.push("CLIP / CONDITIONING");
            if (!hasVae) missing.push("VAE");
            box.innerHTML = `
                <div class="pl-banner-title"><span>⚠️</span><span>Modular Setup Incomplete</span></div>
                <div class="pl-banner-sub">Missing: <b>${missing.join(", ")}</b>. Connect all 3 sockets or use Checkpoint loader below.</div>
            `;
        } else {
            box.classList.add("pl-banner-info");
            box.innerHTML = `
                <div class="pl-banner-title"><span>ℹ️</span><span>Dual Retouch Engine</span></div>
                <div class="pl-banner-sub">Use Checkpoint dropdown below, OR connect external <b>MODEL, CLIP & VAE</b> inputs.</div>
            `;
        }
        bannerContainer.appendChild(box);
    }

    // Call initially
    updateModelSourceBanner();

    // Hook connection changes
    const prevOnConnChange = node.onConnectionsChange;
    node.onConnectionsChange = function () {
        if (prevOnConnChange) prevOnConnChange.apply(this, arguments);
        updateModelSourceBanner();
    };

    const ckptW = node.widgets?.find(w => w && w.name === "checkpoint");
    const ckptList = ckptW?.options?.values || ["None"];
    createSelect(bDiff, "Model Checkpoint", "checkpoint", ckptList);
    createTextarea(bDiff, "Positive Prompt", "positive_prompt");
    createTextarea(bDiff, "Negative Prompt", "negative_prompt");
    createSlider(bDiff, "Denoise Strength", "diff_denoise", 0.0, 1.0, 0.01, 0.25);
    createSlider(bDiff, "Sampling Steps", "diff_steps", 1, 50, 1, 8);
    createSlider(bDiff, "CFG Scale", "diff_cfg", 0.0, 12.0, 0.1, 1.0);

    const samplerW = node.widgets?.find(w => w && w.name === "sampler_name");
    const samplerList = samplerW?.options?.values || [
        "euler", "euler_cfg_pp", "euler_ancestral", "euler_ancestral_cfg_pp",
        "heun", "heunpp2", "dpm_2", "dpm_2_ancestral", "lms", "dpm_fast",
        "dpm_adaptive", "dpmpp_2s_ancestral", "dpmpp_sde", "dpmpp_sde_gpu",
        "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_2m_sde_gpu", "dpmpp_3m_sde",
        "dpmpp_3m_sde_gpu", "ddpm", "lcm", "ipndm", "deis", "uni_pc", "uni_pc_bh2"
    ];
    createSelect(bDiff, "Sampler", "sampler_name", samplerList);

    const schedW = node.widgets?.find(w => w && w.name === "scheduler");
    const schedList = schedW?.options?.values || [
        "simple", "normal", "karras", "exponential", "sgm_uniform", "kl_optimal", "turbo", "align_your_steps", "beta"
    ];
    createSelect(bDiff, "Scheduler", "scheduler", schedList);

    createSeedRow(bDiff, "Seed", "diff_seed");

    // Card B: Frequency Separation Retouch
    const bFreq = createFeatureCard(pRetouch, "Frequency Separation Retouch", "✂️", "enable_frequency_retouch");
    createSlider(bFreq, "Skin Smooth", "skin_smooth", 0.0, 1.0, 0.05, 0.40);
    createSlider(bFreq, "Separation Radius", "smooth_radius", 1, 45, 2, 7);
    createSlider(bFreq, "Texture Clarity", "clarity", -1.0, 1.0, 0.05, 0.15);

    // Card C: Subsurface Scattering
    const bSss = createFeatureCard(pRetouch, "Subsurface Skin Scattering (SSS)", "🩸", "enable_sss");
    createSlider(bSss, "Scatter Amount", "sss_amount", 0.0, 1.0, 0.05, 0.25);
    createSlider(bSss, "Scatter Radius", "sss_radius", 2, 48, 2, 14);
    createSlider(bSss, "Red Bleed", "sss_tint_r", 0.0, 1.5, 0.05, 1.0);
    createSlider(bSss, "Green Bleed", "sss_tint_g", 0.0, 1.0, 0.05, 0.28);
    createSlider(bSss, "Blue Bleed", "sss_tint_b", 0.0, 1.0, 0.05, 0.08);

    // =========================================================================
    // TAB 2: LIGHT & TONE
    // =========================================================================
    const pColor = tabPanels["color"];

    // Card 0A: Auto White Balance (AWB)
    const bAWB = createFeatureCard(pColor, "Auto White Balance (AWB)", "⚖️", "enable_auto_wb");
    const awbModeW = node.widgets?.find(w => w && w.name === "auto_wb_mode");
    const awbModeList = awbModeW?.options?.values || ["Robust Neutral", "Gray World", "White Patch"];
    createSelect(bAWB, "AWB Estimation Mode", "auto_wb_mode", awbModeList);
    createSlider(bAWB, "AWB Neutralize Strength", "auto_wb_strength", 0.0, 1.0, 0.05, 0.80);

    // Card 0B: Auto Color & Dynamic Range
    const bAutoColor = createFeatureCard(pColor, "Auto Color & Dynamic Range", "🎚️", "enable_auto_color");
    const autoColorModeW = node.widgets?.find(w => w && w.name === "auto_color_mode");
    const autoColorModeList = autoColorModeW?.options?.values || ["Full Dynamic Balance", "Luma Contrast Only", "Auto Vibrance"];
    createSelect(bAutoColor, "Auto Color Mode", "auto_color_mode", autoColorModeList);
    createSlider(bAutoColor, "Correction Strength", "auto_color_strength", 0.0, 1.0, 0.05, 0.75);

    // Card A: Studio Relighting
    const bLight = createFeatureCard(pColor, "Studio Exposure Relighting", "💡", "enable_relighting");
    createInlineToggle(bLight, "3D Depth-Aware Relight", "relight_use_depth", true);
    createSlider(bLight, "Light EV Intensity", "light_intensity", -2.0, 2.0, 0.05, 0.35);
    createSlider(bLight, "Light Center X", "light_x", 0.0, 1.0, 0.01, 0.5);
    createSlider(bLight, "Light Center Y", "light_y", 0.0, 1.0, 0.01, 0.5);
    createSlider(bLight, "Light 3D Depth (Z)", "light_z", 0.0, 1.0, 0.02, 0.20);
    createSlider(bLight, "Light Radius", "light_radius", 0.05, 2.5, 0.05, 0.65);
    createSlider(bLight, "Color R", "light_color_r", 0.0, 2.0, 0.05, 1.0);
    createSlider(bLight, "Color G", "light_color_g", 0.0, 2.0, 0.05, 0.95);
    createSlider(bLight, "Color B", "light_color_b", 0.0, 2.0, 0.05, 0.88);

    // Card B: 3D LUT Engine
    const bLut = createFeatureCard(pColor, "3D .cube LUT Engine", "🎨", "enable_lut");
    const lutW = node.widgets?.find(w => w && w.name === "lut_file");
    const lutList = lutW?.options?.values || ["None"];
    createSelect(bLut, "LUT File (.cube)", "lut_file", lutList);
    createSlider(bLut, "LUT Strength", "lut_strength", 0.0, 1.0, 0.05, 1.0);

    // Card C: Film Stock Profiles
    const bStock = createFeatureCard(pColor, "Iconic Film Stock Profiles", "🎞️", "enable_film_stock");
    const stockW = node.widgets?.find(w => w && w.name === "film_stock");
    const stockList = stockW?.options?.values || [
        "None",
        "Kodak Portra 400",
        "Kodak Portra 800",
        "Kodak Gold 200",
        "Kodak CineStill 800T",
        "Kodak Vision3 500T",
        "Kodak Tri-X 400 (B&W)",
        "Ilford HP5 Plus (B&W)",
        "Fuji Pro 400H",
        "Fuji Velvia 50",
        "Fuji Superia 400",
        "Kodachrome 64",
        "Agfa Vista 200",
        "Polaroid 600"
    ];
    createSelect(bStock, "Film Stock", "film_stock", stockList);
    createSlider(bStock, "Stock Mix", "stock_mix", 0.0, 1.0, 0.05, 0.80);

    // Card D: Manual Color Grade & Tone
    const bGrade = createFeatureCard(pColor, "Manual Color & Exposure", "🎛️", "enable_color_grade");
    createSlider(bGrade, "Exposure (EV)", "exposure", -3.0, 3.0, 0.05, 0.0);
    createSlider(bGrade, "Contrast", "contrast", 0.5, 2.0, 0.05, 1.0);
    createSlider(bGrade, "Temperature", "temperature", -1.0, 1.0, 0.05, 0.0);
    createSlider(bGrade, "Tint", "tint", -1.0, 1.0, 0.05, 0.0);
    createSlider(bGrade, "Saturation", "saturation", 0.0, 2.0, 0.05, 1.0);

    // Card E: Filmic Highlight Shoulder
    const bShoulder = createFeatureCard(pColor, "Highlight Shoulder Rolloff", "🌄", "enable_shoulder");
    createSlider(bShoulder, "Shoulder Start", "shoulder_start", 0.4, 1.0, 0.02, 0.72);
    createSlider(bShoulder, "Rolloff Softness", "rolloff_softness", 0.1, 1.5, 0.05, 0.80);
    createSlider(bShoulder, "Highlight Desat", "highlight_desat", 0.0, 1.0, 0.05, 0.60);

    // =========================================================================
    // TAB 3: OPTICS BENCH
    // =========================================================================
    const pOptics = tabPanels["optics"];

    // Card 1: Lens Curvature & Distortion
    const bDist = createFeatureCard(pOptics, "Lens Curvature & Distortion", "📐", "enable_distortion");
    createSlider(bDist, "Curvature", "lens_distortion", -0.30, 0.30, 0.001, -0.015);

    // Quick prime lens focal length buttons
    const distPresets = document.createElement("div");
    distPresets.className = "pl-quick-buttons";
    const p24 = document.createElement("button");
    p24.className = "pl-btn-preset";
    p24.textContent = "24mm (-0.03)";
    p24.title = "Wide angle barrel distortion";
    p24.addEventListener("click", () => setWidgetValue("lens_distortion", -0.03));

    const p35 = document.createElement("button");
    p35.className = "pl-btn-preset";
    p35.textContent = "35mm (-0.015)";
    p35.title = "Subtle 35mm street prime curvature";
    p35.addEventListener("click", () => setWidgetValue("lens_distortion", -0.015));

    const p50 = document.createElement("button");
    p50.className = "pl-btn-preset";
    p50.textContent = "50mm (0.0)";
    p50.title = "Flat optical alignment";
    p50.addEventListener("click", () => setWidgetValue("lens_distortion", 0.0));

    const p85 = document.createElement("button");
    p85.className = "pl-btn-preset";
    p85.textContent = "85mm (+0.02)";
    p85.title = "Telephoto pincushion compression";
    p85.addEventListener("click", () => setWidgetValue("lens_distortion", 0.02));

    distPresets.appendChild(p24);
    distPresets.appendChild(p35);
    distPresets.appendChild(p50);
    distPresets.appendChild(p85);
    bDist.appendChild(distPresets);

    // Card 2: Optical Depth of Field (True Disc Bokeh)
    const bDof = createFeatureCard(pOptics, "Depth of Field & Disc Bokeh", "🎯", "enable_dof");

    // Depth Map Status Banner
    const depthBanner = document.createElement("div");
    depthBanner.className = "pl-source-banner";
    bDof.appendChild(depthBanner);

    function updateDepthBanner() {
        const hasDepth = Boolean(node.inputs?.some(i => i.name === "depth_map" && i.link != null));
        depthBanner.innerHTML = "";
        const box = document.createElement("div");
        box.className = "pl-banner-box " + (hasDepth ? "pl-banner-modular" : "pl-banner-info");
        box.innerHTML = hasDepth ?
            `<div class="pl-banner-title"><span>🟢</span><span>External Depth Map Connected</span></div><div class="pl-banner-sub">Using connected 'depth_map' socket for 3D bokeh isolation & focal tracking.</div>` :
            `<div class="pl-banner-title"><span>🤖</span><span>Automatic Zoe Depth Active</span></div><div class="pl-banner-sub">Using local neural ZoeDepth model for automatic 3D depth estimation (zero setup required).</div>`;
        depthBanner.appendChild(box);
    }
    updateDepthBanner();

    // Hook connection change to update depth banner
    const prevConnForDof = node.onConnectionsChange;
    node.onConnectionsChange = function () {
        if (prevConnForDof) prevConnForDof.apply(this, arguments);
        updateDepthBanner();
    };

    createInlineToggle(bDof, "Auto Zoe Depth Engine", "auto_depth", true);
    createInlineToggle(bDof, "Use 3D Depth for Bokeh", "dof_use_depth", true);
    createInlineToggle(bDof, "Auto-Focus on Foreground", "dof_auto_focus", true);
    const fStopW = node.widgets?.find(w => w && w.name === "f_stop");
    const fStopList = fStopW?.options?.values || ["Manual", "f/1.2", "f/1.4", "f/1.8", "f/2.0", "f/2.8", "f/4.0", "f/5.6", "f/8.0", "f/11", "f/16", "f/22"];
    createSelect(bDof, "Aperture F-Stop", "f_stop", fStopList);
    createSlider(bDof, "Bokeh Intensity", "dof_intensity", 0.0, 1.0, 0.01, 0.35);
    createSlider(bDof, "Focus Depth Range", "dof_sharpness_radius", 0.0, 1.0, 0.01, 0.25);
    createSlider(bDof, "Manual Focus Point", "dof_focus_point", 0.0, 1.0, 0.01, 0.15);

    // Card 3: Atmospheric Haze & Silhouette Light Wrap
    const bAtmos = createFeatureCard(pOptics, "Atmospheric Haze & Light Wrap", "🌫️", "enable_atmosphere");
    createInlineToggle(bAtmos, "Distance Aerial Rayleigh Haze", "haze_use_depth", true);
    createSlider(bAtmos, "Haze Density", "haze_strength", 0.0, 1.0, 0.05, 0.40);
    createSlider(bAtmos, "Shadow Lift (Blacks)", "lift_blacks", 0.0, 1.0, 0.02, 0.10);
    createSlider(bAtmos, "Depth Distance Offset", "depth_offset", -1.0, 1.0, 0.05, 0.0);
    createSlider(bAtmos, "Haze Tint R", "haze_color_r", 0.0, 1.0, 0.02, 0.16);
    createSlider(bAtmos, "Haze Tint G", "haze_color_g", 0.0, 1.0, 0.02, 0.19);
    createSlider(bAtmos, "Haze Tint B", "haze_color_b", 0.0, 1.0, 0.02, 0.26);
    createInlineToggle(bAtmos, "Silhouette Light Wrap via Depth", "light_wrap_use_depth", true);
    createSlider(bAtmos, "Silhouette Light Wrap", "light_wrap_strength", 0.0, 1.0, 0.05, 0.30);

    // Card 4: Optical Pro-Mist Diffusion
    const bMist = createFeatureCard(pOptics, "Optical Pro-Mist Diffusion", "☁️", "enable_mist");
    createSelect(bMist, "Diffusion Type", "mist_type", ["Black Pro-Mist", "White Diffusion / Fog"]);
    createSlider(bMist, "Intensity", "mist_intensity", 0.0, 1.5, 0.05, 0.25);
    createSlider(bMist, "Radius", "mist_radius", 6, 96, 2, 28);
    createSlider(bMist, "Cutoff Threshold", "mist_cutoff", 0.2, 0.95, 0.05, 0.60);

    // Card B: Anamorphic Horizontal Flare
    const bFlare = createFeatureCard(pOptics, "Anamorphic Streak Flare", "✨", "enable_flare");
    createSlider(bFlare, "Flare Intensity", "anamorphic_flare", 0.0, 2.0, 0.05, 0.30);

    // Card C: Multi-Spectral Anti-Halation
    const bHal = createFeatureCard(pOptics, "Multi-Spectral Halation", "🔴", "enable_halation");
    createSlider(bHal, "Halation Intensity", "halation_intensity", 0.0, 2.0, 0.05, 0.25);
    createSlider(bHal, "Scatter Spread", "halation_spread", 4, 80, 2, 20);
    createSlider(bHal, "Threshold", "halation_threshold", 0.4, 1.0, 0.02, 0.78);
    createSlider(bHal, "Amber Core", "halation_amber_core", 0.0, 1.0, 0.05, 0.45);

    // Card D: Lateral Chromatic Aberration
    const bCa = createFeatureCard(pOptics, "Lateral Chromatic Aberration", "🌈", "enable_lateral_ca");
    createSlider(bCa, "CA Dispersion", "lateral_ca", -0.04, 0.04, 0.001, 0.003);

    // Card E: Natural Vignette
    const bVig = createFeatureCard(pOptics, "cos⁴ Natural Optical Vignette", "🌑", "enable_vignette");
    createSlider(bVig, "Vignette Amount", "vignette_amount", 0.0, 2.0, 0.05, 0.25);

    // =========================================================================
    // TAB 4: FILM GRAIN
    // =========================================================================
    const pGrain = tabPanels["grain"];

    const bGrain = createFeatureCard(pGrain, "Photochemical Silver Halide Grain", "🎞️", "enable_grain");
    createSlider(bGrain, "Grain Amount", "grain_amount", 0.0, 2.0, 0.02, 0.20);
    createSlider(bGrain, "Crystal Size", "grain_size", 0.8, 4.0, 0.1, 1.4);
    createSlider(bGrain, "Shadows Density", "grain_shadows", 0.0, 2.0, 0.05, 0.45);
    createSlider(bGrain, "Midtones Density", "grain_midtones", 0.0, 2.0, 0.05, 0.90);
    createSlider(bGrain, "Highlights Density", "grain_highlights", 0.0, 2.0, 0.05, 0.25);
    createSlider(bGrain, "Chromatic Color Grain", "grain_color", 0.0, 1.0, 0.05, 0.0);
    createSeedRow(bGrain, "Grain Seed", "grain_seed");

    // Quick Grain Presets
    const grainPresetCard = document.createElement("div");
    grainPresetCard.className = "pl-card active";
    grainPresetCard.innerHTML = `<div class="pl-card-title"><span>📽️</span><span>Film Format Presets (Pure Silver Halide)</span></div>`;
    const gpGrid = document.createElement("div");
    gpGrid.className = "pl-presets-grid";

    const GRAIN_PRESETS = [
        { name: "8mm Vintage", desc: "Heavy crystal clumping (Zero color cast)", amt: 0.45, sz: 2.6, col: 0.0 },
        { name: "16mm Indie", desc: "Distinct organic grain (Zero color cast)", amt: 0.32, sz: 1.8, col: 0.0 },
        { name: "35mm Classic", desc: "Standard fine silver grain (Zero color cast)", amt: 0.20, sz: 1.3, col: 0.0 },
        { name: "120 Medium", desc: "Subtle micro-texture (Zero color cast)", amt: 0.10, sz: 0.9, col: 0.0 },
        { name: "4x5 Large", desc: "Ultra-fine pristine resolution (Zero color cast)", amt: 0.05, sz: 0.6, col: 0.0 }
    ];

    GRAIN_PRESETS.forEach(gp => {
        const item = document.createElement("div");
        item.className = "pl-preset-card";
        item.innerHTML = `<div class="pl-preset-name">${gp.name}</div><div class="pl-preset-desc">${gp.desc}</div>`;
        item.addEventListener("click", () => {
            setToggleState("enable_grain", true);
            setWidgetValue("grain_amount", gp.amt);
            setWidgetValue("grain_size", gp.sz);
            setWidgetValue("grain_color", gp.col);
        });
        gpGrid.appendChild(item);
    });
    grainPresetCard.appendChild(gpGrid);
    pGrain.appendChild(grainPresetCard);

    // =========================================================================
    // TAB 5: MASTER LOOKS & PRESETS
    // =========================================================================
    const pPresets = tabPanels["presets"];

    // Bypass All Button & Baseline Reset logic
    function bypassAll() {
        const allToggles = [
            "enable_diffusion", "enable_frequency_retouch", "enable_sss",
            "enable_auto_wb", "enable_auto_color", "enable_relighting",
            "enable_lut", "enable_film_stock", "enable_color_grade", "enable_shoulder",
            "enable_distortion", "enable_dof", "enable_atmosphere",
            "enable_mist", "enable_flare", "enable_halation", "enable_lateral_ca",
            "enable_vignette", "enable_grain"
        ];
        allToggles.forEach(t => setToggleState(t, false));

        // Reset parameters to baseline defaults so presets do not pollute each other
        setWidgetValue("auto_wb_strength", 0.80);
        setWidgetValue("auto_color_strength", 0.75);
        setWidgetValue("contrast", 1.0);
        setWidgetValue("exposure", 0.0);
        setWidgetValue("temperature", 0.0);
        setWidgetValue("tint", 0.0);
        setWidgetValue("saturation", 1.0);
        setWidgetValue("shoulder_start", 0.72);
        setWidgetValue("rolloff_softness", 0.80);
        setWidgetValue("highlight_desat", 0.60);
        setWidgetValue("light_intensity", 0.35);
        setWidgetValue("light_x", 0.5);
        setWidgetValue("light_y", 0.5);
        setWidgetValue("light_z", 0.20);
        setWidgetValue("light_radius", 0.65);
        setWidgetValue("light_color_r", 1.0);
        setWidgetValue("light_color_g", 0.95);
        setWidgetValue("light_color_b", 0.88);
        setWidgetValue("haze_strength", 0.40);
        setWidgetValue("lift_blacks", 0.10);
        setWidgetValue("depth_offset", 0.0);
        setWidgetValue("haze_color_r", 0.16);
        setWidgetValue("haze_color_g", 0.19);
        setWidgetValue("haze_color_b", 0.26);
        setWidgetValue("light_wrap_strength", 0.30);
        setWidgetValue("mist_type", "Black Pro-Mist");
        setWidgetValue("mist_intensity", 0.25);
        setWidgetValue("mist_radius", 28);
        setWidgetValue("halation_intensity", 0.25);
        setWidgetValue("halation_spread", 20);
        setWidgetValue("halation_threshold", 0.78);
        setWidgetValue("halation_amber_core", 0.45);
        setWidgetValue("lens_distortion", 0.0);
        setWidgetValue("lateral_ca", 0.0);
        setWidgetValue("anamorphic_flare", 0.0);
        setWidgetValue("vignette_amount", 0.0);
        setWidgetValue("grain_amount", 0.20);
        setWidgetValue("grain_size", 1.4);
        setWidgetValue("grain_color", 0.0);
        setWidgetValue("f_stop", "f/2.0");
        setWidgetValue("dof_intensity", 0.35);
        setWidgetValue("skin_smooth", 0.40);
        setWidgetValue("smooth_radius", 7);
        setWidgetValue("clarity", 0.15);
        setWidgetValue("sss_amount", 0.25);
        setWidgetValue("sss_radius", 14);
        setWidgetValue("sss_tint_r", 1.0);
        setWidgetValue("sss_tint_g", 0.28);
        setWidgetValue("sss_tint_b", 0.08);
    }

    let activePresetEl = null;

    bypassBtn.addEventListener("click", () => {
        if (activePresetEl) activePresetEl.classList.remove("active-look");
        activePresetEl = null;
        bypassAll();
    });

    // Master Presets Card
    const masterPresetCard = document.createElement("div");
    masterPresetCard.className = "pl-card active";
    masterPresetCard.innerHTML = `
        <div class="pl-card-title">
            <span>🎬</span><span>Master Film Looks & Cinematography Presets (32 Curated Looks)</span>
        </div>
        <div style="font-size: 9.5px; color: var(--pl-text-muted); margin-bottom: 4px;">
            Curated one-click physical optics, 3D volumetric depth, color science, and photochemical film emulations. Click any look to apply.
        </div>
    `;

    const MASTER_PRESETS = [
        // -------------------------------------------------------------
        // CATEGORY 1: 🎬 ICONIC CINEMA & DIRECTORIAL LOOKS
        // -------------------------------------------------------------
        {
            category: "🎬 Iconic Cinema & Directorial Looks",
            name: "🎬 35mm Hollywood Panavision",
            desc: "Portra 400 + Dynamic Shoulder + Amber/Red Halation + 35mm Grain + Anamorphic Streak",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Kodak Portra 400");
                setWidgetValue("stock_mix", 0.90);
                setToggleState("enable_color_grade", true);
                setWidgetValue("contrast", 1.12);
                setWidgetValue("exposure", 0.05);
                setWidgetValue("temperature", 0.06);
                setToggleState("enable_shoulder", true);
                setWidgetValue("shoulder_start", 0.68);
                setWidgetValue("rolloff_softness", 0.85);
                setWidgetValue("highlight_desat", 0.65);
                setToggleState("enable_halation", true);
                setWidgetValue("halation_intensity", 0.32);
                setWidgetValue("halation_spread", 24);
                setWidgetValue("halation_amber_core", 0.55);
                setToggleState("enable_flare", true);
                setWidgetValue("anamorphic_flare", 0.30);
                setToggleState("enable_vignette", true);
                setWidgetValue("vignette_amount", 0.26);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.22);
                setWidgetValue("grain_size", 1.4);
                setWidgetValue("grain_color", 0.0);
            }
        },
        {
            category: "🎬 Iconic Cinema & Directorial Looks",
            name: "🌌 Blade Runner 2049 (Dystopian Amber)",
            desc: "Sodium Vapor Amber Key + CineStill 800T + Dense Volumetric Dust + Amber Core Halation",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Kodak CineStill 800T");
                setWidgetValue("stock_mix", 0.85);
                setToggleState("enable_color_grade", true);
                setWidgetValue("temperature", 0.18);
                setWidgetValue("tint", -0.04);
                setWidgetValue("contrast", 1.22);
                setWidgetValue("saturation", 1.05);
                setWidgetValue("exposure", -0.05);
                setToggleState("enable_relighting", true);
                setToggleState("relight_use_depth", true);
                setWidgetValue("light_intensity", 0.85);
                setWidgetValue("light_x", 0.35);
                setWidgetValue("light_y", 0.40);
                setWidgetValue("light_z", 0.25);
                setWidgetValue("light_radius", 0.90);
                setWidgetValue("light_color_r", 1.45);
                setWidgetValue("light_color_g", 0.78);
                setWidgetValue("light_color_b", 0.18);
                setToggleState("enable_atmosphere", true);
                setToggleState("haze_use_depth", true);
                setToggleState("light_wrap_use_depth", true);
                setWidgetValue("haze_strength", 0.45);
                setWidgetValue("lift_blacks", 0.08);
                setWidgetValue("depth_offset", 0.05);
                setWidgetValue("haze_color_r", 0.22);
                setWidgetValue("haze_color_g", 0.14);
                setWidgetValue("haze_color_b", 0.06);
                setWidgetValue("light_wrap_strength", 0.38);
                setToggleState("enable_halation", true);
                setWidgetValue("halation_intensity", 0.50);
                setWidgetValue("halation_spread", 28);
                setWidgetValue("halation_threshold", 0.72);
                setWidgetValue("halation_amber_core", 0.85);
                setToggleState("enable_flare", true);
                setWidgetValue("anamorphic_flare", 0.35);
                setToggleState("enable_vignette", true);
                setWidgetValue("vignette_amount", 0.32);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.22);
                setWidgetValue("grain_size", 1.4);
                setWidgetValue("grain_color", 0.15);
            }
        },
        {
            category: "🎬 Iconic Cinema & Directorial Looks",
            name: "🏜️ Dune Arrakis Spice (Villeneuve / Fraser)",
            desc: "Bleached Sun Exposure + Ochre Dust Volumetric Haze + Warm Sand Relight + 65mm Scale",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Kodak Vision3 500T");
                setWidgetValue("stock_mix", 0.75);
                setToggleState("enable_color_grade", true);
                setWidgetValue("exposure", 0.18);
                setWidgetValue("contrast", 1.16);
                setWidgetValue("saturation", 0.85);
                setWidgetValue("temperature", 0.20);
                setWidgetValue("tint", -0.06);
                setToggleState("enable_shoulder", true);
                setWidgetValue("shoulder_start", 0.62);
                setWidgetValue("rolloff_softness", 1.05);
                setWidgetValue("highlight_desat", 0.75);
                setToggleState("enable_relighting", true);
                setToggleState("relight_use_depth", true);
                setWidgetValue("light_intensity", 0.55);
                setWidgetValue("light_x", 0.70);
                setWidgetValue("light_y", 0.20);
                setWidgetValue("light_z", 0.15);
                setWidgetValue("light_radius", 1.20);
                setWidgetValue("light_color_r", 1.25);
                setWidgetValue("light_color_g", 1.05);
                setWidgetValue("light_color_b", 0.75);
                setToggleState("enable_atmosphere", true);
                setToggleState("haze_use_depth", true);
                setToggleState("light_wrap_use_depth", true);
                setWidgetValue("haze_strength", 0.55);
                setWidgetValue("lift_blacks", 0.14);
                setWidgetValue("depth_offset", 0.10);
                setWidgetValue("haze_color_r", 0.28);
                setWidgetValue("haze_color_g", 0.22);
                setWidgetValue("haze_color_b", 0.12);
                setWidgetValue("light_wrap_strength", 0.42);
                setToggleState("enable_vignette", true);
                setWidgetValue("vignette_amount", 0.38);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.15);
                setWidgetValue("grain_size", 1.1);
            }
        },
        {
            category: "🎬 Iconic Cinema & Directorial Looks",
            name: "🛸 Kubrick 2001 (Clinical Sci-Fi)",
            desc: "Cold Analytic Balance + Clinical High-Key Exposure + Razor Contrast + Clean Low Grain",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Kodak Vision3 500T");
                setWidgetValue("stock_mix", 0.40);
                setToggleState("enable_color_grade", true);
                setWidgetValue("exposure", 0.15);
                setWidgetValue("contrast", 1.28);
                setWidgetValue("saturation", 0.80);
                setWidgetValue("temperature", -0.16);
                setWidgetValue("tint", 0.04);
                setToggleState("enable_frequency_retouch", true);
                setWidgetValue("clarity", 0.35);
                setToggleState("enable_shoulder", true);
                setWidgetValue("shoulder_start", 0.78);
                setWidgetValue("rolloff_softness", 0.60);
                setWidgetValue("highlight_desat", 0.85);
                setToggleState("enable_relighting", true);
                setWidgetValue("light_intensity", 0.60);
                setWidgetValue("light_x", 0.50);
                setWidgetValue("light_y", 0.10);
                setWidgetValue("light_z", 0.10);
                setWidgetValue("light_radius", 1.40);
                setWidgetValue("light_color_r", 0.95);
                setWidgetValue("light_color_g", 1.02);
                setWidgetValue("light_color_b", 1.15);
                setToggleState("enable_atmosphere", true);
                setWidgetValue("haze_strength", 0.15);
                setWidgetValue("lift_blacks", 0.02);
                setWidgetValue("haze_color_r", 0.10);
                setWidgetValue("haze_color_g", 0.14);
                setWidgetValue("haze_color_b", 0.20);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.08);
                setWidgetValue("grain_size", 1.0);
            }
        },
        {
            category: "🎬 Iconic Cinema & Directorial Looks",
            name: "🕶️ Fincher Green Tungsten (Mindhunter)",
            desc: "Moody Fluorescent Olive Grade + Crushed Inky Blacks + Piercing Texture Clarity + Vignette",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Fuji Superia 400");
                setWidgetValue("stock_mix", 0.70);
                setToggleState("enable_color_grade", true);
                setWidgetValue("exposure", -0.15);
                setWidgetValue("contrast", 1.30);
                setWidgetValue("saturation", 0.82);
                setWidgetValue("temperature", -0.08);
                setWidgetValue("tint", 0.22);
                setToggleState("enable_frequency_retouch", true);
                setWidgetValue("clarity", 0.30);
                setWidgetValue("skin_smooth", 0.25);
                setToggleState("enable_shoulder", true);
                setWidgetValue("shoulder_start", 0.75);
                setWidgetValue("rolloff_softness", 0.70);
                setWidgetValue("highlight_desat", 0.50);
                setToggleState("enable_atmosphere", true);
                setWidgetValue("haze_strength", 0.20);
                setWidgetValue("lift_blacks", 0.04);
                setWidgetValue("haze_color_r", 0.08);
                setWidgetValue("haze_color_g", 0.14);
                setWidgetValue("haze_color_b", 0.09);
                setToggleState("enable_vignette", true);
                setWidgetValue("vignette_amount", 0.42);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.24);
                setWidgetValue("grain_size", 1.3);
            }
        },
        {
            category: "🎬 Iconic Cinema & Directorial Looks",
            name: "🩸 Dario Argento Giallo (1970s Horror)",
            desc: "Saturated Crimson Gel 3D Relighting + Deep Noir Shadows + Intense Halation + Black Pro-Mist",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Kodak Gold 200");
                setWidgetValue("stock_mix", 0.80);
                setToggleState("enable_color_grade", true);
                setWidgetValue("exposure", 0.05);
                setWidgetValue("contrast", 1.35);
                setWidgetValue("saturation", 1.30);
                setWidgetValue("temperature", 0.12);
                setWidgetValue("tint", -0.10);
                setToggleState("enable_relighting", true);
                setToggleState("relight_use_depth", true);
                setWidgetValue("light_intensity", 1.10);
                setWidgetValue("light_x", 0.20);
                setWidgetValue("light_y", 0.35);
                setWidgetValue("light_z", 0.18);
                setWidgetValue("light_radius", 0.75);
                setWidgetValue("light_color_r", 1.80);
                setWidgetValue("light_color_g", 0.15);
                setWidgetValue("light_color_b", 0.25);
                setToggleState("enable_mist", true);
                setWidgetValue("mist_type", "Black Pro-Mist");
                setWidgetValue("mist_intensity", 0.45);
                setWidgetValue("mist_radius", 38);
                setWidgetValue("mist_cutoff", 0.55);
                setToggleState("enable_halation", true);
                setWidgetValue("halation_intensity", 0.60);
                setWidgetValue("halation_spread", 32);
                setWidgetValue("halation_threshold", 0.65);
                setWidgetValue("halation_amber_core", 0.20);
                setToggleState("enable_vignette", true);
                setWidgetValue("vignette_amount", 0.45);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.28);
                setWidgetValue("grain_size", 1.6);
            }
        },
        {
            category: "🎬 Iconic Cinema & Directorial Looks",
            name: "🏎️ Wes Anderson Pastel Symmetry",
            desc: "Vibrant Custard Yellow & Mint Palette + Flat Low Contrast + Soft Fog Diffusion + Crisp Geometry",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Agfa Vista 200");
                setWidgetValue("stock_mix", 0.85);
                setToggleState("enable_color_grade", true);
                setWidgetValue("exposure", 0.20);
                setWidgetValue("contrast", 0.88);
                setWidgetValue("saturation", 1.18);
                setWidgetValue("temperature", 0.18);
                setWidgetValue("tint", -0.12);
                setToggleState("enable_mist", true);
                setWidgetValue("mist_type", "White Diffusion / Fog");
                setWidgetValue("mist_intensity", 0.30);
                setWidgetValue("mist_radius", 32);
                setWidgetValue("mist_cutoff", 0.50);
                setToggleState("enable_shoulder", true);
                setWidgetValue("shoulder_start", 0.60);
                setWidgetValue("rolloff_softness", 1.25);
                setWidgetValue("highlight_desat", 0.20);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.16);
                setWidgetValue("grain_size", 1.2);
            }
        },
        {
            category: "🎬 Iconic Cinema & Directorial Looks",
            name: "🌃 Michael Mann Heat (1995 Los Angeles)",
            desc: "Cool Blue-Steel Nocturnal Grade + Sodium Streetlight Relighting + CineStill + Anamorphic Flare",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Kodak CineStill 800T");
                setWidgetValue("stock_mix", 0.75);
                setToggleState("enable_color_grade", true);
                setWidgetValue("exposure", -0.10);
                setWidgetValue("contrast", 1.26);
                setWidgetValue("saturation", 0.88);
                setWidgetValue("temperature", -0.18);
                setWidgetValue("tint", 0.05);
                setToggleState("enable_relighting", true);
                setToggleState("relight_use_depth", true);
                setWidgetValue("light_intensity", 0.75);
                setWidgetValue("light_x", 0.80);
                setWidgetValue("light_y", 0.30);
                setWidgetValue("light_z", 0.20);
                setWidgetValue("light_radius", 0.70);
                setWidgetValue("light_color_r", 1.35);
                setWidgetValue("light_color_g", 0.82);
                setWidgetValue("light_color_b", 0.28);
                setToggleState("enable_atmosphere", true);
                setToggleState("haze_use_depth", true);
                setToggleState("light_wrap_use_depth", true);
                setWidgetValue("haze_strength", 0.35);
                setWidgetValue("lift_blacks", 0.05);
                setWidgetValue("haze_color_r", 0.08);
                setWidgetValue("haze_color_g", 0.12);
                setWidgetValue("haze_color_b", 0.24);
                setWidgetValue("light_wrap_strength", 0.35);
                setToggleState("enable_flare", true);
                setWidgetValue("anamorphic_flare", 0.45);
                setToggleState("enable_lateral_ca", true);
                setWidgetValue("lateral_ca", 0.005);
                setToggleState("enable_vignette", true);
                setWidgetValue("vignette_amount", 0.36);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.25);
                setWidgetValue("grain_size", 1.5);
            }
        },

        // -------------------------------------------------------------
        // CATEGORY 2: 📸 PHOTOCHEMICAL FILM STOCKS & VINTAGE
        // -------------------------------------------------------------
        {
            category: "📸 Photochemical Film Stocks & Vintage",
            name: "🌃 Neo-Tokyo Cyberpunk",
            desc: "CineStill 800T + Electric Cyan/Magenta Split + Intense Amber Halation + Anamorphic Streak",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Kodak CineStill 800T");
                setWidgetValue("stock_mix", 0.95);
                setToggleState("enable_color_grade", true);
                setWidgetValue("contrast", 1.25);
                setWidgetValue("exposure", 0.05);
                setWidgetValue("temperature", -0.10);
                setWidgetValue("tint", 0.18);
                setWidgetValue("saturation", 1.25);
                setToggleState("enable_halation", true);
                setWidgetValue("halation_intensity", 0.55);
                setWidgetValue("halation_spread", 26);
                setWidgetValue("halation_threshold", 0.70);
                setWidgetValue("halation_amber_core", 0.75);
                setToggleState("enable_flare", true);
                setWidgetValue("anamorphic_flare", 0.45);
                setToggleState("enable_mist", true);
                setWidgetValue("mist_type", "Black Pro-Mist");
                setWidgetValue("mist_intensity", 0.35);
                setWidgetValue("mist_radius", 32);
                setWidgetValue("mist_cutoff", 0.55);
                setToggleState("enable_vignette", true);
                setWidgetValue("vignette_amount", 0.30);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.22);
                setWidgetValue("grain_size", 1.4);
            }
        },
        {
            category: "📸 Photochemical Film Stocks & Vintage",
            name: "🎥 16mm French New Wave",
            desc: "Fuji Pro 400H + 35mm Prime Distortion + Chromatic Aberration + Gritty 16mm Silver Grain",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Fuji Pro 400H");
                setWidgetValue("stock_mix", 0.90);
                setToggleState("enable_color_grade", true);
                setWidgetValue("contrast", 1.15);
                setWidgetValue("exposure", 0.08);
                setWidgetValue("temperature", 0.05);
                setWidgetValue("saturation", 0.95);
                setToggleState("enable_distortion", true);
                setWidgetValue("lens_distortion", -0.035);
                setToggleState("enable_lateral_ca", true);
                setWidgetValue("lateral_ca", 0.007);
                setToggleState("enable_vignette", true);
                setWidgetValue("vignette_amount", 0.35);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.40);
                setWidgetValue("grain_size", 2.2);
                setWidgetValue("grain_shadows", 0.60);
                setWidgetValue("grain_midtones", 1.10);
            }
        },
        {
            category: "📸 Photochemical Film Stocks & Vintage",
            name: "📸 1970s Kodachrome 64",
            desc: "Warm Golden Yellow/Red Color Punch + Rich Contrast + Natural Vintage Vignette + Grain",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Kodachrome 64");
                setWidgetValue("stock_mix", 0.95);
                setToggleState("enable_color_grade", true);
                setWidgetValue("contrast", 1.20);
                setWidgetValue("exposure", 0.04);
                setWidgetValue("temperature", 0.14);
                setWidgetValue("saturation", 1.15);
                setToggleState("enable_shoulder", true);
                setWidgetValue("shoulder_start", 0.65);
                setWidgetValue("rolloff_softness", 0.90);
                setWidgetValue("highlight_desat", 0.45);
                setToggleState("enable_vignette", true);
                setWidgetValue("vignette_amount", 0.35);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.24);
                setWidgetValue("grain_size", 1.3);
            }
        },
        {
            category: "📸 Photochemical Film Stocks & Vintage",
            name: "🍭 Technicolor Three-Strip (1950s)",
            desc: "Vibrant Dye-Transfer Saturation + Golden Glow Halation + Soft Shoulder + 35mm Grain",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Kodak Gold 200");
                setWidgetValue("stock_mix", 0.90);
                setToggleState("enable_color_grade", true);
                setWidgetValue("contrast", 1.22);
                setWidgetValue("exposure", 0.10);
                setWidgetValue("saturation", 1.40);
                setWidgetValue("temperature", 0.08);
                setWidgetValue("tint", -0.06);
                setToggleState("enable_shoulder", true);
                setWidgetValue("shoulder_start", 0.62);
                setWidgetValue("rolloff_softness", 1.10);
                setWidgetValue("highlight_desat", 0.25);
                setToggleState("enable_halation", true);
                setWidgetValue("halation_intensity", 0.38);
                setWidgetValue("halation_spread", 22);
                setWidgetValue("halation_amber_core", 0.60);
                setToggleState("enable_vignette", true);
                setWidgetValue("vignette_amount", 0.25);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.18);
                setWidgetValue("grain_size", 1.3);
            }
        },
        {
            category: "📸 Photochemical Film Stocks & Vintage",
            name: "☕ 90s Seattle Grunge & Coffeehouse",
            desc: "Kodak Portra 800 + Earthy Olive/Ochre Tones + Lifted Toe + Intimate 35mm Grain",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Kodak Portra 800");
                setWidgetValue("stock_mix", 0.90);
                setToggleState("enable_color_grade", true);
                setWidgetValue("contrast", 1.08);
                setWidgetValue("exposure", -0.05);
                setWidgetValue("temperature", 0.12);
                setWidgetValue("tint", 0.08);
                setWidgetValue("saturation", 0.88);
                setToggleState("enable_atmosphere", true);
                setWidgetValue("lift_blacks", 0.12);
                setWidgetValue("haze_strength", 0.25);
                setWidgetValue("haze_color_r", 0.20);
                setWidgetValue("haze_color_g", 0.17);
                setWidgetValue("haze_color_b", 0.12);
                setToggleState("enable_vignette", true);
                setWidgetValue("vignette_amount", 0.32);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.32);
                setWidgetValue("grain_size", 1.7);
            }
        },
        {
            category: "📸 Photochemical Film Stocks & Vintage",
            name: "🎞️ Polaroid 600 Instant",
            desc: "Polaroid 600 Stock + Milky Lifted Blacks + Warm Faded Chromatics + Soft Edge Fog",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Polaroid 600");
                setWidgetValue("stock_mix", 0.95);
                setToggleState("enable_color_grade", true);
                setWidgetValue("contrast", 1.14);
                setWidgetValue("exposure", 0.08);
                setWidgetValue("temperature", 0.10);
                setWidgetValue("tint", -0.04);
                setWidgetValue("saturation", 0.92);
                setToggleState("enable_atmosphere", true);
                setWidgetValue("lift_blacks", 0.18);
                setWidgetValue("haze_strength", 0.28);
                setWidgetValue("haze_color_r", 0.24);
                setWidgetValue("haze_color_g", 0.22);
                setWidgetValue("haze_color_b", 0.20);
                setToggleState("enable_mist", true);
                setWidgetValue("mist_type", "White Diffusion / Fog");
                setWidgetValue("mist_intensity", 0.28);
                setWidgetValue("mist_radius", 36);
                setWidgetValue("mist_cutoff", 0.55);
                setToggleState("enable_lateral_ca", true);
                setWidgetValue("lateral_ca", 0.005);
                setToggleState("enable_vignette", true);
                setWidgetValue("vignette_amount", 0.38);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.30);
                setWidgetValue("grain_size", 1.8);
            }
        },
        {
            category: "📸 Photochemical Film Stocks & Vintage",
            name: "🌅 Fuji Velvia 50 Landscape",
            desc: "Fuji Velvia 50 + Hyper-Saturated Emerald Greens & Vivid Skies + Rich Punchy Contrast",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Fuji Velvia 50");
                setWidgetValue("stock_mix", 0.95);
                setToggleState("enable_color_grade", true);
                setWidgetValue("contrast", 1.25);
                setWidgetValue("exposure", 0.02);
                setWidgetValue("temperature", 0.02);
                setWidgetValue("tint", -0.05);
                setWidgetValue("saturation", 1.35);
                setToggleState("enable_frequency_retouch", true);
                setWidgetValue("clarity", 0.25);
                setToggleState("enable_shoulder", true);
                setWidgetValue("shoulder_start", 0.72);
                setWidgetValue("rolloff_softness", 0.75);
                setWidgetValue("highlight_desat", 0.30);
                setToggleState("enable_vignette", true);
                setWidgetValue("vignette_amount", 0.22);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.10);
                setWidgetValue("grain_size", 1.0);
            }
        },

        // -------------------------------------------------------------
        // CATEGORY 3: 💄 PORTRAIT, STUDIO & HIGH-END EDITORIAL
        // -------------------------------------------------------------
        {
            category: "💄 Portrait, Studio & High-End Editorial",
            name: "💄 Vogue High-Fashion Editorial",
            desc: "Pore-Locking Retouch + SSS Red Bleed + 3D Key/Rim Light + Soft Shoulder Rolloff",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Kodak Portra 400");
                setWidgetValue("stock_mix", 0.80);
                setToggleState("enable_frequency_retouch", true);
                setWidgetValue("skin_smooth", 0.45);
                setWidgetValue("smooth_radius", 9);
                setWidgetValue("clarity", 0.18);
                setToggleState("enable_sss", true);
                setWidgetValue("sss_amount", 0.32);
                setWidgetValue("sss_radius", 16);
                setWidgetValue("sss_tint_r", 1.05);
                setWidgetValue("sss_tint_g", 0.26);
                setWidgetValue("sss_tint_b", 0.08);
                setToggleState("enable_relighting", true);
                setToggleState("relight_use_depth", true);
                setWidgetValue("light_intensity", 0.40);
                setWidgetValue("light_x", 0.40);
                setWidgetValue("light_y", 0.35);
                setWidgetValue("light_z", 0.18);
                setWidgetValue("light_radius", 0.70);
                setWidgetValue("light_color_r", 1.05);
                setWidgetValue("light_color_g", 0.98);
                setWidgetValue("light_color_b", 0.92);
                setToggleState("enable_shoulder", true);
                setWidgetValue("shoulder_start", 0.68);
                setWidgetValue("rolloff_softness", 0.90);
                setWidgetValue("highlight_desat", 0.65);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.16);
                setWidgetValue("grain_size", 1.2);
            }
        },
        {
            category: "💄 Portrait, Studio & High-End Editorial",
            name: "🌅 Golden Hour Nat-Geo",
            desc: "Kodak Gold 200 + Warm Sun Rim Light + Atmospheric Rayleigh Haze + Light Wrap + f/2.0 Bokeh",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Kodak Gold 200");
                setWidgetValue("stock_mix", 0.85);
                setToggleState("enable_color_grade", true);
                setWidgetValue("contrast", 1.10);
                setWidgetValue("exposure", 0.06);
                setWidgetValue("temperature", 0.22);
                setWidgetValue("tint", -0.08);
                setWidgetValue("saturation", 1.12);
                setToggleState("enable_relighting", true);
                setToggleState("relight_use_depth", true);
                setWidgetValue("light_intensity", 0.65);
                setWidgetValue("light_x", 0.85);
                setWidgetValue("light_y", 0.20);
                setWidgetValue("light_z", 0.22);
                setWidgetValue("light_radius", 0.95);
                setWidgetValue("light_color_r", 1.40);
                setWidgetValue("light_color_g", 0.95);
                setWidgetValue("light_color_b", 0.45);
                setToggleState("enable_atmosphere", true);
                setToggleState("haze_use_depth", true);
                setToggleState("light_wrap_use_depth", true);
                setWidgetValue("haze_strength", 0.40);
                setWidgetValue("lift_blacks", 0.06);
                setWidgetValue("haze_color_r", 0.26);
                setWidgetValue("haze_color_g", 0.18);
                setWidgetValue("haze_color_b", 0.10);
                setWidgetValue("light_wrap_strength", 0.45);
                setToggleState("enable_dof", true);
                setWidgetValue("f_stop", "f/2.0");
                setWidgetValue("dof_intensity", 0.35);
                setToggleState("enable_halation", true);
                setWidgetValue("halation_intensity", 0.35);
                setWidgetValue("halation_spread", 24);
                setWidgetValue("halation_amber_core", 0.75);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.18);
                setWidgetValue("grain_size", 1.3);
            }
        },
        {
            category: "💄 Portrait, Studio & High-End Editorial",
            name: "💎 Modern A24 Drama",
            desc: "Pristine Kodak Portra 400 + Natural Organic Relight + Shallow f/1.8 Bokeh + True Filmic Curve",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Kodak Portra 400");
                setWidgetValue("stock_mix", 0.85);
                setToggleState("enable_color_grade", true);
                setWidgetValue("contrast", 1.08);
                setWidgetValue("exposure", 0.02);
                setWidgetValue("temperature", 0.04);
                setWidgetValue("saturation", 0.96);
                setToggleState("enable_frequency_retouch", true);
                setWidgetValue("skin_smooth", 0.30);
                setWidgetValue("clarity", 0.12);
                setToggleState("enable_relighting", true);
                setToggleState("relight_use_depth", true);
                setWidgetValue("light_intensity", 0.30);
                setWidgetValue("light_x", 0.38);
                setWidgetValue("light_y", 0.35);
                setWidgetValue("light_z", 0.22);
                setWidgetValue("light_radius", 0.80);
                setWidgetValue("light_color_r", 1.02);
                setWidgetValue("light_color_g", 0.97);
                setWidgetValue("light_color_b", 0.90);
                setToggleState("enable_shoulder", true);
                setWidgetValue("shoulder_start", 0.70);
                setWidgetValue("rolloff_softness", 0.85);
                setWidgetValue("highlight_desat", 0.55);
                setToggleState("enable_dof", true);
                setWidgetValue("f_stop", "f/1.8");
                setWidgetValue("dof_intensity", 0.30);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.18);
                setWidgetValue("grain_size", 1.3);
            }
        },
        {
            category: "💄 Portrait, Studio & High-End Editorial",
            name: "⚡ Euphoria Neon Drench (HBO)",
            desc: "Dual Violet/Cyan Color Split + Specular Amber Halation + Heavy Pro-Mist + Film Dynamic Range",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Kodak CineStill 800T");
                setWidgetValue("stock_mix", 0.90);
                setToggleState("enable_color_grade", true);
                setWidgetValue("contrast", 1.24);
                setWidgetValue("exposure", 0.04);
                setWidgetValue("temperature", -0.12);
                setWidgetValue("tint", 0.25);
                setWidgetValue("saturation", 1.35);
                setToggleState("enable_relighting", true);
                setToggleState("relight_use_depth", true);
                setWidgetValue("light_intensity", 0.80);
                setWidgetValue("light_x", 0.20);
                setWidgetValue("light_y", 0.40);
                setWidgetValue("light_z", 0.15);
                setWidgetValue("light_radius", 0.70);
                setWidgetValue("light_color_r", 0.40);
                setWidgetValue("light_color_g", 0.70);
                setWidgetValue("light_color_b", 1.50);
                setToggleState("enable_mist", true);
                setWidgetValue("mist_type", "Black Pro-Mist");
                setWidgetValue("mist_intensity", 0.45);
                setWidgetValue("mist_radius", 36);
                setWidgetValue("mist_cutoff", 0.50);
                setToggleState("enable_halation", true);
                setWidgetValue("halation_intensity", 0.50);
                setWidgetValue("halation_spread", 26);
                setWidgetValue("halation_amber_core", 0.65);
                setToggleState("enable_flare", true);
                setWidgetValue("anamorphic_flare", 0.40);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.22);
                setWidgetValue("grain_size", 1.4);
            }
        },
        {
            category: "💄 Portrait, Studio & High-End Editorial",
            name: "📷 Richard Avedon Studio B&W",
            desc: "Kodak Tri-X 400 + High-Key Stark White Key + Razor Clarity Retouch + Intense Contrast",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Kodak Tri-X 400 (B&W)");
                setWidgetValue("stock_mix", 1.0);
                setToggleState("enable_color_grade", true);
                setWidgetValue("contrast", 1.38);
                setWidgetValue("exposure", 0.12);
                setWidgetValue("saturation", 0.0);
                setToggleState("enable_frequency_retouch", true);
                setWidgetValue("clarity", 0.40);
                setWidgetValue("skin_smooth", 0.20);
                setWidgetValue("smooth_radius", 6);
                setToggleState("enable_shoulder", true);
                setWidgetValue("shoulder_start", 0.80);
                setWidgetValue("rolloff_softness", 0.55);
                setWidgetValue("highlight_desat", 1.0);
                setToggleState("enable_relighting", true);
                setWidgetValue("light_intensity", 0.50);
                setWidgetValue("light_x", 0.50);
                setWidgetValue("light_y", 0.25);
                setWidgetValue("light_z", 0.15);
                setWidgetValue("light_radius", 1.10);
                setWidgetValue("light_color_r", 1.10);
                setWidgetValue("light_color_g", 1.10);
                setWidgetValue("light_color_b", 1.10);
                setToggleState("enable_vignette", true);
                setWidgetValue("vignette_amount", 0.20);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.26);
                setWidgetValue("grain_size", 1.5);
            }
        },
        {
            category: "💄 Portrait, Studio & High-End Editorial",
            name: "🌸 Korean Drama Soft Glow",
            desc: "Fuji Pro 400H + Milky Pastel Lift + Gentle SSS Skin Bleed + Delicate Mist + f/1.4 Bokeh",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Fuji Pro 400H");
                setWidgetValue("stock_mix", 0.85);
                setToggleState("enable_color_grade", true);
                setWidgetValue("contrast", 0.95);
                setWidgetValue("exposure", 0.12);
                setWidgetValue("temperature", 0.06);
                setWidgetValue("tint", -0.04);
                setWidgetValue("saturation", 1.04);
                setToggleState("enable_frequency_retouch", true);
                setWidgetValue("skin_smooth", 0.50);
                setWidgetValue("smooth_radius", 11);
                setWidgetValue("clarity", 0.10);
                setToggleState("enable_sss", true);
                setWidgetValue("sss_amount", 0.35);
                setWidgetValue("sss_radius", 18);
                setWidgetValue("sss_tint_r", 1.05);
                setWidgetValue("sss_tint_g", 0.30);
                setWidgetValue("sss_tint_b", 0.12);
                setToggleState("enable_mist", true);
                setWidgetValue("mist_type", "White Diffusion / Fog");
                setWidgetValue("mist_intensity", 0.32);
                setWidgetValue("mist_radius", 30);
                setWidgetValue("mist_cutoff", 0.55);
                setToggleState("enable_dof", true);
                setWidgetValue("f_stop", "f/1.4");
                setWidgetValue("dof_intensity", 0.40);
                setToggleState("enable_shoulder", true);
                setWidgetValue("shoulder_start", 0.64);
                setWidgetValue("rolloff_softness", 1.15);
                setWidgetValue("highlight_desat", 0.40);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.12);
                setWidgetValue("grain_size", 1.1);
            }
        },

        // -------------------------------------------------------------
        // CATEGORY 4: 🎞️ BLACK & WHITE FINE ART & STREET
        // -------------------------------------------------------------
        {
            category: "🎞️ Black & White Fine Art & Street",
            name: "🎞️ Kodak Tri-X 400 Noir (Silver Gelatin)",
            desc: "Monochrome Street Photography + Crushed Inky Blacks + Sharp Micro-Contrast + Tactile Grain",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Kodak Tri-X 400 (B&W)");
                setWidgetValue("stock_mix", 1.0);
                setToggleState("enable_color_grade", true);
                setWidgetValue("contrast", 1.32);
                setWidgetValue("exposure", -0.05);
                setWidgetValue("saturation", 0.0);
                setToggleState("enable_frequency_retouch", true);
                setWidgetValue("clarity", 0.30);
                setToggleState("enable_vignette", true);
                setWidgetValue("vignette_amount", 0.40);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.35);
                setWidgetValue("grain_size", 1.8);
                setWidgetValue("grain_shadows", 0.65);
                setWidgetValue("grain_midtones", 1.05);
            }
        },
        {
            category: "🎞️ Black & White Fine Art & Street",
            name: "🏛️ Fine Art Platinum / Palladium",
            desc: "Ilford HP5 Plus + Smooth Sepia-Toned Platinum Print + Wide Dynamic Shoulder + Delicate Grain",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Ilford HP5 Plus (B&W)");
                setWidgetValue("stock_mix", 0.95);
                setToggleState("enable_color_grade", true);
                setWidgetValue("contrast", 1.12);
                setWidgetValue("exposure", 0.05);
                setWidgetValue("temperature", 0.10);
                setWidgetValue("tint", -0.02);
                setWidgetValue("saturation", 0.15);
                setToggleState("enable_shoulder", true);
                setWidgetValue("shoulder_start", 0.65);
                setWidgetValue("rolloff_softness", 1.20);
                setWidgetValue("highlight_desat", 0.85);
                setToggleState("enable_atmosphere", true);
                setWidgetValue("lift_blacks", 0.10);
                setWidgetValue("haze_strength", 0.15);
                setWidgetValue("haze_color_r", 0.18);
                setWidgetValue("haze_color_g", 0.16);
                setWidgetValue("haze_color_b", 0.14);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.20);
                setWidgetValue("grain_size", 1.3);
            }
        },
        {
            category: "🎞️ Black & White Fine Art & Street",
            name: "🌊 Nordic Melancholy (Scandi Noir)",
            desc: "Desaturated Steel-Blue Tone + Overcast Fog Haze + Crisp Micro-Pore Texture + Subtle Lateral CA",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Fuji Superia 400");
                setWidgetValue("stock_mix", 0.65);
                setToggleState("enable_color_grade", true);
                setWidgetValue("contrast", 1.16);
                setWidgetValue("exposure", -0.08);
                setWidgetValue("temperature", -0.15);
                setWidgetValue("tint", 0.06);
                setWidgetValue("saturation", 0.65);
                setToggleState("enable_frequency_retouch", true);
                setWidgetValue("clarity", 0.28);
                setToggleState("enable_atmosphere", true);
                setToggleState("haze_use_depth", true);
                setToggleState("light_wrap_use_depth", true);
                setWidgetValue("haze_strength", 0.45);
                setWidgetValue("lift_blacks", 0.08);
                setWidgetValue("depth_offset", 0.05);
                setWidgetValue("haze_color_r", 0.14);
                setWidgetValue("haze_color_g", 0.18);
                setWidgetValue("haze_color_b", 0.25);
                setWidgetValue("light_wrap_strength", 0.30);
                setToggleState("enable_lateral_ca", true);
                setWidgetValue("lateral_ca", 0.004);
                setToggleState("enable_vignette", true);
                setWidgetValue("vignette_amount", 0.32);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.22);
                setWidgetValue("grain_size", 1.4);
            }
        },
        {
            category: "🎞️ Black & White Fine Art & Street",
            name: "📸 Henri Cartier-Bresson Street",
            desc: "Ilford HP5 Plus + High Street Clarity + Decisive Moment Punch + Deep Organic Silver Halide",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Ilford HP5 Plus (B&W)");
                setWidgetValue("stock_mix", 1.0);
                setToggleState("enable_color_grade", true);
                setWidgetValue("contrast", 1.25);
                setWidgetValue("exposure", 0.02);
                setWidgetValue("saturation", 0.0);
                setToggleState("enable_frequency_retouch", true);
                setWidgetValue("clarity", 0.35);
                setWidgetValue("skin_smooth", 0.15);
                setToggleState("enable_shoulder", true);
                setWidgetValue("shoulder_start", 0.70);
                setWidgetValue("rolloff_softness", 0.80);
                setWidgetValue("highlight_desat", 1.0);
                setToggleState("enable_vignette", true);
                setWidgetValue("vignette_amount", 0.45);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.36);
                setWidgetValue("grain_size", 1.9);
                setWidgetValue("grain_shadows", 0.60);
                setWidgetValue("grain_midtones", 1.10);
            }
        },
        {
            category: "🎞️ Black & White Fine Art & Street",
            name: "🌑 High Contrast Graphic B&W",
            desc: "Kodak Tri-X 400 Pushed + Blown Specular Highlights + Crushed Pitch Blacks + Stark Graphic Drama",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Kodak Tri-X 400 (B&W)");
                setWidgetValue("stock_mix", 1.0);
                setToggleState("enable_color_grade", true);
                setWidgetValue("contrast", 1.55);
                setWidgetValue("exposure", 0.10);
                setWidgetValue("saturation", 0.0);
                setToggleState("enable_frequency_retouch", true);
                setWidgetValue("clarity", 0.45);
                setToggleState("enable_shoulder", true);
                setWidgetValue("shoulder_start", 0.82);
                setWidgetValue("rolloff_softness", 0.40);
                setWidgetValue("highlight_desat", 1.0);
                setToggleState("enable_vignette", true);
                setWidgetValue("vignette_amount", 0.50);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.42);
                setWidgetValue("grain_size", 2.0);
                setWidgetValue("grain_shadows", 0.70);
                setWidgetValue("grain_midtones", 1.20);
            }
        },

        // -------------------------------------------------------------
        // CATEGORY 5: 🌸 ATMOSPHERIC, DREAMCORE & PASSTHROUGH
        // -------------------------------------------------------------
        {
            category: "🌸 Atmospheric, Dreamcore & Passthrough",
            name: "🌸 Pastel Japanese Indie",
            desc: "Fuji Pro 400H + Milky Lifted Shadows + Soft White Fog Mist + High Key Exposure + Gentle Grain",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Fuji Pro 400H");
                setWidgetValue("stock_mix", 0.90);
                setToggleState("enable_color_grade", true);
                setWidgetValue("contrast", 0.92);
                setWidgetValue("exposure", 0.15);
                setWidgetValue("temperature", 0.04);
                setWidgetValue("tint", -0.06);
                setWidgetValue("saturation", 0.95);
                setToggleState("enable_atmosphere", true);
                setWidgetValue("lift_blacks", 0.16);
                setWidgetValue("haze_strength", 0.35);
                setWidgetValue("haze_color_r", 0.22);
                setWidgetValue("haze_color_g", 0.24);
                setWidgetValue("haze_color_b", 0.26);
                setToggleState("enable_mist", true);
                setWidgetValue("mist_type", "White Diffusion / Fog");
                setWidgetValue("mist_intensity", 0.35);
                setWidgetValue("mist_radius", 35);
                setWidgetValue("mist_cutoff", 0.50);
                setToggleState("enable_shoulder", true);
                setWidgetValue("shoulder_start", 0.65);
                setWidgetValue("rolloff_softness", 1.10);
                setWidgetValue("highlight_desat", 0.45);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.16);
                setWidgetValue("grain_size", 1.2);
            }
        },
        {
            category: "🌸 Atmospheric, Dreamcore & Passthrough",
            name: "✨ Dreamcore 90s Nostalgia",
            desc: "Agfa Vista 200 + Lush White Fog Bloom + Chromatic Edge Fringing + Pastel Lifted Blacks + Anamorphic",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Agfa Vista 200");
                setWidgetValue("stock_mix", 0.85);
                setToggleState("enable_color_grade", true);
                setWidgetValue("contrast", 0.96);
                setWidgetValue("exposure", 0.10);
                setWidgetValue("temperature", 0.08);
                setWidgetValue("saturation", 1.05);
                setToggleState("enable_atmosphere", true);
                setWidgetValue("lift_blacks", 0.14);
                setWidgetValue("haze_strength", 0.30);
                setWidgetValue("haze_color_r", 0.25);
                setWidgetValue("haze_color_g", 0.23);
                setWidgetValue("haze_color_b", 0.26);
                setToggleState("enable_mist", true);
                setWidgetValue("mist_type", "White Diffusion / Fog");
                setWidgetValue("mist_intensity", 0.48);
                setWidgetValue("mist_radius", 52);
                setWidgetValue("mist_cutoff", 0.45);
                setToggleState("enable_flare", true);
                setWidgetValue("anamorphic_flare", 0.50);
                setToggleState("enable_lateral_ca", true);
                setWidgetValue("lateral_ca", 0.008);
                setToggleState("enable_shoulder", true);
                setWidgetValue("shoulder_start", 0.60);
                setWidgetValue("rolloff_softness", 1.20);
                setWidgetValue("highlight_desat", 0.35);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.26);
                setWidgetValue("grain_size", 1.6);
            }
        },
        {
            category: "🌸 Atmospheric, Dreamcore & Passthrough",
            name: "🌊 2000s Hollywood Teal & Orange",
            desc: "Kodak Vision3 500T + Blockbuster Complementary Separation + Warm Skin Tones + Deep Teal Shadows",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Kodak Vision3 500T");
                setWidgetValue("stock_mix", 0.95);
                setToggleState("enable_color_grade", true);
                setWidgetValue("contrast", 1.20);
                setWidgetValue("exposure", 0.02);
                setWidgetValue("temperature", -0.06);
                setWidgetValue("tint", 0.08);
                setWidgetValue("saturation", 1.18);
                setToggleState("enable_relighting", true);
                setToggleState("relight_use_depth", true);
                setWidgetValue("light_intensity", 0.55);
                setWidgetValue("light_x", 0.45);
                setWidgetValue("light_y", 0.35);
                setWidgetValue("light_z", 0.20);
                setWidgetValue("light_radius", 0.85);
                setWidgetValue("light_color_r", 1.30);
                setWidgetValue("light_color_g", 0.88);
                setWidgetValue("light_color_b", 0.55);
                setToggleState("enable_atmosphere", true);
                setToggleState("haze_use_depth", true);
                setWidgetValue("haze_strength", 0.30);
                setWidgetValue("lift_blacks", 0.05);
                setWidgetValue("haze_color_r", 0.06);
                setWidgetValue("haze_color_g", 0.16);
                setWidgetValue("haze_color_b", 0.22);
                setToggleState("enable_halation", true);
                setWidgetValue("halation_intensity", 0.35);
                setWidgetValue("halation_spread", 22);
                setWidgetValue("halation_amber_core", 0.70);
                setToggleState("enable_vignette", true);
                setWidgetValue("vignette_amount", 0.28);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.20);
                setWidgetValue("grain_size", 1.3);
            }
        },
        {
            category: "🌸 Atmospheric, Dreamcore & Passthrough",
            name: "☁️ Overcast London Moody",
            desc: "Kodak Portra 800 + Desaturated Slate-Gray & Olive Tones + Lifted Dynamic Blacks + Soft Light Wrap",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Kodak Portra 800");
                setWidgetValue("stock_mix", 0.80);
                setToggleState("enable_color_grade", true);
                setWidgetValue("contrast", 1.05);
                setWidgetValue("exposure", -0.05);
                setWidgetValue("temperature", -0.08);
                setWidgetValue("tint", 0.06);
                setWidgetValue("saturation", 0.75);
                setToggleState("enable_atmosphere", true);
                setToggleState("haze_use_depth", true);
                setToggleState("light_wrap_use_depth", true);
                setWidgetValue("haze_strength", 0.40);
                setWidgetValue("lift_blacks", 0.12);
                setWidgetValue("depth_offset", 0.04);
                setWidgetValue("haze_color_r", 0.16);
                setWidgetValue("haze_color_g", 0.18);
                setWidgetValue("haze_color_b", 0.20);
                setWidgetValue("light_wrap_strength", 0.38);
                setToggleState("enable_mist", true);
                setWidgetValue("mist_type", "Black Pro-Mist");
                setWidgetValue("mist_intensity", 0.20);
                setWidgetValue("mist_radius", 25);
                setWidgetValue("mist_cutoff", 0.60);
                setToggleState("enable_vignette", true);
                setWidgetValue("vignette_amount", 0.30);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.22);
                setWidgetValue("grain_size", 1.4);
            }
        },
        {
            category: "🌸 Atmospheric, Dreamcore & Passthrough",
            name: "🌙 Blue Hour Twilight",
            desc: "Fuji Superia 400 + Deep Cobalt Twilight Sky + Warm Interior Light Wrap + Gentle Mist + f/2.0 Bokeh",
            apply: () => {
                bypassAll();
                setToggleState("enable_film_stock", true);
                setWidgetValue("film_stock", "Fuji Superia 400");
                setWidgetValue("stock_mix", 0.85);
                setToggleState("enable_color_grade", true);
                setWidgetValue("contrast", 1.18);
                setWidgetValue("exposure", -0.10);
                setWidgetValue("temperature", -0.22);
                setWidgetValue("tint", 0.05);
                setWidgetValue("saturation", 1.08);
                setToggleState("enable_relighting", true);
                setToggleState("relight_use_depth", true);
                setWidgetValue("light_intensity", 0.70);
                setWidgetValue("light_x", 0.30);
                setWidgetValue("light_y", 0.45);
                setWidgetValue("light_z", 0.22);
                setWidgetValue("light_radius", 0.75);
                setWidgetValue("light_color_r", 1.40);
                setWidgetValue("light_color_g", 0.90);
                setWidgetValue("light_color_b", 0.40);
                setToggleState("enable_atmosphere", true);
                setToggleState("haze_use_depth", true);
                setToggleState("light_wrap_use_depth", true);
                setWidgetValue("haze_strength", 0.45);
                setWidgetValue("lift_blacks", 0.06);
                setWidgetValue("depth_offset", 0.06);
                setWidgetValue("haze_color_r", 0.08);
                setWidgetValue("haze_color_g", 0.12);
                setWidgetValue("haze_color_b", 0.30);
                setWidgetValue("light_wrap_strength", 0.40);
                setToggleState("enable_dof", true);
                setWidgetValue("f_stop", "f/2.0");
                setWidgetValue("dof_intensity", 0.30);
                setToggleState("enable_halation", true);
                setWidgetValue("halation_intensity", 0.30);
                setWidgetValue("halation_spread", 20);
                setWidgetValue("halation_amber_core", 0.60);
                setToggleState("enable_vignette", true);
                setWidgetValue("vignette_amount", 0.35);
                setToggleState("enable_grain", true);
                setWidgetValue("grain_amount", 0.24);
                setWidgetValue("grain_size", 1.4);
            }
        },
        {
            category: "🌸 Atmospheric, Dreamcore & Passthrough",
            name: "⚪ Ultra Clean Passthrough",
            desc: "Turn all processing modules OFF for pure unadjusted canvas reference",
            apply: () => {
                bypassAll();
            }
        }
    ];

    // Render grouped by category
    const categories = [
        "🎬 Iconic Cinema & Directorial Looks",
        "📸 Photochemical Film Stocks & Vintage",
        "💄 Portrait, Studio & High-End Editorial",
        "🎞️ Black & White Fine Art & Street",
        "🌸 Atmospheric, Dreamcore & Passthrough"
    ];

    categories.forEach(cat => {
        const catHeader = document.createElement("div");
        catHeader.className = "pl-preset-category";
        catHeader.textContent = cat;
        masterPresetCard.appendChild(catHeader);

        const grid = document.createElement("div");
        grid.className = "pl-presets-grid";

        const catPresets = MASTER_PRESETS.filter(p => p.category === cat);
        catPresets.forEach(mp => {
            const item = document.createElement("div");
            item.className = "pl-preset-card";
            item.innerHTML = `<div class="pl-preset-name">${mp.name}</div><div class="pl-preset-desc">${mp.desc}</div>`;
            item.addEventListener("click", () => {
                if (activePresetEl) activePresetEl.classList.remove("active-look");
                item.classList.add("active-look");
                activePresetEl = item;
                mp.apply();
            });
            grid.appendChild(item);
        });

        masterPresetCard.appendChild(grid);
    });

    pPresets.appendChild(masterPresetCard);

    // Full Node State Synchronizer
    node._syncPhotoLabDOM = function () {
        // Ensure any exploded height from saved workflow or LiteGraph widget accumulation is clamped
        if (node.size && (node.size[1] > 1050 || node.size[1] < 600)) {
            node.size[1] = 760;
            node.setSize?.([node.size[0] || 640, 760]);
        }

        // Ensure raw canvas widgets stay hidden
        if (node.widgets && Array.isArray(node.widgets)) {
            for (const w of node.widgets) {
                if (w && w.name !== "mrweaz_photolab_ui") {
                    hideWidget(w);
                }
            }
        }

        // 1. Sync all feature card switches from widgets and properties
        for (const name in cardControllers) {
            const w = getWidget(node, name);
            let val = false;
            if (w && w.value !== undefined && w.value !== null) {
                val = Boolean(w.value);
            } else if (node.properties?._pl_toggles?.[name] !== undefined) {
                val = Boolean(node.properties._pl_toggles[name]);
            }
            if (node.properties) {
                node.properties._pl_toggles = node.properties._pl_toggles || {};
                node.properties._pl_toggles[name] = val;
            }
            try {
                cardControllers[name].updateState(val);
            } catch (e) {}
        }

        // 2. Sync all sliders, selects, textareas, seeds from widgets
        for (const name in sliderSynchronizers) {
            const w = getWidget(node, name);
            if (w && w.value !== undefined && w.value !== null) {
                try {
                    sliderSynchronizers[name](w.value);
                } catch (e) {}
            }
        }

        // 3. Update status pill, tab dots, footer badges
        try {
            updateActiveState();
        } catch (e) {}
    };

    // Initial State Sync
    node._syncPhotoLabDOM();
}

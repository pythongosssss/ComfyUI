import { app } from "../../scripts/app.js";

const getInputs = (nodeData) => ({ ...nodeData.input?.required, ...nodeData.input?.optional });
const getAdvanced = (inputs) => Object.keys(inputs).filter((k) => inputs[k][1]?.advanced);
const getWidgets = (node) => {
	const advanced = node.constructor[ADVANCED];
	if (!advanced || !node.widgets?.length) return [];
	return advanced.map((a) => node.widgets.find((w) => w.name === a)).filter(Boolean);
};
const hideWidget = (widget) => {
	if (widget.type === "hidden") return;
	widget.originalType = widget.type;
	widget.type = "hidden";

	if (widget.computeSize) {
		widget.originalComputeSize = widget.computeSize;
	}
	widget.computeSize = () => [0, -4];
};
const showWidget = (widget) => {
	if (widget.type !== "hidden" || !widget.originalType) return;
	widget.type = widget.originalType;
	delete widget.originalType;
	if (widget.originalComputeSize) {
		widget.computeSize = widget.originalComputeSize;
		delete widget.originalComputeSize;
	} else {
		delete widget.computeSize;
	}
	delete widget.last_y;
};
const toggleWidget = (widget) => {
	if (widget.type === "hidden") {
		showWidget(widget);
	} else {
		hideWidget(widget);
	}
};
const ADVANCED = Symbol();

app.registerExtension({
	name: "Comfy.AdvancedWidgets",
	beforeRegisterNodeDef(nodeType, nodeData) {
		const inputs = getInputs(nodeData);
		const advanced = getAdvanced(inputs);
		if (advanced.length) {
			nodeType[ADVANCED] = advanced;
			const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
			nodeType.prototype.getExtraMenuOptions = function (_, options) {
				const index = options.findIndex((opt) => opt?.content === "Collapse");
				const widgets = getWidgets(this);
				if (widgets.length) {
					const hidden = widgets[0].type === "hidden";
					options.splice(index === -1 ? 0 : index + 1, 0, {
						content: (hidden ? "Show" : "Hide") + " Advanced Options",
						callback: () => {
							for (const widget of widgets) {
								toggleWidget(widget);
							}
							this.flags.showAdvanced = hidden;
							const sz = this.computeSize();
							const mode = hidden ? "max" : "min";
							this.setSize([Math[mode](sz[0], this.size[0]), Math[mode](sz[1], this.size[1])]);
							app.graph.setDirtyCanvas(true, true);
						},
					});
				}
				return getExtraMenuOptions.apply(this, arguments);
			};

			const onDrawTitleBox = nodeType.prototype.onDrawTitleBox;
			nodeType.prototype.onDrawTitleBox = function (ctx, height, size, scale) {
				onDrawTitleBox?.apply(this, arguments);

				if (this.flags.collapsed) {
					const stroke = ctx.strokeStyle;
					ctx.lineWidth = 2;
					ctx.strokeStyle = this.boxcolor || LiteGraph.NODE_DEFAULT_BOXCOLOR;
					ctx.strokeRect(12, -height + 12, 7, 7);
					ctx.strokeStyle = stroke;
				} else {
					ctx.beginPath();
					const fill = ctx.fillStyle;
					if (this.flags.showAdvanced) {
						ctx.rect(11, -height + 14, 10, 2);
					} else {
						ctx.rect(11, -height + 14, 10, 2);
						ctx.rect(15, -height + 10, 2, 10);
					}
					ctx.fillStyle = this.boxcolor || LiteGraph.NODE_DEFAULT_BOXCOLOR;
					ctx.fill();
					ctx.fillStyle = fill;
				}
			};

			const collapse = nodeType.prototype.collapse ?? LGraphNode.prototype.collapse;
			nodeType.prototype.collapse = function () {
				if (this.flags.collapsed) {
					// Show basic
					this.flags.showAdvanced = false;
					const widgets = getWidgets(this);
					for (const widget of widgets) {
						hideWidget(widget);
					}
					collapse.apply(this, arguments);
					const mode = "min";
					const sz = this.computeSize();
					this.setSize([Math[mode](sz[0], this.size[0]), Math[mode](sz[1], this.size[1])]);
				} else if (this.flags.showAdvanced) {
					collapse.apply(this, arguments);
				} else {
					this.flags.showAdvanced = this.trace;
					const widgets = getWidgets(this);
					for (const widget of widgets) {
						showWidget(widget);
					}
					const mode = "max";
					const sz = this.computeSize();
					this.setSize([Math[mode](sz[0], this.size[0]), Math[mode](sz[1], this.size[1])]);
				}
			};

			const configure = nodeType.prototype.configure ?? LGraphNode.prototype.configure;
			nodeType.prototype.configure = function (config) {
				if (config?.flags?.showAdvanced) {
					const widgets = getWidgets(this);
					for (const widget of widgets) {
						showWidget(widget);
					}
				}
				return configure?.apply(this, arguments);
			};
		}
	},
	nodeCreated(node) {
		const widgets = getWidgets(node);
		if (widgets.length) {
			let found = false;
			for (const widget of widgets) {
				found = true;
				hideWidget(widget);
			}
			if (found) {
				const sz = node.computeSize();
				node.setSize([Math.min(sz[0], node.size[0]), Math.min(sz[1], node.size[1])]);
				app.graph.setDirtyCanvas(true, true);
			}
		}
	},
});

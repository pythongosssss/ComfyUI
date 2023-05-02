import { ComfyWidgets, addValueControlWidget } from "/scripts/widgets.js";
import { app } from "/scripts/app.js";

const CONVERTED_TYPE = "converted-widget";
const VALID_TYPES = ["STRING", "combo", "number"];

export function isValidConnection(slot1, slot2) {
	// Only allow connections where the configs match
	const config1 = slot1.getWidget().config;
	const config2 = slot2.getWidget().config;

	if (config1[0] instanceof Array) {
		// These checks shouldnt actually be necessary as the types should match
		// but double checking doesn't hurt

		// New input isnt a combo
		if (!(config2[0] instanceof Array)) return false;
		// New imput combo has a different size
		if (config1[0].length !== config2[0].length) return false;
		// New input combo has different elements
		if (config1[0].find((v, i) => config2[0][i] !== v)) return false;
	} else if (config1[0] !== config2[0]) {
		// Configs dont match
		return false;
	}

	for (const k in config1[1]) {
		if (k !== "default") {
			if (config1[1][k] !== config2[1][k]) {
				return false;
			}
		}
	}

	return true;
}

function isConvertableWidget(widget, config) {
	return VALID_TYPES.includes(widget.type) || VALID_TYPES.includes(config[0]);
}

function hideWidget(node, widget, suffix = "") {
	if (widget.origType) return;
	widget.origType = widget.type;
	widget.origComputeSize = widget.computeSize;
	widget.origSerializeValue = widget.serializeValue;
	widget.computeSize = () => [0, -4]; // -4 is due to the gap litegraph adds between widgets automatically
	widget.type = CONVERTED_TYPE + suffix;
	widget.serializeValue = () => {
		// Prevent serializing the widget if we have no input linked
		const { link } = node.inputs.find((i) => i.getWidget?.()?.name === widget.name);
		if (link == null) {
			return undefined;
		}
		return widget.origSerializeValue ? widget.origSerializeValue() : widget.value;
	};

	// Hide any linked widgets, e.g. seed+seedControl
	if (widget.linkedWidgets) {
		for (const w of widget.linkedWidgets) {
			hideWidget(node, w, ":" + widget.name);
		}
	}
}

function showWidget(widget) {
	widget.type = widget.origType;
	widget.computeSize = widget.origComputeSize;
	widget.serializeValue = widget.origSerializeValue;

	delete widget.origType;
	delete widget.origComputeSize;
	delete widget.origSerializeValue;

	// Hide any linked widgets, e.g. seed+seedControl
	if (widget.linkedWidgets) {
		for (const w of widget.linkedWidgets) {
			showWidget(w);
		}
	}
}

function convertToInput(node, widget, config) {
	hideWidget(node, widget);

	const { linkType } = getWidgetType(config);

	// Add input and store widget config for creating on primitive node
	const sz = node.size;
	node.addInput(widget.name, linkType, {
		// Store this as a function so it isnt serialized
		getWidget: () => ({ name: widget.name, config }),
		convertedWidget: widget.name,
	});

	// Restore original size but grow if needed
	node.setSize([Math.max(sz[0], node.size[0]), Math.max(sz[1], node.size[1])]);
}

function convertToWidget(node, widget) {
	showWidget(widget);
	const sz = node.size;
	node.removeInput(node.inputs.findIndex((i) => i.getWidget?.()?.name === widget.name));

	// Restore original size but grow if needed
	node.setSize([Math.max(sz[0], node.size[0]), Math.max(sz[1], node.size[1])]);
}

function getWidgetType(config) {
	// Special handling for COMBO so we restrict links based on the entries
	let type = config[0];
	let linkType = type;
	if (type instanceof Array) {
		type = "COMBO";
		linkType = linkType.join(",");
	}
	return { type, linkType };
}

app.registerExtension({
	name: "Comfy.WidgetInputs",
	async beforeRegisterNodeDef(nodeType, nodeData, app) {
		// Add menu options to conver to/from widgets
		const origGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
		nodeType.prototype.getExtraMenuOptions = function (_, options) {
			const r = origGetExtraMenuOptions ? origGetExtraMenuOptions.apply(this, arguments) : undefined;

			if (this.widgets) {
				let toInput = [];
				let toWidget = [];
				for (const w of this.widgets) {
					if (w.type === CONVERTED_TYPE) {
						toWidget.push({
							content: `Convert ${w.name} to widget`,
							callback: () => convertToWidget(this, w),
						});
					} else {
						const config = nodeData?.input?.required[w.name] ||
							nodeData?.input?.optional?.[w.name] || [w.type, w.options || {}];
						if (isConvertableWidget(w, config)) {
							toInput.push({
								content: `Convert ${w.name} to input`,
								callback: () => convertToInput(this, w, config),
							});
						}
					}
				}
				if (toInput.length) {
					options.push(...toInput, null);
				}

				if (toWidget.length) {
					options.push(...toWidget, null);
				}
			}

			return r;
		};

		// On initial configure of nodes hide all converted widgets
		const onConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function () {
			const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
			const self = this;
			if (self.inputs) {
				for (const input of self.inputs) {
					if (input.widget) {
						// Migrate old widget data
						input.convertedWidget = input.widget.name;
						const w = input.widget;
						input.getWidget = () => input.widget;
						delete input.widget;
					}

					// Find any widget inputs and store a reference to the widget on the input
					if (input.convertedWidget) {
						const w = self.widgets.find((w) => w.name === input.convertedWidget);
						if (w) {
							const config = nodeData?.input?.required[w.name] ||
								nodeData?.input?.optional?.[w.name] || [w.type, w.options || {}];

							input.getWidget = () => ({ name: w.name, config });

							hideWidget(self, w);
						} else {
							convertToWidget(self, input);
						}
					}
				}
			}

			return r;
		};

		function isNodeAtPos(pos) {
			for (const n of app.graph._nodes) {
				if (n.pos[0] === pos[0] && n.pos[1] === pos[1]) {
					return true;
				}
			}
			return false;
		}

		// Double click a widget input to automatically attach a primitive
		const origOnInputDblClick = nodeType.prototype.onInputDblClick;
		const ignoreDblClick = Symbol();
		nodeType.prototype.onInputDblClick = function (slot) {
			const r = origOnInputDblClick ? origOnInputDblClick.apply(this, arguments) : undefined;

			const input = this.inputs[slot];
			if (!input.getWidget?.() || !input[ignoreDblClick]) {
				// Not a widget input or already handled input
				if (!(input.type in ComfyWidgets) && !(input.getWidget?.()?.config?.[0] instanceof Array)) {
					return r; //also Not a ComfyWidgets input or combo (do nothing)
				}
			}

			// Create a primitive node
			const node = LiteGraph.createNode("PrimitiveNode");
			app.graph.add(node);

			// Calculate a position that wont directly overlap another node
			const pos = [this.pos[0] - node.size[0] - 30, this.pos[1]];
			while (isNodeAtPos(pos)) {
				pos[1] += LiteGraph.NODE_TITLE_HEIGHT;
			}

			node.pos = pos;
			node.connect(0, this, slot);
			node.title = input.name;

			// Prevent adding duplicates due to triple clicking
			input[ignoreDblClick] = true;
			setTimeout(() => {
				delete input[ignoreDblClick];
			}, 300);

			return r;
		};
	},
	registerCustomNodes() {
		class PrimitiveNode {
			#widgetConfig;

			constructor() {
				this.addOutput("connect to widget input", "*");
				this.serialize_widgets = true;
				this.isVirtualNode = true;
			}

			onRerouteChanged(inputs, outputs) {
				if (!outputs.nodes.length) {
					// We have no reroute outputs
					let isLast = true;
					// Check if we have any non reroute connections
					for (const l of this.outputs[0].links || []) {
						const link = app.graph.links[l];
						const node = app.graph.getNodeById(link.target_id);
						if (node.type !== "Reroute") {
							isLast = false;
							break;
						}
					}
					if (isLast) {
						this.#onLastDisconnect();
					}
				} else {
					if (this.#widgetConfig) {
						// We already have a widget, validate all connections match
						for (const o of outputs.nodes) {
							const slot = o.to.inputs[o.link.target_slot];
							if (!isValidConnection(slot, this.outputs[0])) {
								o.to.disconnectInput(o.link.target_slot);
							}
						}
					} else {
						// Add first widget
						const o = outputs.nodes[0];
						const slot = o.to.inputs[o.link.target_slot];
						if (slot.getWidget) {
							this.#onFirstConnection(o.link.id);
						} else {
							o.to.disconnectInput(o.link.target_slot);
						}
					}
				}
			}

			applyToGraph() {
				if (!this.outputs[0].links?.length) return;

				// For each output link copy our value over the original widget value
				for (const l of this.outputs[0].links) {
					const linkInfo = app.graph.links[l];
					const outerNode = this.graph.getNodeById(linkInfo.target_id);
					let nodes = [{ to: outerNode, link: linkInfo }];
					if (outerNode.type === "Reroute") {
						nodes = outerNode.getRerouteOutputs().nodes;
					}
					for (const { to, link } of nodes) {
						const input = to.inputs[link.target_slot];
						const widgetName = input.getWidget?.()?.name;
						if (widgetName) {
							const widget = to.widgets.find((w) => w.name === widgetName);
							if (widget) {
								widget.value = this.widgets[0].value;
								if (widget.callback) {
									widget.callback(widget.value, app.canvas, to, app.canvas.graph_mouse, {});
								}
							}
						}
					}
				}
			}

			onConnectionsChange(_, index, connected) {
				if (connected) {
					if (this.outputs[0].links?.length) {
						if (!this.widgets?.length) {
							this.#onFirstConnection();
						}
						if (!this.widgets?.length && this.outputs[0].getWidget?.()) {
							// On first load it often cant recreate the widget as the other node doesnt exist yet
							// Manually recreate it from the output info
							this.#createWidget(this.outputs[0].getWidget?.().config);
						}
					}
				} else if (!this.outputs[0].links?.length) {
					this.#onLastDisconnect();
				}
			}

			onConnectOutput(slot, type, input, target_node, target_slot) {
				// Fires before the link is made allowing us to reject it if it isn't valid

				// Always allow reroutes
				if (target_node.type === "Reroute") return true;

				// No widget, we cant connect
				if (!input.getWidget?.()) {
					if (!(input.type in ComfyWidgets)) return false;
				}

				if (this.outputs[slot].links?.length) {
					return isValidConnection(this.outputs[slot], input);
				}
			}

			#onFirstConnection(linkId = null) {
				// First connection can fire before the graph is ready on initial load so random things can be missing
				if (linkId == null) {
					linkId = this.outputs[0].links[0];
				}
				const link = this.graph.links[linkId];
				if (!link) return;

				const theirNode = this.graph.getNodeById(link.target_id);
				if (!theirNode || !theirNode.inputs) return;

				const input = theirNode.inputs[link.target_slot];
				if (!input) return;

				var _widget;
				if (!input.getWidget?.()) {
					if (!(input.type in ComfyWidgets)) return;
					_widget = { name: input.name, config: [input.type, {}] }; //fake widget
				} else {
					_widget = input.getWidget?.();
				}

				const widget = _widget;
				const { type, linkType } = getWidgetType(widget.config);
				// Update our output to restrict to the widget type
				this.outputs[0].type = linkType;
				this.outputs[0].name = type;
				this.outputs[0].getWidget = () => widget;

				this.#createWidget(widget.config, theirNode, widget.name);
			}

			#createWidget(inputData, node, widgetName) {
				this.#widgetConfig = inputData;

				let type = inputData[0];

				if (type instanceof Array) {
					type = "COMBO";
				}

				let widget;
				if (type in ComfyWidgets) {
					widget = (ComfyWidgets[type](this, "value", inputData, app) || {}).widget;
				} else {
					widget = this.addWidget(type, "value", null, () => {}, {});
				}

				if (node?.widgets && widget) {
					const theirWidget = node.widgets.find((w) => w.name === widgetName);
					if (theirWidget) {
						widget.value = theirWidget.value;
					}
				}

				if (widget.type === "number") {
					addValueControlWidget(this, widget, "fixed");
				}

				// When our value changes, update other widgets to reflect our changes
				// e.g. so LoadImage shows correct image
				const callback = widget.callback;
				const self = this;
				widget.callback = function () {
					const r = callback ? callback.apply(this, arguments) : undefined;
					self.applyToGraph();
					return r;
				};

				// Grow our node if required
				const sz = this.computeSize();
				if (this.size[0] < sz[0]) {
					this.size[0] = sz[0];
				}
				if (this.size[1] < sz[1]) {
					this.size[1] = sz[1];
				}

				requestAnimationFrame(() => {
					if (this.onResize) {
						this.onResize(this.size);
					}
				});
			}

			#onLastDisconnect() {
				if (this.outputs[0].type === "*") return;

				// We cant remove + re-add the output here as if you drag a link over the same link
				// it removes, then re-adds, causing it to break
				this.outputs[0].type = "*";
				this.outputs[0].name = "connect to widget input";
				delete this.outputs[0].convertedWidget;
				delete this.outputs[0].getWidget;
				this.#widgetConfig = undefined;

				if (this.widgets) {
					// Allow widgets to cleanup
					for (const w of this.widgets) {
						if (w.onRemove) {
							w.onRemove();
						}
					}
					this.widgets.length = 0;
				}

				// If we still have nodes when disconnecting trigger updates to them
				// These will be reroutes that need their type updating
				if (this.outputs[0].links) {
					for (const l of this.outputs[0].links) {
						const link = app.graph.links[l];
						const node = app.graph.getNodeById(link.target_id);
						node.updateLinks?.();
					}
				}
			}
		}

		LiteGraph.registerNodeType(
			"PrimitiveNode",
			Object.assign(PrimitiveNode, {
				title: "Primitive",
			})
		);
		PrimitiveNode.category = "utils";
	},
});

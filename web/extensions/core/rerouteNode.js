import { app } from "/scripts/app.js";

// Node that allows you to redirect connections for cleaner graphs

app.registerExtension({
	name: "Comfy.RerouteNode",
	registerCustomNodes() {
		class RerouteNode extends LGraphNode {
			constructor() {
				super();

				if (!this.properties) {
					this.properties = {};
				}

				this.properties.showOutputText = RerouteNode.defaultVisibility;
				this.properties.horizontal = false;

				this.addInput("", "*");
				this.addOutput(this.properties.showOutputText ? "*" : "", "*");

				// This node is purely frontend and does not impact the resulting prompt so should not be serialized
				this.isVirtualNode = true;
			}

			getRerouteOutputs() {
				let reroutes = [];
				let nodes = [];

				function getOutputs(node) {
					if (!node.outputs[0].links) {
						return [];
					}

					// Find all reroute + actual outputs of this node
					for (const l of node.outputs[0].links) {
						const link = app.graph.links[l];
						if (!link) continue;

						const to = app.graph.getNodeById(link.target_id);
						if (to.type === "Reroute") {
							reroutes.push(to);
							getOutputs(to);
						} else {
							nodes.push({ to, from: node, link });
						}
					}
				}

				getOutputs(this);
				return { nodes, reroutes };
			}

			getRerouteInputs() {
				// Find all inputs to this node
				const reroutes = [];
				let node = this;
				while ((node = node.getInputNode(0))) {
					if (node === this) {
						// Circular loop found
						this.disconnectInput(0);
						return { reroutes: [] };
					}

					if (node.type !== "Reroute") {
						return { reroutes, node };
					}

					reroutes.push(node);
				}
				return { reroutes };
			}

			updateLinks() {
				const allInputs = this.getRerouteInputs();
				const allOutputs = (allInputs.reroutes[allInputs.reroutes.length - 1] || this).getRerouteOutputs();

				const updateType = (type, label) => {
					if (this.properties.showOutputText) {
						label = label || type;
					} else {
						label = "";
					}
					// Update all nodes in both directions from this node
					for (const reroute of [...allInputs.reroutes, this, ...allOutputs.reroutes]) {
						// Update the output type, never touch the input type
						reroute.outputs[0].type = reroute.outputs[0].name = type;

						const color = LGraphCanvas.link_type_colors[type];

						// Apply color to input slot as its actually a wilcard
						reroute.inputs[0].color_on = color;

						// Apply color to input
						if (reroute.inputs[0].link) {
							const link = app.graph.links[reroute.inputs[0].link];
							if (link) {
								link.color = color;
							}
						}

						// Ensure all outputs are valid, if not, disconnect them
						if (!reroute.outputs[0].links) continue;
						for (const l of reroute.outputs[0].links) {
							const link = app.graph.links[l];
							if (!link) continue;
							const to = app.graph.getNodeById(link.target_id);
							if (type !== "*" && to.type !== "Reroute") {
								if (to.inputs[link.target_slot].type !== type) {
									to.disconnectInput(link.target_slot);
								}
							}
						}
					}
				};

				let type;
				if (allInputs.node) {
					// We have a valid input so use that
					const prev = allInputs[allInputs.length - 2] || this;
					const link = app.graph.links[prev.inputs[0].link];
					if (link) {
						const output = allInputs.node.outputs[link.origin_slot];
						type = output.type;
						let label = type;
						const widget = output.getWidget?.();
						if (widget?.config?.[0] instanceof Array) {
							label = "COMBO";
						}
						if (type === "*") {
							type = null;
						} else {
							updateType(type, label);
						}
					}
				}

				if (!type) {
					if (allOutputs.nodes.length) {
						// There is a valid output so use that
						const next = allOutputs.nodes[0];
						const input = next.to.inputs[next.link.target_slot];
						let label = type;
						const widget = input.getWidget?.();
						if (widget?.config?.[0] instanceof Array) {
							label = "COMBO";
						}
						updateType(input.type, label);
					} else {
						// Nothing on either end so wildcard
						updateType("*");
					}
				}

				allInputs.node?.onRerouteChanged?.(allInputs, allOutputs);
			}

			onConnectionsChange(type, index, connected, link_info) {
				this.applyOrientation();

				if (this.configuring) {
					// Don't run anything while we are configuring
					// LiteGraph creates and connects nodes individually meaning the whole chain won't exist
					// So if we try validating at this point, random things disconnect
					return;
				}

				this.updateLinks();
			}

			configure() {
				// Prevent running validation when configuring this node
				this.configuring = true;
				super.configure.apply(this, arguments);
				this.configuring = false;

				// Instead run it when the whole graph is configured
				const self = this;
				const onConfigure = app.graph.onConfigure;
				app.graph.onConfigure = function () {
					onConfigure?.apply?.(this, arguments);
					self.updateLinks();
				};
			}

			clone() {
				const cloned = super.clone();
				cloned.removeOutput(0);
				cloned.addOutput(this.properties.showOutputText ? "*" : "", "*");
				cloned.size = cloned.computeSize();
				return cloned;
			}

			getExtraMenuOptions(_, options) {
				options.unshift(
					{
						content: (this.properties.showOutputText ? "Hide" : "Show") + " Type",
						callback: () => {
							this.properties.showOutputText = !this.properties.showOutputText;
							if (this.properties.showOutputText) {
								this.outputs[0].name = this.outputs[0].type;
							} else {
								this.outputs[0].name = "";
							}
							this.size = this.computeSize();
							this.applyOrientation();
							app.graph.setDirtyCanvas(true, true);
						},
					},
					{
						content: (RerouteNode.defaultVisibility ? "Hide" : "Show") + " Type By Default",
						callback: () => {
							RerouteNode.setDefaultTextVisibility(!RerouteNode.defaultVisibility);
						},
					},
					{
						// naming is inverted with respect to LiteGraphNode.horizontal
						// LiteGraphNode.horizontal == true means that
						// each slot in the inputs and outputs are layed out horizontally,
						// which is the opposite of the visual orientation of the inputs and outputs as a node
						content: "Set " + (this.properties.horizontal ? "Horizontal" : "Vertical"),
						callback: () => {
							this.properties.horizontal = !this.properties.horizontal;
							this.applyOrientation();
						},
					}
				);
			}

			applyOrientation() {
				this.horizontal = this.properties.horizontal;
				if (this.horizontal) {
					// we correct the input position, because LiteGraphNode.horizontal
					// doesn't account for title presence
					// which reroute nodes don't have
					this.inputs[0].pos = [this.size[0] / 2, 0];
				} else {
					delete this.inputs[0].pos;
				}
				app.graph.setDirtyCanvas(true, true);
			}

			computeSize() {
				const text = this.outputs?.[0]?.label || (this.properties.showOutputText && this.outputs?.[0]?.name) || "";
				return [Math.max(75, LiteGraph.NODE_TEXT_SIZE * text.length * 0.6 + 40), 26];
			}

			static setDefaultTextVisibility(visible) {
				RerouteNode.defaultVisibility = visible;
				if (visible) {
					localStorage["Comfy.RerouteNode.DefaultVisibility"] = "true";
				} else {
					delete localStorage["Comfy.RerouteNode.DefaultVisibility"];
				}
			}
		}

		// Load default visibility
		RerouteNode.setDefaultTextVisibility(!!localStorage["Comfy.RerouteNode.DefaultVisibility"]);

		LiteGraph.registerNodeType(
			"Reroute",
			Object.assign(RerouteNode, {
				title_mode: LiteGraph.NO_TITLE,
				title: "Reroute",
				collapsable: false,
			})
		);

		RerouteNode.category = "utils";
	},
});

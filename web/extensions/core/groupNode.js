import { app } from "/scripts/app.js";
import { ComfyWidgets } from "/scripts/widgets.js";

/**
 * @typedef { import("/types/litegraph").LGraphNode } LGraphNode
 * @typedef { import("/types/litegraph").LGraphGroup } LGraphGroup
 * @typedef { import("/types/litegraph").LLink } LLink
 * @typedef { import("/types/litegraph").SerializedLGraphNode } SerializedLGraphNode
 **/

app.registerExtension({
	name: "Comfy.GroupNode",
	init() {
		/**
		 *
		 * @param {LGraphGroup & {_nodes: LGraphNode[]}} groupNode
		 */
		function convertGroup(groupNode) {
			groupNode.recomputeInsideNodes();

			const nodes = [];
			const links = {};
			const external = {
				inputs: {},
				outputs: {},
			};

			// Store nodes inside the group and their internal links
			for (const node of groupNode._nodes) {
				const nodeData = node.serialize();
				if (node.inputs) {
					for (let i = 0; i < node.inputs.length; i++) {
						const input = node.inputs[i];
						if (input.link) {
							const link = app.graph.links[input.link];
							const isInner = groupNode._nodes.find((n) => n.id === link.origin_id);
							if (isInner) {
								links[input.link] = link;
							} else {
								// Store external link to be recreated when the node is recreated
								if (!external.inputs[link.target_id]) {
									external.inputs[link.target_id] = [];
								}
								external.inputs[link.target_id].push(link);

								// Clear the external link
								nodeData.inputs[i].link = null;
							}
						} else if (node.title === "Reroute") {
							const link = node.outputs[i].links?.[0];
							if (link) {
								const inputData = nodeData.inputs[i];
								inputData.type = app.graph.links[link].type;
								if (!inputData.name) {
									const output = nodeData.outputs[i];
									inputData.name = output.label || output.name || inputData.type;
								}
							}
						}
					}
				}

				if (node.outputs) {
					for (let i = 0; i < node.outputs.length; i++) {
						const output = node.outputs[i];
						if (output.links?.length) {
							for (let l = 0; l < output.links.length; l++) {
								const link = app.graph.links[output.links[l]];
								const isInner = groupNode._nodes.find((n) => n.id === link.target_id);
								if (!isInner) {
									// Store external link to be recreated when the node is recreated
									if (!external.outputs[node.id]) {
										external.outputs[node.id] = {};
									}
									external.outputs[node.id][i] = link;

									// Clear the external link
									nodeData.outputs[i].links.splice(l, 1);
									l--;
								}
							}
						}
					}
				}
				nodes.push(nodeData);
			}

			const group = groupNode.serialize();

			// Create our new super node using the serialized data
			const node = LiteGraph.createNode("GroupNode");
			graph.add(node);
			node.populate(structuredClone({ nodes, links, group }), external);
			node.pos = groupNode.pos;
			node.title = groupNode.title;

			// Remove all nodes and the group now, do this here as if you remove them earlier serialized info will be wrong
			for (const node of groupNode._nodes) {
				app.graph.remove(node);
			}
			app.graph.remove(groupNode);
		}

		const getGroupMenuOptions = LGraphCanvas.prototype.getGroupMenuOptions;
		LGraphCanvas.prototype.getGroupMenuOptions = function (group) {
			const opts = getGroupMenuOptions.apply(this, arguments);

			opts.unshift(
				{
					content: "Convert to Node",
					callback: () => convertGroup(group),
				},
				null
			);

			return opts;
		};
	},
	registerCustomNodes() {
		class GroupNode {
			constructor() {
				this.isVirtualNode = true;
				this.internalNodes = [];
			}

			getInnerNodes() {
				return this.internalNodes;
			}

			onConfigure() {
				debugger;
			}

			getInputNode(slot) {
				// Replace the inputs of the group with the inner nodes

				console.log(this.title, "getInputNode", slot);
				const output = this.outputs[slot];
				const node = this.internalNodes.find((n) => n.originalId === output.node.id);
				console.log("internal node", node);
				debugger;
				return node;
			}

			getInputLink(slot) {
				const input = this.outputs[slot];
				return {
					origin_id: this.getInputNode(slot).id,
					origin_slot: input.node.slot,
					target_id: this.id,
					target_slot: slot,
				};
			}

			/**
			 * Populates the group node with the internal nodes
			 * @this {GroupNode & LGraphNode }
			 * @param {{nodes: SerializedLGraphNode[], links: Record<number, LLink>, group: {}}}} param0
			 * @param {{inputs: Record<number, LLink>, outputs: Record<number, Record<number, LLink>>}} external
			 */
			populate({ nodes, links, group }, external) {
				this.flags.groupData = { nodes, links, group };

				const idMapping = {};
				for (const nodeData of nodes) {
					const node = LiteGraph.createNode(nodeData.type);

					// We need to generate a new unique id, but links are referenced using the old id so store that too
					const id = nodeData.id;
					nodeData.id = ++app.graph.last_node_id;
					node.configure(nodeData);
					node.originalId = id;
					this.internalNodes.push(node);
					idMapping[id] = node.id;

					let inputs = [];

					if (nodeData.inputs) {
						for (let i = 0; i < nodeData.inputs.length; i++) {
							const input = nodeData.inputs[i];
							if (input.link == null) {
								// We have no internal link so add as an external input to the node
								debugger;
								const slot = this.addInput(input.name, input.type, { node: { id: node.originalId, slot: i } });
								inputs.push(() => {
									console.log("returning slot link", slot, i);
									return slot.link;
									// return { origin_slot: i, origin_id: id, ...slot.link };
								});
							} else {
								inputs.push(() => {
									console.log("returning internal link", links[input.link]);

									// console.log(this, nodes, links, node, nodeData, input);
									const link = { ...links[input.link] };
									link.origin_id = idMapping[link.origin_id];
									link.target_id = idMapping[link.target_id];

									return link;
								});
							}
						}

						// Restore any external links
						if (id in external.inputs) {
							for (const link of external.inputs[id]) {
								app.graph.getNodeById(link.origin_id).connect(link.origin_slot, this, this.inputs.length - 1);
							}
						}
					}

					if (nodeData.outputs) {
						for (let i = 0; i < nodeData.outputs.length; i++) {
							const output = nodeData.outputs[i];
							if (!output.links?.length) {
								this.addOutput(output.name, output.type, { node: { id: node.originalId, slot: i } });

								// Restore any external links
								const link = external.outputs?.[id]?.[i];
								if (link) {
									this.connect(this.outputs.length - 1, app.graph.getNodeById(link.target_id), link.target_slot);
								}
							}
						}
					}

					// Override input methods to redirect them to our internal nodes
					node.getInputNode = (slot) => {
						try {
							console.log(node.title, "getInputNode", slot);

							if (!inputs[slot]) {
								debugger;
							}

							const l = inputs[slot]();
							if (typeof l === "number") {
								// This is a real node so find it on the graph
								const link = app.graph.links[l];
								return app.graph.getNodeById(link.origin_id);
							} else {
								// Internal node
								return this.internalNodes.find((n) => n.id === l.origin_id);
							}
						} catch (error) {
							debugger;
						}
					};

					node.getInputLink = (slot) => {
						console.log(node.title, "getInputLink", slot);

						const l = inputs[slot]();
						if (typeof l === "number") {
							const link = app.graph.links[l];
							return link;
						} else {
							return l;
						}
					};

					if (node.widgets) {
						for (const w of node.widgets) {
							const inputData = node.constructor.nodeData?.input?.required[w.name] ||
								nodeData?.input?.optional?.[w.name] || [w.type, w.options || {}];

							let type = inputData[0];
							if (type instanceof Array) {
								type = "COMBO";
							}

							let widget;
							if (type in ComfyWidgets) {
								widget = (ComfyWidgets[type](this, w.name, inputData, app) || {}).widget;
							} else {
								try {
									widget = this.addWidget(type, node.title + " " + w.name, null, () => {}, w.options);
								} catch (error) {
									console.error("Unable to generate widget", w.name, w, error);
									continue;
								}
							}
							widget.value = w.value;

							// When our value changes, update other widgets to reflect our changes
							const callback = widget.callback;
							widget.callback = function () {
								w.value = widget.value;
								return callback ? callback.apply(this, arguments) : undefined;
							};
						}
					}
				}
				this.setSize(this.computeSize());
			}
		}
		LiteGraph.registerNodeType(
			"GroupNode",
			Object.assign(GroupNode, {
				title: "GroupNode",
			})
		);

		GroupNode.category = "hidden";
	},
});

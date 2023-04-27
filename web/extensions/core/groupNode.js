import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { ComfyWidgets } from "/scripts/widgets.js";
import { hideWidget, showWidget } from "/extensions/core/widgetInputs.js";

/**
 * @typedef { import("/types/litegraph").LGraphNode } LGraphNode
 * @typedef { import("/types/litegraph").LGraphGroup & { _nodes: LGraphNode[] } } LGraphGroup
 * @typedef { import("/types/litegraph").LLink } LLink
 **/

class GroupNode {
	/** @type { LLink[] } */
	#externalLinks = [];
	/** @type { Record<number, number> } */
	#oldToNewId = {};
	/** @type { Record<number, number> } */
	#newToOldId = {};
	/** @type { Record<number, LGraphNode> } */
	#internalNodeLookup = {};
	/** @type { LGraphNode[] } */
	#internalNodes = [];
	/** @type { LGraphNode | null } */
	#runningNode = null;

	serialize_widgets = true;
	isVirtualNode = true;

	/**
	 * Creates a new GroupNode from the nodes within the group
	 * @param {LGraphGroup} group
	 */
	static from(group) {
		group.recomputeInsideNodes();

		// Validate before starting
		for (const child of group._nodes) {
			if (child.type === "GroupNode") {
				alert("You cannot convert a group with a nested group node!");
				return;
			}
		}

		const order = app.graph.computeExecutionOrder();
		const ordered = [...group._nodes].sort((a, b) => {
			console.log(a.title, order.indexOf(a), b.title, order.indexOf(b), order.indexOf(a) - order.indexOf(b));
			return order.indexOf(a) - order.indexOf(b);
		});

		/** @type {GroupNode & LGraphNode} */
		const node = LiteGraph.createNode("GroupNode");
		node.#internalNodes.push(...ordered);
		node.flags.internalLinks = {};
		node.flags.visibleWidgets = {};
		node.title = group.title;
		node.pos = group.pos;
		app.graph.add(node);

		for (const child of ordered) {
			node.#internalNodeLookup[child.id] = child;
			node.#oldToNewId[child.id] = child.id;
			node.#newToOldId[child.id] = child.id;
			node.#handleInputs(child);
			node.#addOutputs(child);
			child.originalId = child.id;
		}

		// Store the list of internal nodes for recreation on reload
		node.flags.internalNodes = ordered.map((n) => n.serialize());
		node.flags.group = group.serialize();

		// Setup widgets
		node.#ready();

		for (const node of ordered) {
			app.graph.remove(node);
		}
		app.graph.remove(group);

		// Restore any external links from this group
		node.#restoreLinks();

		return node;
	}

	constructor() {
		this.#handleExecuting = this.#handleExecuting.bind(this);
		this.#handleExecuted = this.#handleExecuted.bind(this);
	}

	#restoreLinks() {
		// Restore external links
		for (const link of this.#externalLinks) {
			const from = app.graph.getNodeById(link.origin_id);
			const to = app.graph.getNodeById(link.target_id);
			from.connect(link.origin_slot, to, link.target_slot);
		}
	}

	#ready() {
		for (const child of this.#internalNodes) {
			this.#internalNodeLookup[child.id] = child;
			this.#addWidgets(child);

			child.getInputNode = (slot) => {
				const link = child.getInputLink(slot);
				if (!link) {
					return null;
				}

				if (link.internal) {
					return this.#internalNodeLookup[link.origin_id];
				}

				return app.graph.getNodeById(link.origin_id);
			};

			child.getInputLink = (slot) => {
				slot = +slot;
				const oldId = this.#newToOldId[child.id];
				const internalLink = this.flags.internalLinks[oldId]?.[slot];
				if (internalLink) {
					return {
						...internalLink,
						origin_id: this.#oldToNewId[internalLink.origin_id],
						target_id: this.#oldToNewId[internalLink.target_id],
						internal: true,
					};
				}

				const inputIndex = this.inputs.findIndex((i) => i.for.id === oldId && i.for.slot === slot);
				const input = inputIndex !== -1 ? this.inputs[inputIndex] : null;
				if (input?.link) {
					// Redirect this link to the internal child
					const link = app.graph.links[input.link];
					return {
						...link,
						target_id: child.id,
						target_slot: slot,
					};
				}
				return null;
			};
		}

		api.addEventListener("executing", this.#handleExecuting);
		api.addEventListener("executed", this.#handleExecuted);
	}

	#addWidgets(node) {
		if (!node.widgets) return;
		for (const w of node.widgets) {
			const inputData = node.constructor.nodeData?.input?.required[w.name] ||
				node.constructor.nodeData?.input?.optional?.[w.name] || [w.origType || w.type, w.options || {}];

			// Show any internal widgets
			if (w.type === "converted-widget") {
				showWidget(w);
			}

			let type = inputData[0];
			if (type instanceof Array) {
				type = "COMBO";
			}

			let widget;
			const name = node.title + " " + w.name;
			if (type in ComfyWidgets) {
				widget = (ComfyWidgets[type](this, name, inputData, app) || {}).widget;
			} else {
				try {
					widget = this.addWidget(type, name, null, () => {}, w.options);
				} catch (error) {
					console.error("Unable to generate widget", name, w, error);
					continue;
				}
			}

			// When our value changes, update internal node widget to reflect our changes
			const callback = widget.callback;

			widget.callback = function () {
				w.value = widget.value;
				return callback ? callback.apply(this, arguments) : undefined;
			};
			widget.for = node;
			widget.shortName = w.name;

			widget.value = this.widgets_values?.[(this.widgets?.length || 1) - 1] || w.value;
			widget.callback(widget.value);

			const id = this.#newToOldId[node.id] + ":" + w.name;
			if (!this.flags.visibleWidgets[id]) {
				hideWidget(this, widget, undefined, false);
			}
		}
	}

	/**
	 * @this {GroupNode & LGraphNode }
	 * @param {LGraphNode} node
	 */
	#handleInputs(node) {
		if (!node.inputs) return;

		for (let i = 0; i < node.inputs.length; i++) {
			const input = node.inputs[i];
			let addInput = true;
			if (input.link) {
				// This input is connected to another node, if it is an internal link it doesnt need an input
				const link = app.graph.links[input.link];
				const isInternal = this.#internalNodes.find((n) => n.id === link.origin_id);

				if (isInternal) {
					// Store internal inputs for relinking when serializing the graph
					if (!this.flags.internalLinks[node.id]) {
						this.flags.internalLinks[node.id] = {};
					}
					this.flags.internalLinks[node.id][i] = { ...link };
					addInput = false;
				} else {
					// Remap this external input to our input
					this.#externalLinks.push({ ...link, target_id: this.id, target_slot: this.inputs?.length || 0 });
				}
			}

			if (addInput) {
				// Get connected type from reroute nodes
				let { name, type, widget } = input;
				if (node.type === "Reroute") {
					const output = node.outputs[i];
					const link = output.links?.[0];
					if (link) {
						type = app.graph.links[link].type;
						if (!name) {
							name = output.label || output.name || input.type;
						}
					}
				}

				this.addInput(name, type, {
					widget: widget ? { ...widget, name: node.title + " " + widget.name } : undefined,
					for: {
						id: node.id,
						slot: i,
					},
				});
			}
		}
	}

	#addOutputs(node) {
		if (!node.outputs) return;

		for (let i = 0; i < node.outputs.length; i++) {
			const output = node.outputs[i];
			let add = true;

			for (const l of output.links || []) {
				const link = app.graph.links[l];
				const isInternal = this.#internalNodes.find((n) => n.id === link.target_id);
				if (isInternal) {
					add = false;
				} else {
					this.#externalLinks.push({ ...link, origin_id: this.id, origin_slot: this.outputs?.length || 0 });
				}
			}

			if (add) {
				this.addOutput(output.name, output.type, {
					for: {
						id: node.id,
						slot: i,
					},
				});
			}
		}
	}

	#handleExecuting = ({ detail }) => {
		const node = this.#internalNodeLookup[detail + ""];
		if (node) {
			this.#runningNode = node;
			app.runningNodeId = this.id;
			app.graph.setDirtyCanvas(true, false);
		} else {
			this.#runningNode = null;
		}
	};

	#handleExecuted = ({ detail }) => {
		const node = this.#newToOldId[detail.node + ""];
		if (node) {
			if (!app.nodeOutputs[this.id]) {
				app.nodeOutputs[this.id] = detail.output;
			} else {
				Object.assign(app.nodeOutputs[this.id], detail.output);
			}
			node.onExecuted?.(detail.output);
			app.graph.setDirtyCanvas(true, false);
		}
	};

	onConfigure() {
		// On reload create an unmounted node to map our values
		for (const nodeData of this.flags.internalNodes) {
			const node = LiteGraph.createNode(nodeData.type);
			const id = nodeData.id;
			node.configure({ ...nodeData });
			node.id = ++app.graph.last_node_id;
			node.originalId = id;
			this.#oldToNewId[id] = node.id;
			this.#newToOldId[node.id] = id;
			this.#internalNodes.push(node);
		}

		const size = this.size;
		this.#ready();
		this.setSize(size);
	}

	getInnerNodes() {
		return this.#internalNodes;
	}

	getInputNode(slot) {
		// Replace the inputs of the group with the inner nodes
		const output = this.outputs[slot];
		const node = this.#internalNodeLookup[this.#oldToNewId[output.for.id]];
		return node;
	}

	getInputLink(slot) {
		const output = this.outputs[slot];
		return {
			origin_id: this.getInputNode(slot).id,
			origin_slot: output.for.slot,
			target_id: this.id,
			target_slot: slot,
		};
	}

	getTitle() {
		return `${LGraphNode.prototype.getTitle.call(this)} ${
			this.#runningNode ? `[${this.#runningNode.getTitle()}]` : ""
		}`;
	}

	explode() {
		// Recreate the group
		const groupData = this.flags.group;
		const group = new LiteGraph.LGraphGroup();
		app.graph.add(group);
		group.configure(groupData);

		// Calculate offset from new position vs stored position
		const xDiff = group.pos[0] - this.pos[0];
		const yDiff = group.pos[1] - this.pos[1];

		// Add and shift all internal nodes back inside the group
		for (const node of this.#internalNodes) {
			app.graph.add(node);
			node.pos[0] -= xDiff;
			node.pos[1] -= yDiff;
		}

		// Connect all external inputs to the group node
		for (const input of this.inputs || []) {
			if (input.link) {
				const link = app.graph.links[input.link];
				app.graph
					.getNodeById(link.origin_id)
					.connect(link.origin_slot, app.graph.getNodeById(this.#oldToNewId[input.for.id]), input.for.slot);
			}
		}

		// Connect all external outputs to the group node
		for (const output of this.outputs || []) {
			if (output.links?.length) {
				const newId = this.#oldToNewId[output.for.id];
				for (const l of output.links) {
					const link = app.graph.links[l];
					app.graph
						.getNodeById(newId)
						.connect(output.for.slot, app.graph.getNodeById(link.target_id), link.target_slot);
				}
			}
		}

		// Connect all internal links
		for (const oldId in this.flags.internalLinks) {
			const newId = this.#oldToNewId[oldId];
			const links = this.flags.internalLinks[oldId];
			for (const slot in links) {
				const link = links[slot];
				app.graph
					.getNodeById(this.#oldToNewId[link.origin_id])
					.connect(link.origin_slot, app.graph.getNodeById(newId), link.target_slot);
			}
		}

		group.pos = this.pos;
		app.graph.remove(this);
	}

	onRemoved() {
		api.removeEventListener("executing", this.#handleExecuting);
		api.removeEventListener("executed", this.#handleExecuted);
	}

	getExtraMenuOptions(_, options) {
		if (!this.widgets) return;

		const nodeOptions = {};
		const orderedOptions = [];
		for (const w of this.widgets) {
			let nodeMenu = nodeOptions[w.for.id];
			if (!nodeMenu) {
				nodeMenu = nodeOptions[w.for.id] = {
					title: "Widgets: " + w.for.title || w.for.type,
					has_submenu: true,
					submenu: { options: [] },
				};
				orderedOptions.push(nodeMenu);
			}

			const isHidden = w.type === "converted-widget";
			nodeMenu.submenu.options.push({
				title: (isHidden ? "Show " : "Hide ") + w.shortName,
				callback: () => {
					const id = this.#newToOldId[w.for.id] + ":" + w.shortName;
					if (isHidden) {
						showWidget(w);
						this.flags.visibleWidgets[id] = true;
					} else {
						hideWidget(this, w, undefined, false);
						delete this.flags.visibleWidgets[id];
					}
					app.graph.setDirtyCanvas(true);
					if (this.onResize) {
						this.onResize(this.size);
					}
				},
			});
		}

		options.push(...orderedOptions, null);

		options.push(
			{
				title: "Convert to Nodes",
				callback: () => {
					this.explode();
				},
			},
			null
		);
	}
}

app.registerExtension({
	name: "Comfy.GroupNode",
	init() {
		const getGroupMenuOptions = LGraphCanvas.prototype.getGroupMenuOptions;
		LGraphCanvas.prototype.getGroupMenuOptions = function (group) {
			const opts = getGroupMenuOptions.apply(this, arguments);

			opts.unshift(
				{
					content: "Convert to Node",
					callback: () => GroupNode.from(group),
				},
				null
			);

			return opts;
		};
	},
	registerCustomNodes() {
		LiteGraph.registerNodeType(
			"GroupNode",
			Object.assign(GroupNode, {
				title: "GroupNode",
			})
		);

		GroupNode.category = "hidden";
		app.addCustomNodeHandlers(GroupNode);
	},
});

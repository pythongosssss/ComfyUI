// @ts-check

import { ComfyButton } from "../components/button.js";
import { prop } from "../../utils.js";
import { $el } from "../../ui.js";
import { ComfyPopup } from "../components/popup.js";

export class ComfyWorkflowsMenu {
	element = $el("div.comfyui-workflows");

	get open() {
		return this.popup.open;
	}

	set open(open) {
		this.popup.open = open;
	}

	constructor() {
		const classList = {
			"comfyui-workflows-button": true,
			"comfyui-button": true,
			unsaved: true,
		};
		this.button = new ComfyButton({
			content: $el("div.comfyui-workflows-button-inner", [$el("i.mdi.mdi-graph"), $el("span.comfyui-workflows-label", "Unsaved workflow")]),
			icon: "chevron-down",
			classList,
		});

		this.element.append(this.button.element);

		this.popup = new ComfyPopup(
			{ target: this.element, classList: "comfyui-workflows-popup" },
			new ComfyWorkflowsPopup().element
		);
		this.popup.addEventListener("change", () => {
			this.button.icon = "chevron-" + (this.popup.open ? "up" : "down");
		});
		this.button.withPopup(this.popup);

		this.unsaved = prop(this, "unsaved", classList.unsaved, (v) => {
			classList.unsaved = v;
			this.button.classList = classList;
		});

		setTimeout(() => {
			this.popup.open = true;
		}, 500);
	}
}

export class ComfyWorkflowsPopup {
	element = $el("div.comfyui-workflows-panel");

	constructor() {
		this.element.append(new ComfyButton({ content: "New Workflow" }).element);
		this.element.append(new ComfyButton({ content: "Default Workflow" }).element);
	}
}
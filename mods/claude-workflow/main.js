import { View } from "gpui-kit";
import { props } from "herdr";
import { WorkflowButton } from "./button.js";
import { WorkflowViewer } from "./viewer.js";

export default class ClaudeWorkflow extends View {
  init(_props, cx) {
    this.part = props()?.role === "viewer" ? new WorkflowViewer() : new WorkflowButton();
    this.part.init(cx);
  }

  render(cx) {
    return this.part.render(cx);
  }

  async close() {
    this.part.close?.();
  }
}

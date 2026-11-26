import { View } from "gpui-kit";
import { props } from "herdr";
import { RoutineScheduler } from "./scheduler.js";
import { RoutinesScreen } from "./screen.js";

// One mod, two roles: the scheduler (an invisible floating block of the layout) and the screen
// it opens over the work column (props.role "screen").
export default class BenniRoutines extends View {
  init(_props, cx) {
    this.part = props()?.role === "screen" ? new RoutinesScreen() : new RoutineScheduler();
    this.part.init(cx);
  }

  render(cx) {
    return this.part.render(cx);
  }
}

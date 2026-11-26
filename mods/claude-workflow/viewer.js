import { div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, TextView } from "gpui-base";
import { props, focused, theme, settings, closeOverlay, watchFolder, checking } from "herdr";
import { readRuns, readSteps, readTranscript, transcriptFile, phasesWithSteps } from "./workflow-files.js";

const FALLBACK_REFRESH_MS = 5000;
const EVENTS_PER_PAGE = 200;
const PROMPT_PREVIEW_LINES = 3;
const OUTCOME_PREVIEW_LINES = 14;
const END_TOLERANCE_PX = 40;
const SPINNER = "mods/workspace-chrome/spinner.svg";
const CARD_SHARE_OF_PANE = "90%";
const VEIL_ON_DARK = "#000000a6";
const VEIL_ON_LIGHT = "#00000059";

function formatDuration(ms) {
  if (!(ms >= 0)) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function shortModel(model) {
  if (!model) return "";
  const named = /claude-(\w+)-(\d+)-(\d+)/.exec(model);
  if (!named) return model;
  return `${named[1][0].toUpperCase()}${named[1].slice(1)} ${named[2]}.${named[3]}`;
}

function linesOf(text) {
  return (text ?? "").replace(/\s+$/, "").split("\n");
}

function collapsedResultLabel(lines) {
  const count = lines.length === 1 && lines[0] === "" ? 0 : lines.length;
  return count === 0 ? "(aucune sortie)" : `${count} ligne${count > 1 ? "s" : ""} · déplier`;
}

function stateColor(t, state) {
  return state === "failed" ? t.ansi1 : state === "running" ? t.working : t.ansi2;
}

/** The step a viewer opens on: the newest running one, else the last one. */
function stepToFollow(steps) {
  return [...steps].reverse().find((s) => s.state === "running") ?? steps[steps.length - 1] ?? null;
}

function emptyTranscript() {
  return { offset: 0, events: [], results: new Map() };
}

export class WorkflowViewer {
  init(cx) {
    const { pid, runId } = props();
    this.pid = pid;
    this.runId = runId;
    this.run = null;
    this.steps = [];
    this.error = null;
    this.selectedAgentId = null;
    this.pickedByHand = false;
    this.transcripts = new Map();
    this.expanded = new Set();
    this.pagesShown = 1;
    this.scrollToEndPending = true;
    this.loading = false;
    this.closed = false;
    this.watch = null;
    this.transcriptScroll = ScrollHandle.new();
    this.focusHandle = cx.focus_handle();
    this.focusHandle.focus();
    if (checking()) return;
    cx.spawn(async (cx) => {
      await this.load(cx);
      this.followRunFolder(cx);
    });
    cx.timer.every(FALLBACK_REFRESH_MS, (cx) => this.load(cx));
  }

  close() {
    this.closed = true;
    this.watch?.cancel();
  }

  followRunFolder(cx) {
    if (!this.run) return;
    cx.spawn(async (cx) => {
      while (!this.closed) {
        this.watch = watchFolder(this.run.dir);
        try {
          await this.watch;
        } catch {
          return;
        }
        if (this.closed) return;
        await this.load(cx);
      }
    });
  }

  async load(cx) {
    if (this.loading || this.closed) return;
    this.loading = true;
    try {
      if (!this.run || this.run.running) {
        const { runs } = await readRuns(this.pid);
        this.run = runs.find((r) => r.runId === this.runId) ?? this.run;
      }
      if (!this.run) throw new Error("Workflow introuvable");
      this.steps = (await readSteps(this.run.dir)).steps;
      if (!this.pickedByHand) this.selectedAgentId = stepToFollow(this.steps)?.agentId ?? null;
      await this.readSelectedTranscript();
      this.error = null;
    } catch (error) {
      this.error = error.message;
    } finally {
      this.loading = false;
    }
    cx.notify();
  }

  async readSelectedTranscript() {
    const agentId = this.selectedAgentId;
    if (!agentId) return;
    const transcript = this.transcripts.get(agentId) ?? emptyTranscript();
    const wasAtEnd = this.isTranscriptAtEnd();
    const { offset, events } = await readTranscript(transcriptFile(this.run, agentId), transcript.offset);
    for (const event of events) {
      if (event.kind === "result") transcript.results.set(event.id, event);
      else transcript.events.push(event);
    }
    transcript.offset = offset;
    this.transcripts.set(agentId, transcript);
    if (events.length && wasAtEnd) this.scrollToEndPending = true;
  }

  isTranscriptAtEnd() {
    const offset = this.transcriptScroll.offset();
    const content = this.transcriptScroll.content_size();
    const viewport = this.transcriptScroll.viewport_size();
    return offset.y + viewport.height >= content.height - END_TOLERANCE_PX;
  }

  select(agentId, cx) {
    if (!agentId || agentId === this.selectedAgentId) return;
    this.selectedAgentId = agentId;
    this.pickedByHand = true;
    this.pagesShown = 1;
    this.scrollToEndPending = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.readSelectedTranscript();
      } catch (error) {
        this.error = error.message;
      }
      cx.notify();
    });
  }

  moveSelection(by, cx) {
    const ordered = phasesWithSteps(this.run, this.steps).flatMap((phase) => phase.steps);
    const index = ordered.findIndex((s) => s.agentId === this.selectedAgentId);
    const next = ordered[Math.min(ordered.length - 1, Math.max(0, index + by))];
    this.select(next?.agentId, cx);
  }

  toggle(key, cx) {
    if (this.expanded.has(key)) this.expanded.delete(key);
    else this.expanded.add(key);
    cx.notify();
  }

  onKey(event, cx) {
    if (event.key === "up" || event.key === "k") this.moveSelection(-1, cx);
    else if (event.key === "down" || event.key === "j") this.moveSelection(1, cx);
    else if (event.key === "escape") closeOverlay(props().overlay);
    else return;
    cx.stop_propagation();
  }

  closeWhenTabLeft() {
    const { tab, overlay } = props();
    const shownTab = focused()?.tab;
    if (tab && shownTab && shownTab !== tab && !this.closed) {
      this.close();
      closeOverlay(overlay);
    }
  }

  render(cx) {
    this.closeWhenTabLeft();
    const t = theme();
    return h_flex()
      .id("workflow-veil")
      .size_full()
      .items_center()
      .justify_center()
      .rounded(6)
      .bg(settings().dark === false ? VEIL_ON_LIGHT : VEIL_ON_DARK)
      .track_focus(this.focusHandle)
      .on_key_down((event, cx) => this.onKey(event, cx))
      .on_mouse_down("left", (_e, cx) => {
        cx.stop_propagation();
        this.close();
        closeOverlay(props().overlay);
      })
      .child(this.card(t, cx));
  }

  card(t, cx) {
    return v_flex()
      .id("workflow-card")
      .w(CARD_SHARE_OF_PANE)
      .h(CARD_SHARE_OF_PANE)
      .overflow_hidden()
      .rounded(10)
      .border(1)
      .border_color(t.input)
      .shadow_lg()
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(13)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(this.header(t))
      .child(this.run
        ? h_flex().id("wf-body").flex_1().min_h(0).items_start()
          .child(this.stepList(t, cx))
          .child(this.detail(t, cx))
        : div().flex_1().p(16).text_color(this.error ? t.ansi1 : t.dim).child(this.error ?? "Lecture du workflow…"))
      .child(h_flex().flex_none().px(16).h(26).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child("↑/↓ ou j/k : changer d'agent · clic sur un outil ou le prompt : déplier · Esc ou clic à côté : fermer"));
  }

  header(t) {
    const run = this.run;
    const finished = this.steps.filter((s) => s.state !== "running").length;
    const state = !run ? "" : run.running ? "En cours" : "Terminé";
    return h_flex().id("wf-header").flex_none().px(16).py(10).gap(12).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().text_size(14).font_semibold().text_color(t.accent).truncate().child(run?.name ?? "Workflow"))
        .child(div().text_size(12).text_color(t.dim).truncate().child(run?.description ?? "")))
      .when(Boolean(run), (el) => el.child(h_flex().flex_none().gap(6).items_center().text_size(12).text_color(t.muted)
        .when(run.running, (el) => el.child(svg(SPINNER).size(12).text_color(t.working).spin(900)))
        .child(`${state} · ${finished}/${this.steps.length} agents`)))
      .child(div().id("wf-close").flex_none().p(4).rounded(4).text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Fermer")
        .on_click(() => closeOverlay(props().overlay))
        .child(svg("mods/pane/close.svg").size(12)));
  }

  stepList(t, cx) {
    const phases = phasesWithSteps(this.run, this.steps);
    return v_flex().id("wf-steps").w(260).flex_none().h_full().overflow_y_scrollbar().border_r(1).border_color(t.border)
      .py(8).gap(2)
      .children(phases.map((phase, index) => this.phaseRows(t, phase, index, cx)));
  }

  phaseRows(t, phase, index, cx) {
    const done = phase.steps.filter((s) => s.state === "done").length;
    const failed = phase.steps.some((s) => s.state === "failed");
    const running = phase.steps.some((s) => s.state === "running");
    const complete = phase.steps.length > 0 && done === phase.steps.length;
    const mark = running ? svg(SPINNER).size(11).text_color(t.working).spin(900)
      : failed ? div().text_color(t.ansi1).child("✗")
      : complete ? div().text_color(t.ansi2).child("✔")
      : div().text_color(t.dim).child(String(index + 1));
    return v_flex()
      .child(h_flex().px(12).h(24).gap(8).items_center()
        .child(h_flex().w(12).flex_none().justify_center().child(mark))
        .child(div().flex_1().truncate().font_semibold().text_color(phase.steps.length ? t.foreground : t.dim).child(phase.title))
        .when(phase.steps.length > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(`${done}/${phase.steps.length}`))))
      .children(phase.steps.map((step) => this.stepRow(t, step, cx)));
  }

  stepRow(t, step, cx) {
    const selected = step.agentId === this.selectedAgentId;
    return h_flex().id(`wf-step-${step.agentId}`).mx(6).pl(26).pr(8).h(24).gap(8).items_center().rounded(5)
      .when(selected, (el) => el.bg(t.selected))
      .hover((s) => s.bg(selected ? t.selected : t.hover))
      .on_click((_e, cx) => this.select(step.agentId, cx))
      .child(h_flex().w(12).flex_none().justify_center().child(step.state === "running"
        ? svg(SPINNER).size(10).text_color(t.working).spin(900)
        : div().text_size(11).text_color(stateColor(t, step.state)).child(step.state === "failed" ? "✗" : "✔")))
      .child(div().flex_1().truncate().text_color(selected ? t.foreground : t.muted).child(step.label))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(shortModel(step.model)));
  }

  detail(t, cx) {
    const step = this.steps.find((s) => s.agentId === this.selectedAgentId);
    if (!step) return div().flex_1().p(16).text_color(t.dim).child("Aucun agent lancé pour l'instant.");
    const transcript = this.transcripts.get(step.agentId) ?? emptyTranscript();
    const toolCalls = transcript.events.filter((e) => e.kind === "tool").length;
    const times = transcript.events.map((e) => Date.parse(e.at)).filter((n) => n > 0);
    const duration = times.length ? formatDuration((step.state === "running" ? Date.now() : times[times.length - 1]) - times[0]) : "";
    const status = { running: "En cours", done: "Terminé", failed: "Échec" }[step.state];
    return v_flex().flex_1().min_w(0).h_full()
      .child(v_flex().flex_none().px(16).py(10).gap(2).border_b(1).border_color(t.border)
        .child(div().font_semibold().child(step.label))
        .child(h_flex().gap(6).text_size(12).text_color(t.dim)
          .child(div().text_color(stateColor(t, step.state)).child(`${step.state === "running" ? "●" : step.state === "failed" ? "✗" : "✔"} ${status}`))
          .child([shortModel(step.model), `${toolCalls} appels d'outils`, duration].filter(Boolean).map((part) => `· ${part}`).join(" "))))
      .child(this.transcriptView(t, step, transcript, cx));
  }

  transcriptView(t, step, transcript, cx) {
    const mono = settings().font_family ?? "JetBrains Mono";
    const events = transcript.events;
    const shownFrom = Math.max(0, events.length - EVENTS_PER_PAGE * this.pagesShown);
    const rows = [];
    if (shownFrom > 0) {
      rows.push(div().id("wf-older").py(4).text_size(12).text_color(t.accent).hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.pagesShown += 1; cx.notify(); })
        .child(`Afficher ${Math.min(shownFrom, EVENTS_PER_PAGE)} événements précédents (${shownFrom} masqués)`));
    }
    for (let index = shownFrom; index < events.length; index++) {
      rows.push(this.eventView(t, step, events[index], `${step.agentId}-${index}`, transcript.results, mono, cx));
    }
    if (step.state !== "running" && step.result != null) rows.push(this.outcomeView(t, step, mono, cx));
    if (step.state === "running") {
      rows.push(h_flex().gap(8).items_center().text_color(t.dim)
        .child(svg(SPINNER).size(12).text_color(t.working).spin(900)).child("En cours…"));
    }
    if (!events.length && step.state !== "running") rows.push(div().text_color(t.dim).child("Transcript vide."));
    if (this.scrollToEndPending) {
      this.scrollToEndPending = false;
      this.transcriptScroll.scroll_to_item(rows.length - 1);
    }
    return v_flex().id(`wf-transcript-${step.agentId}`).flex_1().min_h(0).w_full().overflow_y_scrollbar()
      .track_scroll(this.transcriptScroll).px(16).py(12).gap(10)
      .children(rows);
  }

  eventView(t, step, event, key, results, mono, cx) {
    switch (event.kind) {
      case "prompt": return this.promptView(t, event, key, mono, cx);
      case "text": return this.bulletRow(t, t.foreground, TextView.markdown(`wf-md-${key}`, event.text).selectable(true));
      case "user": return this.bulletRow(t, t.accent, div().text_color(t.muted).child(event.text), "❯");
      case "thinking": return this.thinkingView(t, event, key, cx);
      case "tool": return this.toolView(t, event, results.get(event.id), key, mono, step.state === "running", cx);
      default: return div();
    }
  }

  bulletRow(t, color, body, bullet = "⏺") {
    return h_flex().items_start().gap(8)
      .child(div().flex_none().w(12).text_color(color).child(bullet))
      .child(div().flex_1().min_w(0).child(body));
  }

  promptView(t, event, key, mono, cx) {
    const lines = linesOf(event.text);
    const open = this.expanded.has(key);
    const shown = open ? lines : lines.slice(0, PROMPT_PREVIEW_LINES);
    return v_flex().id(`wf-prompt-${key}`).p(10).gap(4).rounded(6).bg(t.surface).border(1).border_color(t.border)
      .on_click((_e, cx) => this.toggle(key, cx))
      .child(div().text_size(12).font_semibold().text_color(t.muted)
        .child(`Prompt · ${lines.length} lignes · ${open ? "replier" : "déplier"}`))
      .child(div().font_family(mono).text_size(12).text_color(t.muted).child(shown.join("\n")))
      .when(!open && lines.length > shown.length, (el) => el.child(div().text_size(12).text_color(t.dim).child(`… ${lines.length - shown.length} lignes de plus`)));
  }

  thinkingView(t, event, key, cx) {
    const open = this.expanded.has(key);
    return v_flex().id(`wf-think-${key}`).gap(4).on_click((_e, cx) => this.toggle(key, cx))
      .child(div().italic().text_color(t.dim).child(open ? "∴ Réflexion" : "∴ Réflexion… (déplier)"))
      .when(open, (el) => el.child(div().pl(20).italic().text_size(12).text_color(t.dim).child(event.text)));
  }

  toolView(t, tool, result, key, mono, stepRunning, cx) {
    const open = this.expanded.has(key);
    const waiting = !result && stepRunning;
    const bullet = waiting ? svg(SPINNER).size(11).text_color(t.working).spin(900)
      : div().text_color(result?.error ? t.ansi1 : t.ansi2).child("⏺");
    const lines = result ? linesOf(result.text) : [];
    return v_flex().id(`wf-tool-${key}`).gap(2).on_click((_e, cx) => this.toggle(key, cx))
      .child(h_flex().items_start().gap(8)
        .child(h_flex().flex_none().w(12).h(18).items_center().child(bullet))
        .child(div().flex_1().min_w(0).font_family(mono).text_size(12)
          .when(!open, (el) => el.truncate())
          .child(`${tool.name}(${tool.summary})`)))
      .when(Boolean(result), (el) => el.child(h_flex().items_start().gap(8).pl(4)
        .child(div().flex_none().w(16).text_color(t.dim).child("⎿"))
        .child(v_flex().flex_1().min_w(0).font_family(mono).text_size(12).text_color(result.error ? t.ansi1 : t.dim)
          .child(open ? lines.join("\n") || "(aucune sortie)" : collapsedResultLabel(lines)))));
  }

  outcomeView(t, step, mono, cx) {
    const key = `${step.agentId}-outcome`;
    const open = this.expanded.has(key);
    const lines = linesOf(typeof step.result === "string" ? step.result : JSON.stringify(step.result, null, 2));
    const shown = open ? lines : lines.slice(0, OUTCOME_PREVIEW_LINES);
    return v_flex().id(`wf-outcome-${key}`).p(10).gap(4).rounded(6).bg(t.surface).border(1).border_color(t.border)
      .on_click((_e, cx) => this.toggle(key, cx))
      .child(div().text_size(12).font_semibold().text_color(stateColor(t, step.state))
        .child(`Résultat · ${lines.length} lignes${lines.length > OUTCOME_PREVIEW_LINES ? ` · ${open ? "replier" : "déplier"}` : ""}`))
      .child(div().font_family(mono).text_size(12).text_color(t.muted).child(shown.join("\n")))
      .when(!open && lines.length > shown.length, (el) => el.child(div().text_size(12).text_color(t.dim).child(`… ${lines.length - shown.length} lignes de plus`)));
  }
}

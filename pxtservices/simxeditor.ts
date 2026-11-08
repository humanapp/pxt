/**
 * The editor-tab ("simxeditor") messages a simulator extension exchanges with
 * the editor. The editor serves them only to simulator extensions whose
 * registration declares an `editor` and sets `allowEditorTab`, or whose
 * simulator frame another registration's tab names in `simulator`.
 *
 * Such an extension has two frames, both created for its key: its simulator
 * frame, in the simulator column, and its tab frame, in the editor area. The
 * tab frame's URL carries the simulator frame's parameters (`parentOrigin`,
 * `channel`, `apiLevel`, `target`, `project`, `language`) and `role=editor`; the
 * simulator frame's URL carries `editor=1`. The tab frame is not a simulator
 * frame: it receives no simulator messages and its messages never reach the
 * simulator. The two frames talk over a `MessagePort` pair the editor
 * brokers, and the editor never reads that channel.
 *
 * An extension whose registration names another registration's simulator
 * frame in `simulator` has a tab frame and no simulator frame of its own: its
 * tab talks to that registration's simulator frame instead. A simulator frame
 * may so talk to several tabs, its own and those of every registration naming
 * it, each over a pair of its own.
 *
 * A tab lives for one load of its project: the editor removes the tab frame
 * when the project closes or reloads, and the ports and project-asset
 * subscriptions the tab held end with it. The editor posts no message before
 * removing the frame; to save state, listen for `pagehide` on the tab's window.
 *
 * This module has no dependencies; a simulator extension can import or copy it
 * as-is.
 */

/** The `type` of every simxeditor event, request and reply. */
export const SIMXEDITOR_MESSAGE_TYPE = "simxeditor";

/** The `type` of the message that carries a brokered port. */
export const SIMXEDITOR_PORT_MESSAGE_TYPE = "simxeditorport";

/** The value of the tab frame's `role` URL parameter. */
export const SIMXEDITOR_ROLE = "editor";

/**
 * Returns the origin of the editor hosting this simulator extension's frame,
 * e.g. `https://arcade.makecode.com`, which the editor passes in the frame
 * URL's `parentOrigin` parameter. Post the ready event and requests to it.
 * @param search the frame URL's query string; defaults to `window.location.search`
 * @returns the origin, or undefined if the URL provides none
 */
export function getParentOrigin(search?: string): string | undefined {
    const query = search !== undefined ? search : window.location.search;
    return new URLSearchParams(query).get("parentOrigin") || undefined;
}

/**
 * Returns true if the editor offers this simulator extension's tab to the open
 * project, which the editor tells its simulator frame with the `editor=1` URL
 * parameter: the registration declares and enables a tab, and the project
 * includes the extension. A true result does not guarantee an open request
 * succeeds: in a view that shows no extension tabs, it is answered with
 * `UNAVAILABLE`. The parameter reflects only the frame's own tab: a frame whose
 * tabs all belong to registrations naming it in `simulator` gets no `editor=1`,
 * and learns of those tabs through the tabs request, at API level 2 or above.
 * @param search the frame URL's query string; defaults to `window.location.search`
 */
export function hasEditorTab(search?: string): boolean {
    const query = search !== undefined ? search : window.location.search;
    return new URLSearchParams(query).get("editor") === "1";
}

/**
 * Returns the level of the simulator-extension APIs the editor hosting this
 * frame serves, which the editor passes in the frame URL's `apiLevel`
 * parameter. Level 1 is the `projfs`, `projassets`, `projprogram` and
 * `simxeditor` messages and the registration fields; each later level adds to
 * or alters them. Level 2 adds the `simulator` registration field, `peer` on
 * the `simxeditorport` message, `key` on the `simxeditor` open request, and
 * the `simxeditor` tabs request. Read it at startup to learn whether the
 * editor answers a request before sending it.
 * @param search the frame URL's query string; defaults to `window.location.search`
 * @returns the level; 0, the level of an editor older than level 1, if the URL
 * provides none or one that is not a non-negative integer
 */
export function getSimxApiLevel(search?: string): number {
    const query = search !== undefined ? search : window.location.search;
    const value = new URLSearchParams(query).get("apiLevel");
    return value !== null && /^[0-9]+$/.test(value) ? Number(value) : 0;
}

/** Posted by the tab frame to its parent once it listens for messages. */
export interface SimxEditorReadyEvent {
    type: typeof SIMXEDITOR_MESSAGE_TYPE;
    event: "ready";
}

/**
 * Posted to the tab frame when the tab is shown or hidden: on every switch
 * into or out of it, and once after the tab is ready. A hidden tab frame stays
 * loaded, but the browser may not render it or run its timers on time.
 */
export interface SimxEditorVisibilityEvent {
    type: typeof SIMXEDITOR_MESSAGE_TYPE;
    event: "shown" | "hidden";
}

/** A command the editor gives the simulator. */
export type SimxEditorSimulatorCommand = "start" | "stop" | "restart";

/**
 * Posted to the tab frame as the editor gives the simulator a command: `start`
 * on every run that reaches the simulator, `stop` when it stops the simulator,
 * and `restart` when it restarts the program already in the simulator.
 */
export interface SimxEditorSimulatorEvent {
    type: typeof SIMXEDITOR_MESSAGE_TYPE;
    event: "simulator";
    command: SimxEditorSimulatorCommand;
}

/** The states of the simulator, by the names of the simulator driver's `SimulatorState`. */
export type SimxEditorSimulatorState = "Unloaded" | "Stopped" | "Pending" | "Starting" | "Running" | "Paused" | "Suspended";

/** Posted to the tab frame when the simulator's state changes, and once after the tab is ready. */
export interface SimxEditorSimulatorStateEvent {
    type: typeof SIMXEDITOR_MESSAGE_TYPE;
    event: "simulatorstate";
    state: SimxEditorSimulatorState;
}

/**
 * Posted to the tab frame when the editor enters or leaves fullscreen-simulator
 * mode, in which the simulator covers the editor area and the tab, and once
 * after the tab is ready.
 */
export interface SimxEditorFullscreenEvent {
    type: typeof SIMXEDITOR_MESSAGE_TYPE;
    event: "fullscreen";
    /** True while the editor is in fullscreen-simulator mode. */
    enabled: boolean;
}

/**
 * Posted to the tab frame when the user asks, outside the tab, for an action
 * the tab carries out, which the editor also shows the tab for. `create` asks
 * the tab to create an instance of the fixed-instance type `qName`, one of
 * those its registration's `editor.creates` names, as when the user picks the
 * last entry of a block dropdown listing that type's instances. `open` asks
 * the tab to open the instance `qName` of such a type, which a file in the
 * extension's folder of the project declares, as when the user picks the
 * entry of such a dropdown asking to edit the instance it holds. Posted once the
 * tab is ready: at once if it is, else after the events that follow its ready
 * event. A request made before an earlier one was posted replaces it, and a
 * request not yet posted is dropped when the tab frame is removed.
 */
export interface SimxEditorActionEvent {
    type: typeof SIMXEDITOR_MESSAGE_TYPE;
    event: "action";
    action: "create" | "open";
    /**
     * For `create`, the fully qualified name of the type, e.g. `myext.Widget`;
     * for `open`, that of the instance, e.g. `myext.widget1`.
     */
    qName: string;
}

/** A message the editor posts to the tab frame. */
export type SimxEditorEvent =
    SimxEditorVisibilityEvent
    | SimxEditorSimulatorEvent
    | SimxEditorSimulatorStateEvent
    | SimxEditorFullscreenEvent
    | SimxEditorActionEvent;

/**
 * Posted to a tab frame and to the simulator frame it talks to (that of its
 * own key, or the one its registration's `simulator` names), each with one end
 * of a new `MessageChannel` in the event's `ports[0]`. The editor posts a new
 * pair whenever both frames exist and the tab is ready: when the tab becomes
 * ready while the simulator frame is loaded, and, for every ready tab that
 * talks to it, whenever a simulator frame finishes loading. A simulator frame
 * that several tabs talk to receives one pair per tab, told apart by `peer`. If
 * the simulator frame does not exist, the editor creates it each time it shows
 * one of its tabs and after the simulator unloads while one of its tabs exists,
 * and new pairs follow once it loads. Either side may close its port; a new
 * pair replaces it.
 */
export interface SimxEditorPortMessage {
    type: typeof SIMXEDITOR_PORT_MESSAGE_TYPE;
    /**
     * The receiving frame's own key, e.g. `owner/repo`: the tab's key to the tab
     * frame, the simulator frame's key to the simulator frame.
     */
    key: string;
    /**
     * The key of the frame at the other end of the port: the simulator frame's
     * key to the tab frame, the tab's key to the simulator frame. Equal to `key`
     * for a tab that talks to the simulator frame of its own key.
     */
    peer: string;
}

/**
 * Posted by a simulator frame to its parent to ask the editor to show one of
 * the tabs that talk to it. The editor shows it, creating the tab frame if
 * needed, and replies once, to the simulator frame, with the request's `id`.
 */
export interface SimxEditorOpenRequest {
    type: typeof SIMXEDITOR_MESSAGE_TYPE;
    subtype: "open";
    id: string;
    /**
     * The key of the tab to show, one of the tabs the tabs request lists; the
     * simulator frame's own key when absent.
     */
    key?: string;
}

/**
 * Posted by a simulator frame to its parent to ask the editor which tabs talk
 * to it. The editor replies once, to the simulator frame, with the request's
 * `id`.
 */
export interface SimxEditorTabsRequest {
    type: typeof SIMXEDITOR_MESSAGE_TYPE;
    subtype: "tabs";
    id: string;
}

/**
 * Why an open or tabs request failed. Clients branch on the code; the message
 * that accompanies it is for people.
 */
export type SimxEditorErrorCode =
    /** The requesting frame is not the simulator frame of an extension registered for, and included in, the open project. */
    "UNREGISTERED"
    /**
     * No registration declares and enables an editor tab that talks to the
     * requesting simulator frame, or the tab an open request names (the frame's
     * own when it names none) is not one of the tabs the tabs request lists.
     */
    | "PERMISSION_DENIED"
    /** The editor shows no extension tabs in its current view, such as an embedded, read-only or tutorial view. */
    | "UNAVAILABLE"
    /** The request is unknown or malformed, or the editor failed to carry it out. */
    | "INVALID_REQUEST";

/** The reply to an open request the editor carried out. */
export interface SimxEditorAckReply {
    type: typeof SIMXEDITOR_MESSAGE_TYPE;
    id: string;
    subtype: "ack";
}

/** A tab that a tabs reply lists. */
export interface SimxEditorTab {
    /** The key of the tab's extension, e.g. `owner/repo`; the `key` an open request names to show it. */
    key: string;
    /**
     * The tab's name as the editor toggle shows it, in the user's language: its
     * registration's `editor.label`, or its key when the label holds no name.
     */
    label: string;
    /**
     * The URL of the tab's SVG icon, when its registration's `editor.icon` is
     * a path; absent when the icon is MakeCode font-icon class names, or there
     * is none.
     */
    iconUrl?: string;
}

/** The reply to a tabs request. */
export interface SimxEditorTabsReply {
    type: typeof SIMXEDITOR_MESSAGE_TYPE;
    id: string;
    subtype: "tabs";
    /**
     * The tabs the editor offers the open project that talk to the requesting
     * simulator frame: the frame's own first, when its registration declares
     * one, then those of the registrations naming the frame in `simulator`, in
     * registration order; empty when the project includes none. The list is
     * the same in every view, so an open request for one of them may still be
     * answered with `UNAVAILABLE`.
     */
    tabs: SimxEditorTab[];
}

/** The reply to a request the editor refused. */
export interface SimxEditorErrorReply {
    type: typeof SIMXEDITOR_MESSAGE_TYPE;
    id: string | undefined;
    subtype: "error";
    code: SimxEditorErrorCode;
    message: string;
}

/** A reply the editor posts to the simulator frame. */
export type SimxEditorReply = SimxEditorAckReply | SimxEditorTabsReply | SimxEditorErrorReply;

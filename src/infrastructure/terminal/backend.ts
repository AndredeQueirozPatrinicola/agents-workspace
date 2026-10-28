/**
 * Terminal backend abstraction. tmux is the only implementation in the MVP;
 * the interface exists so alternatives (zellij, wezterm, a GUI) can be added
 * without touching the agent lifecycle code.
 */

export interface CreateSessionOptions {
  name: string;
  cwd: string;
  /** Command to run as the session's initial process (argv, executed directly). */
  command: string[];
  windowName?: string;
  /** Key/value tags stored on the session (used to identify aw sessions). */
  tags?: Record<string, string>;
}

export interface DashboardPane {
  title: string;
  /** Target session to display in this pane. */
  session: string;
}

export interface DashboardOptions {
  name: string;
  cwd: string;
  panes: DashboardPane[];
  perWindow: number;
  /** Optional command for a status window (argv). */
  statusCommand?: string[];
  /** Optional command for a free shell window (argv), e.g. to run git or aw commands. */
  shellCommand?: string[];
}

export interface PaneState {
  pid: number | null;
  dead: boolean;
  currentCommand: string;
}

export interface TerminalBackend {
  readonly id: string;
  isAvailable(): Promise<boolean>;
  version(): Promise<string | null>;
  /** Throw an actionable AwError when the backend cannot be used. */
  assertUsable(): Promise<void>;
  hasSession(name: string): Promise<boolean>;
  listSessions(): Promise<string[]>;
  createSession(options: CreateSessionOptions): Promise<void>;
  killSession(name: string): Promise<void>;
  sendKeys(name: string, keys: string[]): Promise<void>;
  /** Type literal text into the session's agent pane and press Enter. */
  sendText(name: string, text: string): Promise<void>;
  /** Replace the process in the session's agent pane (same session, same pane). */
  respawn(name: string, cwd: string, command: string[]): Promise<void>;
  paneState(name: string): Promise<PaneState | null>;
  /** Attach the current terminal (or switch the current client when already inside tmux). */
  attach(name: string): Promise<number>;
  createDashboard(options: DashboardOptions): Promise<void>;
  /** Capture the visible text of a session's active pane (for diagnostics). */
  capture(name: string, lines?: number): Promise<string>;
}

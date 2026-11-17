/**
 * The device panel's load, apart from the component so its SEQUENCING can be asserted without
 * rendering it.
 *
 * Devices and logins come from two services and are fetched together. The panel can start a second
 * load while a first is still in flight (it is reopened, or a removal reloads it), and the two may
 * answer in either order. Only the LATEST load may write the panel's state: a superseded one that
 * answered late - success or failure - writes nothing at all, or its `devices = []` could land beside
 * the latest one's `devicesKnown = true` and turn every healthy device's login into a row that wipes
 * its device. Each load carries a generation; the answer is applied only while it is still current.
 */

/** Both halves of one load, each settled on its own. */
export interface PanelLoadResult<D, S> {
  devices: PromiseSettledResult<D[]>;
  sessions: PromiseSettledResult<S[]>;
}

/** The panel state one applied load writes - every field, so nothing of an earlier load survives. */
export interface PanelLoadState<D, S> {
  devices: D[];
  /** True only when THIS load's device fetch answered; `buildPanelRows` derives nothing without it. */
  devicesKnown: boolean;
  sessions: S[];
  sessionsKnown: boolean;
}

/** The state an applied load writes: a failed half is empty AND unknown, never a stale list. */
export function panelStateFrom<D, S>(result: PanelLoadResult<D, S>): PanelLoadState<D, S> {
  const devicesOk = result.devices.status === 'fulfilled';
  const sessionsOk = result.sessions.status === 'fulfilled';
  return {
    devices: result.devices.status === 'fulfilled' ? result.devices.value : [],
    devicesKnown: devicesOk,
    sessions: result.sessions.status === 'fulfilled' ? result.sessions.value : [],
    sessionsKnown: sessionsOk,
  };
}

export interface DevicePanelLoaderDeps<D, S> {
  listDevices: () => Promise<D[]>;
  fetchSessions: () => Promise<S[]>;
  /** Writes one load's answer into the panel; called only for the latest load. */
  apply: (result: PanelLoadResult<D, S>) => void;
}

/** A loader whose `load()` applies its answer only while no later `load()` has started. */
export function createDevicePanelLoader<D, S>(deps: DevicePanelLoaderDeps<D, S>) {
  let generation = 0;
  return {
    /** Starts a load; resolves once it has applied its answer, or found itself superseded. */
    async load(): Promise<void> {
      const mine = ++generation;
      const [devices, sessions] = await Promise.allSettled([
        deps.listDevices(),
        deps.fetchSessions(),
      ]);
      if (mine !== generation) {
        console.log(
          `[DevicePanel] load ${mine} answered after load ${generation} started - superseded, nothing written`
        );
        return;
      }
      deps.apply({ devices, sessions });
    },
  };
}

/** What a removal has to tell the user: an empty string is "nothing to say". */
export interface RemovalMessages {
  failure: string;
  sessionFailure: string;
}

/**
 * Runs a removal, reloads the panel, and only THEN shows what the removal had to say: the reload
 * clears the panel's messages when it starts, so a failure set before it was wiped unread.
 */
export async function settleRemoval(steps: {
  remove: () => Promise<RemovalMessages>;
  reload: () => Promise<void>;
  show: (messages: RemovalMessages) => void;
}): Promise<void> {
  const messages = await steps.remove();
  await steps.reload();
  steps.show(messages);
}

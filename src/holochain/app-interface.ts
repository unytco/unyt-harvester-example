/**
 * The app interface `provision-wt` connects through. The conductor admin API
 * attaches app interfaces but cannot detach them, so each attach is permanent
 * until the conductor restarts. Reuse one instead of attaching per run.
 */

/** The origin the pipeline's websockets send, and its interfaces allow. */
export const PIPELINE_ORIGIN = "unyt-harvester-example";

/** The two admin calls this needs; `AdminWebsocket` satisfies it. */
export interface AppInterfaceAdmin {
  listAppInterfaces(): Promise<
    {
      port: number;
      allowed_origins: string;
      installed_app_id?: string | null;
    }[]
  >;
  attachAppInterface(request: {
    allowed_origins: string;
  }): Promise<{ port: number }>;
}

/**
 * The given port if there is one. Otherwise an interface the pipeline
 * attached earlier that serves `appId` or any app, and only when there is
 * none, a new one.
 */
export async function appInterfacePort(
  admin: AppInterfaceAdmin,
  appId: string,
  givenPort: number | undefined,
): Promise<number> {
  if (givenPort !== undefined) {
    return givenPort;
  }
  const reusable = (await admin.listAppInterfaces()).find(
    (appInterface) =>
      appInterface.allowed_origins === PIPELINE_ORIGIN &&
      (appInterface.installed_app_id == null ||
        appInterface.installed_app_id === appId),
  );
  if (reusable) {
    return reusable.port;
  }
  return (await admin.attachAppInterface({ allowed_origins: PIPELINE_ORIGIN }))
    .port;
}
